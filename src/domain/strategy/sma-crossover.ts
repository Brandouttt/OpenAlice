/**
 * SMA crossover — i.e. "buy when the short moving average crosses
 * above the long one; sell when it crosses below."
 *
 * Long-only, one-position-at-a-time. Useful as the engine's
 * regression baseline (Phase 1.6a) and as a textbook trending-market
 * strategy. Not recommended as a primary live strategy — it lags
 * turning points by definition.
 */

import Decimal from 'decimal.js'
import { Order, UNSET_DECIMAL } from '@traderalice/ibkr'
import { makeContract } from '../trading/brokers/mock/index.js'
import '../trading/contract-ext.js'
import type { Strategy } from '../backtest/types.js'
import type { RegisteredStrategy } from './types.js'

// ==================== Pure helpers (exported for spec re-use) ====================

/** Simple moving average of the last `period` closes. */
export function sma(closes: readonly number[], period: number): number | null {
  if (closes.length < period) return null
  let sum = 0
  for (let i = closes.length - period; i < closes.length; i++) sum += closes[i]
  return sum / period
}

/** Build a market BUY/SELL order with all unused Decimal fields properly UNSET. */
export function makeMarketOrder(action: 'BUY' | 'SELL', qty: number): Order {
  const order = new Order()
  order.action = action
  order.orderType = 'MKT'
  order.totalQuantity = new Decimal(qty)
  order.lmtPrice = UNSET_DECIMAL
  order.auxPrice = UNSET_DECIMAL
  order.trailStopPrice = UNSET_DECIMAL
  order.trailingPercent = UNSET_DECIMAL
  order.cashQty = UNSET_DECIMAL
  return order
}

// ==================== Strategy factory ====================

export interface SmaCrossoverParams {
  fast: number
  slow: number
  qty: number
}

/**
 * Long-only SMA crossover.
 *   - Enter long `qty` shares on the bar where MA(fast) crosses above MA(slow).
 *   - Exit (sell `qty`) on the bar where MA(fast) crosses below MA(slow).
 *
 * Holds at most one position at a time. Issues market orders which —
 * under deferred-fill mode in BacktestEngine — execute at the next
 * bar's open.
 */
export function makeSmaCrossover({ fast, slow, qty }: SmaCrossoverParams): Strategy {
  // Positivity check first so a clearer error fires before the
  // ordering check (otherwise `slow=0` reads as "fast not less than
  // slow" rather than the actual problem).
  if (fast < 1 || slow < 1 || qty < 1) {
    throw new Error(`sma-crossover: fast/slow/qty must all be >= 1`)
  }
  if (fast >= slow) {
    throw new Error(
      `sma-crossover: fast (${fast}) must be less than slow (${slow})`,
    )
  }

  let inPosition = false

  // The callback per bar. Assigned to a `const fn` so we can attach
  // getState / resetState methods to expose internal closure state
  // to the automation UI.
  const fn: Strategy = (async ({ broker, history, symbol }) => {
    if (history.length < slow + 1) return // need slow + 1 to compare prev vs now

    const closes = history.map(b => Number(b.close))
    const fastNow = sma(closes, fast)
    const slowNow = sma(closes, slow)
    const fastPrev = sma(closes.slice(0, -1), fast)
    const slowPrev = sma(closes.slice(0, -1), slow)
    if (fastNow == null || slowNow == null || fastPrev == null || slowPrev == null) return

    const crossedUp = fastPrev <= slowPrev && fastNow > slowNow
    const crossedDown = fastPrev >= slowPrev && fastNow < slowNow

    const contract = makeContract({ symbol, aliceId: `mock-paper|${symbol}` })

    if (!inPosition && crossedUp) {
      await broker.placeOrder(contract, makeMarketOrder('BUY', qty))
      inPosition = true
    } else if (inPosition && crossedDown) {
      await broker.placeOrder(contract, makeMarketOrder('SELL', qty))
      inPosition = false
    }
  }) as Strategy

  fn.getState = () => ({
    position: inPosition ? 'long' : 'flat',
    details: { inPosition, fast, slow, qty },
  })

  fn.resetState = () => {
    inPosition = false
  }

  return fn
}

// ==================== Registry entry ====================

export const smaCrossoverStrategy: RegisteredStrategy = {
  metadata: {
    name: 'sma-crossover',
    description:
      'Long-only Simple Moving Average crossover. Buys when the fast MA ' +
      'crosses above the slow MA; sells when it crosses below. Textbook ' +
      'trend-following baseline — useful as engine regression test, not as ' +
      'a live primary strategy.',
    warmupBars: 51, // slow default 50 + 1 for prev-vs-now compare
    defaults: { fast: 20, slow: 50, qty: 100 },
    parameters: [
      {
        name: 'fast',
        description: 'Fast MA period (in bars).',
        default: 20,
        range: { min: 2, max: 200 },
      },
      {
        name: 'slow',
        description: 'Slow MA period (in bars). Must be greater than fast.',
        default: 50,
        range: { min: 3, max: 500 },
      },
      {
        name: 'qty',
        description: 'Shares to buy / sell per signal.',
        default: 100,
        range: { min: 1 },
      },
    ],
    marketRegime: 'trending',
  },
  factory: (params: Record<string, unknown>) => {
    const fast = Number(params.fast ?? 20)
    const slow = Number(params.slow ?? 50)
    const qty = Number(params.qty ?? 100)
    return makeSmaCrossover({ fast, slow, qty })
  },
}
