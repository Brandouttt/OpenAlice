/**
 * GitTrackedBroker — wraps a real IBroker so strategy-issued orders
 * flow through TradingGit (stage → commit → push) instead of hitting
 * the underlying broker directly.
 *
 * Why: when the strategy worker is running auto-trading, we want
 * every order to:
 *   1. Be recorded as a TradingGit commit (audit trail, replayable)
 *   2. Respect a "tier policy" — small orders auto-push (no human
 *      friction), medium orders pause for HITL approval, large /
 *      risky orders are hard-stopped pre-commit.
 *   3. Surface in PushApprovalPanel (Web UI) and the Telegram
 *      trading panel naturally — both read TradingGit pending state.
 *
 * Backtest path is NOT affected — BacktestEngine wires MockBroker
 * directly to the strategy without going through this wrapper.
 *
 * Read methods (getAccount, getPositions, etc.) delegate to the
 * underlying broker unchanged. Only placeOrder / modifyOrder /
 * closePosition / cancelOrder are intercepted.
 */

import type Decimal from 'decimal.js'
import type { Contract, Order, OrderCancel, OrderState, ContractDescription, ContractDetails } from '@traderalice/ibkr'
import type {
  IBroker,
  TpSlParams,
  PlaceOrderResult,
  AccountInfo,
  Position,
  OpenOrder,
  Quote,
  MarketClock,
  AccountCapabilities,
} from '../trading/brokers/types.js'
import { OrderState as OrderStateClass } from '@traderalice/ibkr'
import type { UnifiedTradingAccount } from '../trading/UnifiedTradingAccount.js'
import type { TierPolicy } from './tier-policy.js'

export interface GitTrackedBrokerOptions {
  /** UTA whose TradingGit will own the staged commits. */
  uta: UnifiedTradingAccount
  /** Underlying broker — all read methods delegate here. */
  inner: IBroker
  /** Tier classifier that decides auto-push / hitl / hard-stop. */
  tierPolicy: TierPolicy
  /**
   * Commit message tag prefix — appears in TradingGit log so a human
   * can tell automated entries from manually-typed ones. Default
   * 'auto'. Strategy name is appended automatically.
   */
  commitTag?: string
  /**
   * Strategy name — included in the commit message so the trader can
   * see which strategy fired the trade.
   */
  strategyName?: string
}

export class GitTrackedBroker implements IBroker {
  readonly id: string
  readonly label: string
  readonly meta?: unknown

  private readonly inner: IBroker
  private readonly uta: UnifiedTradingAccount
  private readonly tierPolicy: TierPolicy
  private readonly commitTag: string
  private readonly strategyName?: string

  constructor(options: GitTrackedBrokerOptions) {
    this.inner = options.inner
    this.uta = options.uta
    this.tierPolicy = options.tierPolicy
    this.commitTag = options.commitTag ?? 'auto'
    this.strategyName = options.strategyName

    this.id = options.inner.id
    this.label = options.inner.label
    this.meta = options.inner.meta
  }

  // ==================== Lifecycle (delegate) ====================

  init(): Promise<void> { return this.inner.init() }
  close(): Promise<void> { return this.inner.close() }

  // ==================== Contract search (delegate) ====================

  searchContracts(pattern: string): Promise<ContractDescription[]> {
    return this.inner.searchContracts(pattern)
  }
  getContractDetails(query: Contract): Promise<ContractDetails | null> {
    return this.inner.getContractDetails(query)
  }
  refreshCatalog?(): Promise<void> {
    return this.inner.refreshCatalog?.() ?? Promise.resolve()
  }

  // ==================== Reads (delegate) ====================

  getAccount(): Promise<AccountInfo> { return this.inner.getAccount() }
  getPositions(): Promise<Position[]> { return this.inner.getPositions() }
  getOrders(orderIds: string[]): Promise<OpenOrder[]> { return this.inner.getOrders(orderIds) }
  getOrder(orderId: string): Promise<OpenOrder | null> { return this.inner.getOrder(orderId) }
  getQuote(contract: Contract): Promise<Quote> { return this.inner.getQuote(contract) }
  getMarketClock(): Promise<MarketClock> { return this.inner.getMarketClock() }
  getCapabilities(): AccountCapabilities { return this.inner.getCapabilities() }

  // ==================== Writes (intercepted) ====================

  async placeOrder(
    contract: Contract,
    order: Order,
    tpsl?: TpSlParams,
  ): Promise<PlaceOrderResult> {
    // Tier classify
    const account = await this.inner.getAccount()
    const tier = this.tierPolicy.classify({
      contract,
      order,
      balance: account.netLiquidation,
    })

    if (tier.decision === 'hard-stop') {
      return {
        success: false,
        error: `Hard-stop: ${tier.reason}`,
      }
    }

    // Pending-commit collision check. TradingGit holds at most one
    // pending commit at a time. If a previous order (HITL tier) is
    // still waiting for approval, this entry's commit would throw.
    // Return failure gracefully so the strategy can retry next tick
    // — same pattern as the Phase 3.3 fix for placeOrder responses.
    const status = this.uta.status()
    if (status.pendingMessage) {
      return {
        success: false,
        error:
          `Cannot stage new order: account "${this.uta.id}" already ` +
          `has a pending commit (${status.pendingHash ?? '?'}) awaiting ` +
          `approval. Approve or reject the pending one first.`,
      }
    }

    // Stage + commit
    this.uta.git.add({ action: 'placeOrder', contract, order, tpsl })
    const message = this.formatCommitMessage(order, contract)
    this.uta.git.commit(message)

    if (tier.decision === 'auto-push') {
      // Push immediately. Returns broker fill result of the first
      // operation in the commit (this placeOrder).
      const pushResult = await this.uta.push()
      const opResult = pushResult.submitted[0] ?? pushResult.rejected[0]
      if (!opResult) {
        return { success: false, error: 'push completed with no result' }
      }
      const orderState = new OrderStateClass()
      orderState.status = opResult.status
      return {
        success: opResult.success,
        orderId: opResult.orderId,
        orderState,
        error: opResult.error,
      }
    }

    // tier.decision === 'hitl' — leave pending for human approval
    const orderState = new OrderStateClass()
    orderState.status = 'PendingSubmit'
    return {
      success: true,
      orderId: undefined,
      orderState,
      error: `Awaiting human approval (Tier 2: ${tier.reason})`,
    }
  }

  async modifyOrder(orderId: string, changes: Partial<Order>): Promise<PlaceOrderResult> {
    // Modify isn't routed through git in v1 — most strategies don't
    // modify orders, and the audit value is lower (modify already
    // references an existing order). Delegate straight to broker.
    return this.inner.modifyOrder(orderId, changes)
  }

  async cancelOrder(orderId: string, orderCancel?: OrderCancel): Promise<PlaceOrderResult> {
    // Same reasoning as modify — delegate.
    return this.inner.cancelOrder(orderId, orderCancel)
  }

  async closePosition(contract: Contract, quantity?: Decimal): Promise<PlaceOrderResult> {
    // Close DOES go through git — it's a position-changing event
    // worth auditing. But skip the tier check: stop-loss exits MUST
    // not be blocked by HITL.
    this.uta.git.add({ action: 'closePosition', contract, quantity })
    const sym = contract.symbol ?? '?'
    const qtyStr = quantity ? ` ${quantity.toFixed()}` : ''
    this.uta.git.commit(`${this.commitTag} close ${sym}${qtyStr}${this.tagSuffix()}`)
    const pushResult = await this.uta.push()
    const opResult = pushResult.submitted[0] ?? pushResult.rejected[0]
    if (!opResult) {
      return { success: false, error: 'close push completed with no result' }
    }
    const orderState = new OrderStateClass()
    orderState.status = opResult.status
    return {
      success: opResult.success,
      orderId: opResult.orderId,
      orderState,
      error: opResult.error,
    }
  }

  // ==================== Helpers ====================

  private formatCommitMessage(order: Order, contract: Contract): string {
    const action = order.action ?? '?'
    const sym = contract.symbol ?? '?'
    const qty = order.totalQuantity
    const qtyStr = qty ? ` ${qty.toFixed()}` : ''
    return `${this.commitTag} ${action} ${sym}${qtyStr}${this.tagSuffix()}`
  }

  private tagSuffix(): string {
    return this.strategyName ? ` [${this.strategyName}]` : ''
  }
}
