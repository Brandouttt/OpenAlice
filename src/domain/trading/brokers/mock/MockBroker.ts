/**
 * MockBroker — in-memory exchange implementing IBroker.
 *
 * Same level as CcxtBroker/AlpacaBroker — a full behavioral implementation,
 * not just vi.fn() stubs. Internally all-Decimal for precision guarantees.
 *
 * Market orders fill immediately. Limit orders go to pending (use
 * fillPendingOrder() to trigger fills in tests).
 */

import { z } from 'zod'
import Decimal from 'decimal.js'
import { Contract, ContractDescription, ContractDetails, Order, OrderState, UNSET_DECIMAL } from '@traderalice/ibkr'
import type {
  IBroker,
  AccountCapabilities,
  AccountInfo,
  Position,
  PlaceOrderResult,
  OpenOrder,
  Quote,
  MarketClock,
  TpSlParams,
} from '../types.js'
import '../../contract-ext.js'

// ==================== Internal types ====================

interface InternalPosition {
  contract: Contract
  side: 'long' | 'short'
  quantity: Decimal
  avgCost: Decimal
}

interface InternalOrder {
  id: string
  contract: Contract
  order: Order
  status: 'Submitted' | 'Filled' | 'Cancelled'
  fillPrice?: number
}

// ==================== Options ====================

export interface CallRecord {
  method: string
  args: unknown[]
  timestamp: number
}

export interface MockBrokerOptions {
  id?: string
  label?: string
  cash?: number
  accountInfo?: Partial<AccountInfo>
  /**
   * Per-share commission charged on every fill (BUY or SELL). Default 0.
   * Subject to `commissionMin` floor. IBKR Pro reference: $0.005/share.
   */
  commissionPerShare?: number
  /**
   * Minimum commission per fill, applied if qty × commissionPerShare
   * is less than this value. Default 0. IBKR Pro reference: $1.00.
   */
  commissionMin?: number
  /**
   * Slippage in basis points (1 bp = 0.01%). BUYs fill above the
   * quote, SELLs fill below. Default 0.
   */
  slippageBps?: number
  /**
   * When true, market orders go to pending instead of filling
   * immediately. Caller (e.g. BacktestEngine) drives fills via
   * `flushPendingMarketOrders()` after advancing the quote — this
   * is how next-bar-open fill is implemented without a look-ahead
   * gap. Default false (legacy immediate-fill behaviour).
   */
  deferMarketFills?: boolean
}

// ==================== Defaults ====================

export const DEFAULT_ACCOUNT_INFO: AccountInfo = {
  baseCurrency: 'USD',
  netLiquidation: '105000',
  totalCashValue: '100000',
  unrealizedPnL: '5000',
  realizedPnL: '1000',
  buyingPower: '200000',
}

export const DEFAULT_CAPABILITIES: AccountCapabilities = {
  supportedSecTypes: ['STK', 'CRYPTO'],
  supportedOrderTypes: ['MKT', 'LMT', 'STP', 'STP LMT'],
}

// ==================== Factory helpers ====================

export function makeContract(overrides: Partial<Contract> & { aliceId?: string } = {}): Contract {
  const c = new Contract()
  c.aliceId = overrides.aliceId ?? 'mock-paper|AAPL'
  c.symbol = overrides.symbol ?? 'AAPL'
  c.secType = overrides.secType ?? 'STK'
  c.exchange = overrides.exchange ?? 'MOCK'
  c.currency = overrides.currency ?? 'USD'
  return c
}

export function makePosition(overrides: Partial<Position> = {}): Position {
  const contract = overrides.contract ?? makeContract()
  return {
    contract,
    currency: contract.currency || 'USD',
    side: 'long',
    quantity: new Decimal(10),
    avgCost: '150',
    marketPrice: '160',
    marketValue: '1600',
    unrealizedPnL: '100',
    realizedPnL: '0',
    ...overrides,
  }
}

export function makeOpenOrder(overrides: Partial<OpenOrder> = {}): OpenOrder {
  const contract = overrides.contract ?? makeContract()
  const order = overrides.order ?? new Order()
  if (!overrides.order) {
    order.action = 'BUY'
    order.orderType = 'MKT'
    order.totalQuantity = new Decimal(10)
  }
  const orderState = overrides.orderState ?? new OrderState()
  if (!overrides.orderState) {
    orderState.status = 'Filled'
  }
  return { contract, order, orderState }
}

export function makePlaceOrderResult(overrides: Partial<PlaceOrderResult> = {}): PlaceOrderResult {
  return {
    success: true,
    orderId: 'order-1',
    ...overrides,
  }
}

// ==================== MockBroker ====================

export class MockBroker implements IBroker {
  // ---- Self-registration ----

  static configSchema = z.object({})
  static configFields: import('../types.js').BrokerConfigField[] = []

  static fromConfig(config: { id: string; label?: string; brokerConfig: Record<string, unknown> }): MockBroker {
    return new MockBroker({ id: config.id, label: config.label })
  }

  // ---- Instance ----

  readonly id: string
  readonly label: string

  private _positions = new Map<string, InternalPosition>()
  private _orders = new Map<string, InternalOrder>()
  private _quotes = new Map<string, number>()
  private _cash: Decimal
  private _realizedPnL = new Decimal(0)
  private _nextOrderId = 1
  private _accountOverride: AccountInfo | null = null
  private _callLog: CallRecord[] = []
  private _failRemaining = 0

  // Fill model — defaults preserve legacy behaviour (no friction, immediate fills).
  private readonly _commissionPerShare: Decimal
  private readonly _commissionMin: Decimal
  private readonly _slippageBps: Decimal
  private readonly _deferMarketFills: boolean
  private _totalCommissionsPaid = new Decimal(0)

  constructor(options: MockBrokerOptions = {}) {
    this.id = options.id ?? 'mock-paper'
    this.label = options.label ?? 'Mock Paper Account'
    this._cash = new Decimal(options.cash ?? 100_000)
    this._commissionPerShare = new Decimal(options.commissionPerShare ?? 0)
    this._commissionMin = new Decimal(options.commissionMin ?? 0)
    this._slippageBps = new Decimal(options.slippageBps ?? 0)
    this._deferMarketFills = options.deferMarketFills ?? false
    if (options.accountInfo) {
      this._accountOverride = {
        baseCurrency: 'USD', netLiquidation: '0', totalCashValue: '0', unrealizedPnL: '0', realizedPnL: '0',
        ...options.accountInfo,
      }
    }
  }

  /** Total commissions charged so far. Diagnostic. */
  get totalCommissionsPaid(): string {
    return this._totalCommissionsPaid.toString()
  }

  // ==================== Call tracking ====================

  private _record(method: string, args: unknown[]): void {
    this._callLog.push({ method, args, timestamp: Date.now() })
  }

  private _checkFail(method: string): void {
    if (this._failRemaining > 0) {
      this._failRemaining--
      throw new Error(`MockBroker[${this.id}]: simulated ${method} failure`)
    }
  }

  /** Get all calls, optionally filtered by method name. */
  calls(method?: string): CallRecord[] {
    return method ? this._callLog.filter(c => c.method === method) : [...this._callLog]
  }

  /** Count calls to a specific method. */
  callCount(method: string): number {
    return this._callLog.filter(c => c.method === method).length
  }

  /** Get the last call to a specific method, or null. */
  lastCall(method: string): CallRecord | null {
    const filtered = this._callLog.filter(c => c.method === method)
    return filtered.length > 0 ? filtered[filtered.length - 1] : null
  }

  /** Clear call log. */
  resetCalls(): void {
    this._callLog = []
  }

  // ---- Lifecycle ----

  async init(): Promise<void> { this._record('init', []); this._checkFail('init') }
  async close(): Promise<void> { this._record('close', []) }

  // ---- Contract search (stub) ----

  async searchContracts(_pattern: string): Promise<ContractDescription[]> {
    this._record('searchContracts', [_pattern])
    const desc = new ContractDescription()
    desc.contract = makeContract()
    return [desc]
  }

  async getContractDetails(_query: Contract): Promise<ContractDetails | null> {
    this._record('getContractDetails', [_query])
    const details = new ContractDetails()
    details.contract = makeContract()
    details.longName = 'Mock Contract'
    return details
  }

  // ---- Trading operations ----

  async placeOrder(contract: Contract, order: Order, tpsl?: TpSlParams): Promise<PlaceOrderResult> {
    this._record('placeOrder', [contract, order, tpsl])
    const orderId = `mock-ord-${this._nextOrderId++}`
    const isMarket = order.orderType === 'MKT'
    const side = order.action.toUpperCase()
    const qty = !order.totalQuantity.equals(UNSET_DECIMAL) ? order.totalQuantity : new Decimal(0)

    if (isMarket && !this._deferMarketFills) {
      const price = this._quotes.get(contract.symbol ?? '') ?? 100
      this._executeFill(contract, side, qty, new Decimal(price))

      const filledOrder = this._cloneOrder(order, orderId)
      this._orders.set(orderId, {
        id: orderId, contract, order: filledOrder,
        status: 'Filled', fillPrice: price,
      })

      const orderState = new OrderState()
      orderState.status = 'Filled'
      return { success: true, orderId, orderState }
    }

    // Either a limit/stop order, or a market order in deferred mode →
    // both go to pending. Deferred market orders are flushed by the
    // engine via flushPendingMarketOrders() after advancing the quote.
    const pendingOrder = this._cloneOrder(order, orderId)
    this._orders.set(orderId, {
      id: orderId, contract, order: pendingOrder, status: 'Submitted',
    })

    const orderState = new OrderState()
    orderState.status = 'Submitted'
    return { success: true, orderId, orderState }
  }

  async modifyOrder(orderId: string, changes: Partial<Order>): Promise<PlaceOrderResult> {
    this._record('modifyOrder', [orderId, changes])
    const internal = this._orders.get(orderId)
    if (!internal || internal.status !== 'Submitted') {
      return { success: false, error: `Order ${orderId} not found or not pending` }
    }

    if (changes.totalQuantity != null && !changes.totalQuantity.equals(UNSET_DECIMAL)) {
      internal.order.totalQuantity = changes.totalQuantity
    }
    if (changes.lmtPrice != null && !changes.lmtPrice.equals(UNSET_DECIMAL)) {
      internal.order.lmtPrice = changes.lmtPrice
    }
    if (changes.auxPrice != null && !changes.auxPrice.equals(UNSET_DECIMAL)) {
      internal.order.auxPrice = changes.auxPrice
    }
    if (changes.trailStopPrice != null && !changes.trailStopPrice.equals(UNSET_DECIMAL)) {
      internal.order.trailStopPrice = changes.trailStopPrice
    }
    if (changes.trailingPercent != null && !changes.trailingPercent.equals(UNSET_DECIMAL)) {
      internal.order.trailingPercent = changes.trailingPercent
    }
    if (changes.orderType) internal.order.orderType = changes.orderType
    if (changes.tif) internal.order.tif = changes.tif

    const orderState = new OrderState()
    orderState.status = 'Submitted'
    return { success: true, orderId, orderState }
  }

  async cancelOrder(orderId: string): Promise<PlaceOrderResult> {
    this._record('cancelOrder', [orderId])
    const internal = this._orders.get(orderId)
    if (!internal || internal.status !== 'Submitted') {
      return { success: false, error: `Order ${orderId} not found or not pending` }
    }
    internal.status = 'Cancelled'
    const orderState = new OrderState()
    orderState.status = 'Cancelled'
    return { success: true, orderId, orderState }
  }

  async closePosition(contract: Contract, quantity?: Decimal): Promise<PlaceOrderResult> {
    this._record('closePosition', [contract, quantity])
    const symbol = contract.aliceId ?? contract.symbol ?? 'unknown'
    const pos = this._positions.get(symbol)
    if (!pos) {
      return { success: false, error: `No open position for ${symbol}` }
    }

    const order = new Order()
    order.action = pos.side === 'long' ? 'SELL' : 'BUY'
    order.orderType = 'MKT'
    order.totalQuantity = quantity ?? pos.quantity

    return this.placeOrder(pos.contract, order)
  }

  // ---- Queries ----

  async getAccount(): Promise<AccountInfo> {
    this._record('getAccount', [])
    this._checkFail('getAccount')
    if (this._accountOverride) return this._accountOverride

    let unrealizedPnL = new Decimal(0)
    let marketValueAcc = new Decimal(0)
    for (const pos of this._positions.values()) {
      const price = this._quotes.has(pos.contract.symbol ?? '')
        ? new Decimal(this._quotes.get(pos.contract.symbol ?? '')!)
        : pos.avgCost
      const posValue = pos.quantity.mul(price)
      marketValueAcc = marketValueAcc.plus(posValue)
      unrealizedPnL = unrealizedPnL.plus(pos.quantity.mul(price.minus(pos.avgCost)))
    }

    return {
      baseCurrency: 'USD',
      netLiquidation: this._cash.plus(marketValueAcc).toString(),
      totalCashValue: this._cash.toString(),
      unrealizedPnL: unrealizedPnL.toString(),
      realizedPnL: this._realizedPnL.toString(),
    }
  }

  async getPositions(): Promise<Position[]> {
    this._record('getPositions', [])
    this._checkFail('getPositions')
    const result: Position[] = []
    for (const pos of this._positions.values()) {
      const price = this._quotes.has(pos.contract.symbol ?? '')
        ? new Decimal(this._quotes.get(pos.contract.symbol ?? '')!)
        : pos.avgCost
      result.push({
        contract: pos.contract,
        currency: pos.contract.currency || 'USD',
        side: pos.side,
        quantity: pos.quantity,
        avgCost: pos.avgCost.toString(),
        marketPrice: price.toString(),
        marketValue: pos.quantity.mul(price).toString(),
        unrealizedPnL: pos.quantity.mul(price.minus(pos.avgCost)).toString(),
        realizedPnL: '0',
      })
    }
    return result
  }

  async getOrders(orderIds: string[]): Promise<OpenOrder[]> {
    this._record('getOrders', [orderIds])
    const results: OpenOrder[] = []
    for (const id of orderIds) {
      const order = await this.getOrder(id)
      if (order) results.push(order)
    }
    return results
  }

  async getOrder(orderId: string): Promise<OpenOrder | null> {
    this._record('getOrder', [orderId])
    const internal = this._orders.get(orderId)
    if (!internal) return null
    const orderState = new OrderState()
    orderState.status = internal.status
    return { contract: internal.contract, order: internal.order, orderState }
  }

  async getQuote(contract: Contract): Promise<Quote> {
    this._record('getQuote', [contract])
    const price = this._quotes.get(contract.symbol ?? '') ?? 100
    return {
      contract,
      last: String(price),
      bid: String(price - 0.01),
      ask: String(price + 0.01),
      volume: '1000000',
      timestamp: new Date(),
    }
  }

  async getMarketClock(): Promise<MarketClock> {
    this._record('getMarketClock', [])
    return { isOpen: true }
  }

  getCapabilities(): AccountCapabilities {
    return DEFAULT_CAPABILITIES
  }

  // ==================== Contract identity ====================

  getNativeKey(contract: Contract): string {
    return contract.symbol
  }

  resolveNativeKey(nativeKey: string): Contract {
    const c = new Contract()
    c.symbol = nativeKey
    c.secType = 'STK'
    return c
  }

  // ==================== Test helpers ====================

  /** Inject a quote for a symbol. Used to control fill prices for market orders. */
  setQuote(symbol: string, price: number): void {
    this._quotes.set(symbol, price)
  }

  /** Manually fill a pending order at the given price. Used by tests. */
  fillPendingOrder(orderId: string, price: number): void {
    const internal = this._orders.get(orderId)
    if (!internal || internal.status !== 'Submitted') return
    const qty = internal.order.totalQuantity
    const side = internal.order.action.toUpperCase()
    this._executeFill(internal.contract, side, qty, new Decimal(price))
    internal.status = 'Filled'
    internal.fillPrice = price
  }

  /**
   * Fill all pending MARKET orders at each contract's current quote.
   * Used by the BacktestEngine after advancing the quote to the next
   * bar's open: orders the strategy placed on the previous bar's
   * close are realised here without look-ahead bias.
   *
   * Limit / stop orders are not touched — they wait for a real
   * cross or for `fillPendingOrder` to be called explicitly.
   *
   * Returns the number of orders filled.
   */
  flushPendingMarketOrders(): number {
    let filled = 0
    for (const internal of this._orders.values()) {
      if (internal.status !== 'Submitted') continue
      if (internal.order.orderType !== 'MKT') continue

      const symbol = internal.contract.symbol ?? ''
      const price = this._quotes.get(symbol) ?? 100
      const qty = internal.order.totalQuantity
      const side = internal.order.action.toUpperCase()

      this._executeFill(internal.contract, side, qty, new Decimal(price))
      internal.status = 'Filled'
      internal.fillPrice = price
      filled++
    }
    return filled
  }

  /** Override positions directly (for legacy test compatibility). */
  setPositions(positions: Position[]): void {
    this._positions.clear()
    for (const p of positions) {
      const key = p.contract.aliceId ?? p.contract.symbol ?? 'unknown'
      this._positions.set(key, {
        contract: p.contract,
        side: p.side,
        quantity: p.quantity,
        avgCost: new Decimal(p.avgCost),
      })
    }
  }

  /** Override orders directly (for legacy test compatibility). */
  setOrders(orders: OpenOrder[]): void {
    this._orders.clear()
    for (const o of orders) {
      const id = (o.order.orderId && o.order.orderId !== 0)
        ? String(o.order.orderId)
        : `injected-${this._nextOrderId++}`
      this._orders.set(id, {
        id,
        contract: o.contract,
        order: o.order,
        status: o.orderState.status as InternalOrder['status'],
      })
    }
  }

  /** Make the next N broker calls throw. Used to test health transitions. */
  setFailMode(count: number): void {
    this._failRemaining = count
  }

  /** Override account info directly. Bypasses computed values from positions. */
  setAccountInfo(info: Partial<AccountInfo>): void {
    const base: AccountInfo = {
      baseCurrency: 'USD', netLiquidation: '0', totalCashValue: '0', unrealizedPnL: '0', realizedPnL: '0',
      ...this._accountOverride,
    }
    Object.assign(base, info)
    if (!base.baseCurrency) base.baseCurrency = 'USD'
    this._accountOverride = base
  }

  // ==================== Internal ====================

  /**
   * Realise a fill end-to-end: apply slippage to the price, update
   * the position, deduct/add cash, charge commission. Single entry
   * point so that placeOrder (immediate fill), fillPendingOrder
   * (manual limit fill), and flushPendingMarketOrders (deferred
   * market fill) all behave identically.
   */
  private _executeFill(contract: Contract, side: string, qty: Decimal, marketPrice: Decimal): void {
    const slippageFactor = this._slippageBps.div(10_000)
    const effectivePrice = side === 'BUY'
      ? marketPrice.mul(new Decimal(1).plus(slippageFactor))
      : marketPrice.mul(new Decimal(1).minus(slippageFactor))

    this._applyFill(contract, side, qty, effectivePrice)

    const gross = qty.mul(effectivePrice)
    const commission = Decimal.max(qty.mul(this._commissionPerShare), this._commissionMin)
    this._totalCommissionsPaid = this._totalCommissionsPaid.plus(commission)

    if (side === 'BUY') {
      this._cash = this._cash.minus(gross).minus(commission)
    } else {
      this._cash = this._cash.plus(gross).minus(commission)
    }
  }

  private _applyFill(contract: Contract, side: string, qty: Decimal, price: Decimal): void {
    const key = contract.aliceId ?? contract.symbol ?? 'unknown'
    const existing = this._positions.get(key)

    if (!existing) {
      // New position
      this._positions.set(key, {
        contract,
        side: side === 'BUY' ? 'long' : 'short',
        quantity: qty,
        avgCost: price,
      })
      return
    }

    const isIncreasing =
      (existing.side === 'long' && side === 'BUY') ||
      (existing.side === 'short' && side === 'SELL')

    if (isIncreasing) {
      // Add to position, recalculate avg cost
      const totalCost = existing.avgCost.mul(existing.quantity).plus(price.mul(qty))
      existing.quantity = existing.quantity.plus(qty)
      existing.avgCost = totalCost.div(existing.quantity)
    } else {
      // Reduce/close position
      const remaining = existing.quantity.minus(qty)
      if (remaining.lte(0)) {
        // Fully closed (or flipped — for simplicity we just delete)
        this._positions.delete(key)
      } else {
        existing.quantity = remaining
        // avgCost stays the same on partial close
      }
    }
  }

  private _cloneOrder(order: Order, orderId: string): Order {
    const o = new Order()
    o.action = order.action
    o.orderType = order.orderType
    o.totalQuantity = order.totalQuantity
    o.tif = order.tif
    if (!order.lmtPrice.equals(UNSET_DECIMAL)) o.lmtPrice = order.lmtPrice
    if (!order.auxPrice.equals(UNSET_DECIMAL)) o.auxPrice = order.auxPrice
    o.orderId = parseInt(orderId.replace('mock-ord-', ''), 10) || 0
    return o
  }
}
