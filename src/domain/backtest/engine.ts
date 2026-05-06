/**
 * BacktestEngine — drives a broker through historical bars and
 * records the equity curve.
 *
 * Per bar i:
 *   1. (i > 0) setQuote(bars[i].open); flushPendingMarketOrders()
 *      → market orders staged on bar i-1's close fill at bar i's open.
 *      This eliminates look-ahead bias: strategy decisions made on
 *      bar N close cannot transact at bar N close.
 *   2. setQuote(bars[i].close)        → mark-to-market.
 *   3. strategy(ctx) runs with history through bars[i].close.
 *      Market orders go to pending (deferred), limit orders too.
 *   4. snapshot equity = broker.getAccount().netLiquidation.
 *
 * Caveat: any market order placed on the LAST bar never fills —
 * there's no next bar to flush against. The engine logs and counts
 * these as "stranded" but they don't affect the equity curve.
 *
 * The engine duck-types `setQuote` and `flushPendingMarketOrders`.
 * MockBroker exposes both today; future replay brokers can opt in
 * by implementing the same shape.
 */

import Decimal from 'decimal.js'
import type { IBroker } from '../trading/brokers/types.js'
import type {
  Bar,
  BacktestConfig,
  BacktestReport,
  EquityPoint,
  StrategyContext,
} from './types.js'
import { returnsFromEquityCurve, sharpe, maxDrawdown, totalReturn } from './metrics.js'

interface QuotableBroker extends IBroker {
  setQuote(symbol: string, price: number): void
}

interface FlushableBroker extends IBroker {
  flushPendingMarketOrders(): number
}

function hasSetQuote(broker: IBroker): broker is QuotableBroker {
  return typeof (broker as { setQuote?: unknown }).setQuote === 'function'
}

function hasFlush(broker: IBroker): broker is FlushableBroker {
  return typeof (broker as { flushPendingMarketOrders?: unknown }).flushPendingMarketOrders === 'function'
}

// ==================== Public API ====================

/**
 * Run a backtest with the given config + broker. Caller owns broker
 * lifecycle: pre-stocked cash, post-run inspection, etc.
 *
 * Throws on invalid config (bars < 2, initialCash <= 0).
 */
export async function runBacktest(
  config: BacktestConfig,
  broker: IBroker,
): Promise<BacktestReport> {
  validate(config)

  const periodsPerYear = config.periodsPerYear ?? 252
  const riskFreeAnnual = config.riskFreeAnnual ?? 0

  const startWallMs = Date.now()
  const equityCurve: EquityPoint[] = []
  let tradeCount = 0

  // Track placeOrder call count via the broker's call log when present
  // (MockBroker exposes `callCount`). Fall back to wrapping placeOrder
  // for brokers without a call log.
  const initialPlaceOrderCount = readPlaceOrderCount(broker)

  const bareSymbol = stripSymbolSuffix(config.symbol)
  const canQuote = hasSetQuote(broker)
  const canFlush = hasFlush(broker)

  for (let i = 0; i < config.bars.length; i++) {
    const bar = config.bars[i]

    // 1. Bar-open fill: flush market orders from bar i-1 against
    //    today's open, eliminating look-ahead bias.
    if (i > 0 && canQuote) {
      broker.setQuote(bareSymbol, Number(bar.open))
      if (canFlush) broker.flushPendingMarketOrders()
    }

    // 2. Mark-to-market at this bar's close.
    if (canQuote) {
      broker.setQuote(bareSymbol, Number(bar.close))
    }

    // 3. Invoke the strategy. Market orders placed here go pending
    //    and fill on the next bar's open.
    const ctx: StrategyContext = {
      bar,
      history: config.bars.slice(0, i + 1),
      index: i,
      broker,
      symbol: config.symbol,
    }
    await config.strategy(ctx)

    // 4. Snapshot equity at the close.
    const account = await broker.getAccount()
    equityCurve.push({
      ts: bar.ts,
      equity: account.netLiquidation,
    })
  }

  const finalPlaceOrderCount = readPlaceOrderCount(broker)
  if (finalPlaceOrderCount != null && initialPlaceOrderCount != null) {
    tradeCount = finalPlaceOrderCount - initialPlaceOrderCount
  }

  const equityNumbers = equityCurve.map(p => Number(p.equity))
  const returns = returnsFromEquityCurve(equityNumbers)
  const sharpeValue = sharpe(returns, riskFreeAnnual, periodsPerYear)
  const ddFraction = maxDrawdown(equityNumbers)
  const trFraction = totalReturn(equityNumbers)

  return {
    symbol: config.symbol,
    initialEquity: equityCurve[0].equity,
    finalEquity: equityCurve[equityCurve.length - 1].equity,
    totalReturn: percentString(trFraction),
    sharpe: sharpeValue,
    maxDrawdown: percentString(ddFraction),
    equityCurve,
    tradeCount,
    startTs: equityCurve[0].ts,
    endTs: equityCurve[equityCurve.length - 1].ts,
    durationMs: Date.now() - startWallMs,
  }
}

// ==================== Helpers ====================

function validate(config: BacktestConfig): void {
  if (config.bars.length < 2) {
    throw new Error(`Backtest requires at least 2 bars, got ${config.bars.length}`)
  }
  if (config.initialCash <= 0 || !Number.isFinite(config.initialCash)) {
    throw new Error(`Backtest initialCash must be positive, got ${config.initialCash}`)
  }
  // Validate bars are chronological — out-of-order timestamps are a
  // common config bug that produces silently nonsense Sharpe numbers.
  for (let i = 1; i < config.bars.length; i++) {
    if (config.bars[i].ts.getTime() <= config.bars[i - 1].ts.getTime()) {
      throw new Error(
        `Bars must be strictly chronological. Bar ${i} ts ${config.bars[i].ts.toISOString()} ` +
        `is not after bar ${i - 1} ts ${config.bars[i - 1].ts.toISOString()}`,
      )
    }
  }
}

interface CallLoggable {
  callCount(method: string): number
}

function readPlaceOrderCount(broker: IBroker): number | null {
  const candidate = broker as IBroker & Partial<CallLoggable>
  if (typeof candidate.callCount === 'function') {
    return candidate.callCount('placeOrder')
  }
  return null
}

/**
 * Format a fraction (0.1234) as a percent string ("12.34"). Two
 * decimal places — finer precision is noise at the report level.
 */
function percentString(fraction: number): string {
  return new Decimal(fraction).mul(100).toFixed(2)
}

/**
 * MockBroker keys quotes by `contract.symbol`, but the engine takes
 * a `symbol` config field that may be an aliceId like
 * `"alpaca-paper|AAPL"`. Strip the prefix so quotes line up.
 */
function stripSymbolSuffix(symbol: string): string {
  const sep = symbol.indexOf('|')
  return sep === -1 ? symbol : symbol.slice(sep + 1)
}

// Re-export Bar so callers can import the engine and types from one
// place if they prefer.
export type { Bar, BacktestConfig, BacktestReport, EquityPoint, StrategyContext } from './types.js'
