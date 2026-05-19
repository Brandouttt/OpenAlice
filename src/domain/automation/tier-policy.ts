/**
 * TierPolicy — i.e. "classify an order into a risk tier, then decide
 * whether it auto-fills, needs human approval, or is rejected outright."
 *
 * For a $4000 swing account the practical guideline is:
 *   Tier 1: under $300 OR ETF → auto-push (just do it)
 *   Tier 2: $300–$1000 single-stock entry → require human via PushApprovalPanel
 *           or Telegram inline keyboard before push
 *   Tier 3 (or guard-triggered) → hard stop, manual reset only
 *
 * Classification is intentionally simple — total notional ($ value of
 * shares × price). VaR / multi-position correlation tiers come later.
 *
 * The wrapper broker reads this classification and routes the order
 * through one of three paths:
 *   auto-push → TradingGit.add + commit + push, returns fill result
 *   hitl     → TradingGit.add + commit, returns pending acknowledgement
 *   hard-stop → return failure immediately, NO commit
 */

import Decimal from 'decimal.js'
import type { Contract, Order } from '@traderalice/ibkr'
import { UNSET_DECIMAL } from '@traderalice/ibkr'

export type TierDecision = 'auto-push' | 'hitl' | 'hard-stop'

export interface TierClassifyInput {
  contract: Contract
  order: Order
  /** Best-known price (limit / mark) for notional computation. */
  priceHint?: string
  /** Account net liquidation in USD (or base currency). */
  balance: string
}

export interface TierClassifyResult {
  decision: TierDecision
  /** Estimated notional in account base currency. Diagnostic. */
  notional: string
  /** One-line human-readable explanation. */
  reason: string
}

export interface TierPolicyConfig {
  /**
   * Orders with notional ≤ this auto-push. Default 300 USD on a
   * $4000 account = 7.5% of equity per order.
   */
  tier1MaxNotional: number
  /**
   * Orders ≤ this but > tier1MaxNotional require HITL approval.
   * Default 1000 USD = 25% of equity.
   */
  tier2MaxNotional: number
  /**
   * When true, ANY ETF order falls into Tier 1 regardless of size.
   * Useful when the user wants discretionary ETF rebalancing to skip
   * approval flow but require it for individual stocks. Default false.
   */
  tier1EtfOnly?: boolean
  /**
   * Optional set of symbols treated as ETFs for the rule above.
   * Free-form — caller is responsible for keeping the list correct
   * (typebb / opentypebb has a real ETF catalogue but pulling it
   * sync here is overkill).
   */
  etfSymbols?: ReadonlySet<string>
}

export const DEFAULT_TIER_POLICY: TierPolicyConfig = {
  tier1MaxNotional: 300,
  tier2MaxNotional: 1000,
  tier1EtfOnly: false,
  etfSymbols: new Set(['SPY', 'QQQ', 'IWM', 'DIA', 'VTI', 'VOO', 'EFA', 'EEM']),
}

export interface TierPolicy {
  classify(input: TierClassifyInput): TierClassifyResult
}

export function createTierPolicy(config: TierPolicyConfig = DEFAULT_TIER_POLICY): TierPolicy {
  return {
    classify(input: TierClassifyInput): TierClassifyResult {
      const notional = estimateNotional(input)
      const symbol = (input.contract.symbol ?? '').toUpperCase()
      const isEtf = config.etfSymbols?.has(symbol) ?? false

      // ETF exemption (when enabled): ETF orders bypass tier-2 → always auto
      if (config.tier1EtfOnly && isEtf) {
        return {
          decision: 'auto-push',
          notional: notional.toString(),
          reason: `ETF (${symbol}) exempt — auto-push`,
        }
      }

      if (notional.lte(config.tier1MaxNotional)) {
        return {
          decision: 'auto-push',
          notional: notional.toString(),
          reason: `notional $${notional.toFixed(2)} ≤ Tier 1 cap $${config.tier1MaxNotional}`,
        }
      }

      if (notional.lte(config.tier2MaxNotional)) {
        return {
          decision: 'hitl',
          notional: notional.toString(),
          reason: `notional $${notional.toFixed(2)} in Tier 2 ($${config.tier1MaxNotional}–$${config.tier2MaxNotional}) — requires approval`,
        }
      }

      return {
        decision: 'hard-stop',
        notional: notional.toString(),
        reason: `notional $${notional.toFixed(2)} > Tier 2 cap $${config.tier2MaxNotional} — hard stop, manual override required`,
      }
    },
  }
}

/**
 * Estimate the notional ($ value) of an order. Uses order.cashQty
 * directly if set; otherwise qty × priceHint; falls back to qty × 100
 * when no price hint is available (worst-case conservative — will
 * usually over-classify into a higher tier, which is safer).
 */
function estimateNotional(input: TierClassifyInput): Decimal {
  const { order, priceHint } = input

  // cashQty given directly
  if (order.cashQty && !order.cashQty.equals(UNSET_DECIMAL) && order.cashQty.gt(0)) {
    return order.cashQty
  }

  // Otherwise qty × price
  const qty = order.totalQuantity && !order.totalQuantity.equals(UNSET_DECIMAL)
    ? order.totalQuantity
    : new Decimal(0)
  if (qty.lte(0)) return new Decimal(0)

  // Price: prefer limit price, then explicit hint, then conservative 100
  const lmtPrice = order.lmtPrice && !order.lmtPrice.equals(UNSET_DECIMAL)
    ? order.lmtPrice
    : null

  const price = lmtPrice ?? (priceHint ? new Decimal(priceHint) : new Decimal(100))
  return qty.mul(price)
}
