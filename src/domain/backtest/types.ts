/**
 * Backtest type definitions.
 *
 * Minimum viable: drives a broker through a list of historical bars,
 * calls a strategy callback per bar, and reports the equity curve +
 * basic metrics. UTA / guards / git wrapping is intentionally NOT in
 * v1 — that's Phase 1.4+. Strategy talks to the broker directly so
 * we can prove the engine end-to-end before adding layers.
 */

import type { IBroker } from '../trading/brokers/types.js'

// ==================== Bar ====================

/**
 * OHLCV bar, all monetary fields as Decimal-safe strings.
 *
 * `ts` is the bar's anchor timestamp. The convention here is
 * "close-of-period" — bar.ts represents the moment the bar finished.
 */
export interface Bar {
  ts: Date
  open: string
  high: string
  low: string
  close: string
  volume: string
}

// ==================== Strategy ====================

export interface StrategyContext {
  /** The current bar; same as history[index]. */
  bar: Bar
  /** Bars [0..index] inclusive. */
  history: readonly Bar[]
  /** Position of `bar` inside `history`. */
  index: number
  /** Broker the strategy trades through. Already quoted at bar.close. */
  broker: IBroker
  /** Symbol the strategy is trading. */
  symbol: string
}

/**
 * A strategy is a function called once per bar. It may stage orders
 * directly via `ctx.broker.placeOrder(...)` etc., or do nothing.
 *
 * Sync or async; the engine awaits the return value.
 */
export type Strategy = (ctx: StrategyContext) => Promise<void> | void

// ==================== Config ====================

export interface BacktestConfig {
  /** Symbol identifier — purely informational, used in the report. */
  symbol: string
  /** OHLCV bars in chronological order. Must have at least 2 bars. */
  bars: Bar[]
  /** Starting cash. Must be positive. */
  initialCash: number
  /** Strategy invoked per bar. */
  strategy: Strategy
  /**
   * Bars per year, used to annualize Sharpe. 252 for daily US
   * equities; 365 for crypto; 252×6.5 for hourly intraday during
   * regular hours; etc. Default 252 (daily).
   */
  periodsPerYear?: number
  /**
   * Risk-free rate (annualized, decimal — 0.04 = 4%). Default 0.
   * Used in Sharpe numerator.
   */
  riskFreeAnnual?: number
}

// ==================== Report ====================

export interface EquityPoint {
  ts: Date
  /** Total account value at this bar's close (Decimal as string). */
  equity: string
}

export interface BacktestReport {
  symbol: string
  /** Cash + position value at bar 0. */
  initialEquity: string
  /** Cash + position value at the final bar. */
  finalEquity: string
  /** (final - initial) / initial × 100, formatted as a percent string. */
  totalReturn: string
  /** Annualized Sharpe ratio. NaN if std dev of returns is zero. */
  sharpe: number
  /** Maximum drawdown as a percent string (e.g. "12.34" → 12.34%). */
  maxDrawdown: string
  /** Equity at each bar's close, in chronological order. */
  equityCurve: EquityPoint[]
  /** Number of `placeOrder` calls the strategy issued, regardless of fill. */
  tradeCount: number
  startTs: Date
  endTs: Date
  /** Wall-clock ms spent running the backtest itself. Diagnostic. */
  durationMs: number
}
