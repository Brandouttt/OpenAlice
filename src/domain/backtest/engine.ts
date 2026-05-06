/**
 * BacktestEngine v1 — minimum viable.
 *
 * Drives a broker through historical bars and records the equity
 * curve. Per bar:
 *   1. Set the broker's quote to bar.close
 *   2. Invoke strategy(ctx) — strategy may issue trades via ctx.broker
 *   3. Snapshot equity = broker.getAccount().netLiquidation
 *
 * Look-ahead caveat: strategy sees bar.close BEFORE deciding, and
 * orders fill at that same close. This overstates strategy edge.
 * Phase 1.4 introduces a next-bar-open fill model that closes this
 * gap; until then, treat v1 metrics as engine-validation only, not
 * production strategy assessment.
 *
 * The engine accepts any IBroker. It uses MockBroker's `setQuote`
 * convention via duck-typing — if the broker has a `setQuote` method
 * the engine drives it; otherwise the broker is responsible for
 * resolving its own quote (e.g. a future replay broker).
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

function hasSetQuote(broker: IBroker): broker is QuotableBroker {
  return typeof (broker as { setQuote?: unknown }).setQuote === 'function'
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

  for (let i = 0; i < config.bars.length; i++) {
    const bar = config.bars[i]

    // 1. Quote the broker at this bar's close
    if (hasSetQuote(broker)) {
      broker.setQuote(stripSymbolSuffix(config.symbol), Number(bar.close))
    }

    // 2. Invoke the strategy
    const ctx: StrategyContext = {
      bar,
      history: config.bars.slice(0, i + 1),
      index: i,
      broker,
      symbol: config.symbol,
    }
    await config.strategy(ctx)

    // 3. Snapshot equity
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
