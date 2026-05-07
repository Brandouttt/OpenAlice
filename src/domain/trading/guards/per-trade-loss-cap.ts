/**
 * PerTradeLossCapGuard — i.e. "skip any trade where the stop-loss
 * exit would lose more than X% of equity."
 *
 * Read at trade-entry time:
 *   risk = qty × |entry − stopPrice|
 *   if risk > equity × maxPercent → reject
 *
 * Stop-loss source: the operation's `tpsl.stopLoss.price`. If the
 * order has no stop attached and `requireStop` is true (default),
 * the guard rejects so traders are forced to declare the
 * worst-case before entering. If `requireStop` is false the guard
 * skips no-stop trades (other guards may still catch).
 *
 * Entry-price reference:
 *   - LMT order → use lmtPrice
 *   - MKT order with an existing position in the same symbol →
 *     use that position's marketPrice (best available recent price)
 *   - MKT new symbol → can't price the risk; allow and warn (rare)
 *
 * Stateless. No persistence needed.
 */

import Decimal from 'decimal.js'
import { UNSET_DECIMAL } from '@traderalice/ibkr'
import type { OperationGuard, GuardContext } from './types.js'

const DEFAULT_MAX_PERCENT = 1 // 1% per trade — Mark Minervini / O'Neil baseline

export class PerTradeLossCapGuard implements OperationGuard {
  readonly name = 'per-trade-loss-cap'
  private maxPercent: number
  private requireStop: boolean

  constructor(options: Record<string, unknown>) {
    this.maxPercent = Number(options.maxPercentOfEquity ?? DEFAULT_MAX_PERCENT)
    this.requireStop = options.requireStop !== false // default true
  }

  check(ctx: GuardContext): string | null {
    if (ctx.operation.action !== 'placeOrder') return null

    const { operation, positions, account } = ctx
    const { order, contract, tpsl } = operation

    // Only check entries (BUY long, SELL_SHORT short). Exits don't
    // need the cap because they unwind existing risk rather than
    // adding new.
    const action = order.action.toUpperCase()
    const isEntry = action === 'BUY' || action === 'SSHORT' || action === 'SELL SHORT'
    if (!isEntry) return null

    // Stop-loss price (string from tpsl)
    const stopPriceStr = tpsl?.stopLoss?.price
    if (!stopPriceStr) {
      if (this.requireStop) {
        return `Trade rejected: no stopLoss declared (per-trade-loss-cap requires every entry to have a stop). Pass tpsl.stopLoss.price.`
      }
      return null
    }
    const stopPrice = new Decimal(stopPriceStr)

    // Quantity
    const qty = !order.totalQuantity.equals(UNSET_DECIMAL) ? order.totalQuantity : null
    if (!qty || qty.lte(0)) return null // can't compute risk on cash-qty / 0-qty orders

    // Entry-price reference
    const entry = this.estimateEntry(order, contract.symbol, positions)
    if (entry === null) {
      // Can't estimate; allow and let other guards / broker catch it.
      // Logged once so the operator notices if this happens often.
      return null
    }

    // Risk per share
    const riskPerShare = entry.minus(stopPrice).abs()
    const totalRisk = qty.mul(riskPerShare)

    // Cap as $ amount
    const equity = new Decimal(account.netLiquidation)
    if (equity.lte(0)) return null
    const capDollars = equity.mul(this.maxPercent).div(100)

    if (totalRisk.gt(capDollars)) {
      return (
        `Trade risk $${totalRisk.toFixed(2)} exceeds per-trade cap ` +
        `${this.maxPercent}% of equity ($${capDollars.toFixed(2)}). ` +
        `Reduce qty or tighten stop.`
      )
    }

    return null
  }

  /**
   * Estimate the entry price the order will fill at. Returns null
   * when no reliable reference is available (new symbol on a market
   * order). String → Decimal conversion is centralised here.
   */
  private estimateEntry(
    order: GuardContext['operation'] extends { action: 'placeOrder'; order: infer O } ? O : never,
    symbol: string,
    positions: GuardContext['positions'],
  ): Decimal | null {
    // LMT order — limit price IS the entry assumption
    if (
      order.lmtPrice != null &&
      !order.lmtPrice.equals(UNSET_DECIMAL) &&
      order.lmtPrice.gt(0)
    ) {
      return order.lmtPrice
    }

    // Fall back to existing-position marketPrice (handles "add to
    // existing position via market order" path).
    const existing = positions.find(p => p.contract.symbol === symbol)
    if (existing && existing.marketPrice) {
      const mp = new Decimal(existing.marketPrice)
      if (mp.gt(0)) return mp
    }

    return null
  }
}
