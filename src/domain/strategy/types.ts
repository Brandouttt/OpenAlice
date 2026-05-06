/**
 * Strategy registry types — i.e. the metadata + factory shape that
 * every named strategy must export so the registry can look it up
 * and the backtest tool can describe it back to the AI.
 *
 * A Strategy itself is the per-bar callback defined in
 * `domain/backtest/types.ts`. A RegisteredStrategy wraps that
 * callback with a description and a factory so it can be parameterised
 * by name + JSON params (e.g. {fast: 10, slow: 30}) instead of being
 * hard-coded at the call site.
 */

import type { Strategy } from '../backtest/types.js'

// ==================== Metadata ====================

/**
 * Hints for human + AI consumers about when a strategy is appropriate.
 * Purely advisory — the registry does not enforce anything based on
 * these fields. Leave `marketRegime` undefined when unsure.
 */
export type MarketRegime =
  | 'trending'      // strategy expects directional moves (e.g. SMA crossover)
  | 'choppy'        // strategy expects mean-reversion / range-bound action
  | 'breakout'      // strategy expects volatility expansions
  | 'defensive'    // strategy is a safe-mode (e.g. all-cash)
  | 'any'           // works in most regimes (rare; usually overconfident)

export interface StrategyParameter {
  name: string
  description: string
  default: number | string | boolean
  /** Soft hint for AI / humans; not enforced. */
  range?: { min?: number; max?: number }
}

export interface StrategyMetadata {
  name: string
  description: string
  /** Bars the strategy needs before it can issue signals. */
  warmupBars: number
  /** Default params; AI / config can override individual keys. */
  defaults: Record<string, number | string | boolean>
  /** Each parameter's purpose — surfaced in the AI tool description. */
  parameters: StrategyParameter[]
  /** Optional regime hint, for the human picking which to enable. */
  marketRegime?: MarketRegime
}

// ==================== Registered strategy ====================

/**
 * A registered strategy = metadata + a factory that produces a
 * Strategy callback given concrete params. The factory exists so
 * each backtest run gets a fresh closure (state like "have I bought
 * yet?" can't leak across runs).
 */
export interface RegisteredStrategy {
  metadata: StrategyMetadata
  /**
   * Build a Strategy callback. Implementation should validate /
   * coerce params against `metadata.defaults` and throw on bad
   * input.
   */
  factory: (params: Record<string, unknown>) => Strategy
}
