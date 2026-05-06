/**
 * Backtest metrics — pure functions, no broker / state coupling.
 *
 * All inputs are plain numbers (already converted out of Decimal at
 * the engine boundary). These are statistical aggregates, not
 * monetary amounts that need sub-cent precision.
 */

// ==================== Returns ====================

/**
 * Period-over-period simple returns from an equity curve.
 *
 * `returns[i] = (equity[i+1] - equity[i]) / equity[i]`
 *
 * Skips any pairs where the prior equity is zero (would NaN). Returns
 * an empty array if the curve has fewer than 2 points.
 */
export function returnsFromEquityCurve(equity: readonly number[]): number[] {
  if (equity.length < 2) return []
  const out: number[] = []
  for (let i = 1; i < equity.length; i++) {
    const prev = equity[i - 1]
    if (prev === 0) continue
    out.push((equity[i] - prev) / prev)
  }
  return out
}

// ==================== Sharpe ====================

/**
 * Annualized Sharpe ratio.
 *
 * sharpe = (mean(r) - rf_per_period) / std(r) × sqrt(periodsPerYear)
 *
 * Returns `NaN` if std(r) is zero (or fewer than 2 returns) — caller
 * decides how to display the absent value.
 */
export function sharpe(
  returns: readonly number[],
  riskFreeAnnual: number,
  periodsPerYear: number,
): number {
  if (returns.length < 2) return NaN
  const rfPerPeriod = riskFreeAnnual / periodsPerYear
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length
  const variance =
    returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (returns.length - 1)
  const std = Math.sqrt(variance)
  if (std === 0) return NaN
  return ((mean - rfPerPeriod) / std) * Math.sqrt(periodsPerYear)
}

// ==================== Max Drawdown ====================

/**
 * Maximum drawdown as a positive fraction (0.15 = 15%).
 *
 * Walks the equity curve tracking the running peak, returning the
 * largest drop from peak to trough as a fraction of the peak.
 * Returns 0 for a strictly non-decreasing curve or one of length < 2.
 */
export function maxDrawdown(equity: readonly number[]): number {
  if (equity.length < 2) return 0
  let peak = equity[0]
  let worst = 0
  for (const v of equity) {
    if (v > peak) peak = v
    if (peak > 0) {
      const dd = (peak - v) / peak
      if (dd > worst) worst = dd
    }
  }
  return worst
}

// ==================== Total return ====================

/**
 * Simple total return from start to end as a fraction (0.12 = 12%).
 * Returns 0 if the curve has fewer than 2 points or starts at zero.
 */
export function totalReturn(equity: readonly number[]): number {
  if (equity.length < 2) return 0
  const first = equity[0]
  if (first === 0) return 0
  return (equity[equity.length - 1] - first) / first
}
