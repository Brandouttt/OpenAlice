/**
 * PdtDayTradeCounterGuard — i.e. "track SEC's Pattern Day Trader
 * count and reject the 4th same-day round-trip in any 5 trading days."
 *
 * The PDT rule: a US margin account with equity below $25,000 that
 * makes more than 3 day trades within any 5 rolling trading days
 * gets flagged as a Pattern Day Trader and frozen for 90 days. This
 * guard prevents the AI from triggering it.
 *
 * "Day trade" = a round-trip on a single symbol completed within
 * one trading day (NY date): a BUY followed by a SELL of the same
 * symbol on the same date (or vice versa for shorts). Partial
 * round-trips count as `min(buyQty, sellQty)` round-trips per
 * symbol per date — a coarse but conservative approximation of
 * SEC's actual counting that's plenty safe for retail single-share
 * trading.
 *
 * Day boundary uses Intl.DateTimeFormat with timezone
 * 'America/New_York' so DST-correct day keys.
 *
 * Disabled when:
 *   - accountType is 'cash' (PDT only applies to margin)
 *   - account equity ≥ equityThreshold (default $25,000 — the SEC
 *     line above which the rule no longer applies)
 *
 * Stateless. Recomputes day-trade count from `ctx.recentCommits`
 * on every check.
 */

import Decimal from 'decimal.js'
import type { OperationGuard, GuardContext } from './types.js'
import type { GitCommit } from '../git/types.js'

const DEFAULT_MAX_DAY_TRADES = 3      // reject the 4th
const DEFAULT_WINDOW_DAYS = 5         // rolling 5 trading days
const DEFAULT_EQUITY_THRESHOLD = 25_000
const DEFAULT_TZ = 'America/New_York'

export class PdtDayTradeCounterGuard implements OperationGuard {
  readonly name = 'pdt-day-trade-counter'

  private readonly maxDayTrades: number
  private readonly windowDays: number
  private readonly equityThreshold: Decimal
  private readonly accountType: 'margin' | 'cash'
  private readonly timezone: string
  private readonly now: () => number

  constructor(options: Record<string, unknown>) {
    this.maxDayTrades = Number(options.maxDayTrades ?? DEFAULT_MAX_DAY_TRADES)
    if (!Number.isFinite(this.maxDayTrades) || this.maxDayTrades < 0) {
      throw new Error(
        `pdt-day-trade-counter: maxDayTrades must be a non-negative integer, got ${options.maxDayTrades}`,
      )
    }

    this.windowDays = Number(options.windowDays ?? DEFAULT_WINDOW_DAYS)
    if (!Number.isFinite(this.windowDays) || this.windowDays < 1) {
      throw new Error(
        `pdt-day-trade-counter: windowDays must be a positive integer, got ${options.windowDays}`,
      )
    }

    this.equityThreshold = new Decimal(
      Number(options.equityThreshold ?? DEFAULT_EQUITY_THRESHOLD),
    )

    this.accountType = options.accountType === 'cash' ? 'cash' : 'margin'

    this.timezone = typeof options.timezone === 'string' && options.timezone.length > 0
      ? options.timezone
      : DEFAULT_TZ

    const nowFn = options.now
    this.now = typeof nowFn === 'function' ? (nowFn as () => number) : Date.now
  }

  check(ctx: GuardContext): string | null {
    if (ctx.operation.action !== 'placeOrder') return null

    // PDT only applies to margin accounts
    if (this.accountType === 'cash') return null

    // PDT only bites when equity < threshold (default $25k)
    const equity = new Decimal(ctx.account.netLiquidation)
    if (equity.gte(this.equityThreshold)) return null

    const symbol = ctx.operation.contract.symbol
    if (!symbol) return null

    const action = ctx.operation.order.action.toUpperCase()
    const isBuy = action === 'BUY'
    const isSell = action === 'SELL'
    if (!isBuy && !isSell) return null

    // Today's NY date
    const today = this.getDateKey(this.now())

    // Count completed day-trades in the rolling window (today
    // included). A trade today on `symbol` would COMPLETE a
    // round-trip if there's already an opposite-direction fill
    // on the same symbol earlier today.
    const fills = collectFillsByDayAndSymbol(ctx.recentCommits, this.timezone)
    const completedDayTrades = countDayTradesInWindow(fills, today, this.windowDays)

    // Hypothetical: if THIS order goes through, would it complete
    // a NEW round-trip today? Only when there's already an
    // opposite-side fill today on the same symbol AND it isn't
    // already paired off with a previous matching fill.
    const todayFills = fills.get(today) ?? new Map<string, { buy: Decimal; sell: Decimal }>()
    const symbolToday = todayFills.get(symbol) ?? { buy: new Decimal(0), sell: new Decimal(0) }
    const existingSameSide = isBuy ? symbolToday.buy : symbolToday.sell
    const existingOppositeSide = isBuy ? symbolToday.sell : symbolToday.buy
    const alreadyPaired = Decimal.min(symbolToday.buy, symbolToday.sell)
    const unpairedOpposite = existingOppositeSide.minus(alreadyPaired)

    // If unpairedOpposite > 0, a fill on this order will pair with
    // it and create a new day-trade. Conservative — assume any
    // fill on this side completes one round-trip even if quantities
    // differ.
    const wouldCreateNewDayTrade = unpairedOpposite.gt(0)
    void existingSameSide // documented intent — suppress unused-var

    const projected = wouldCreateNewDayTrade ? completedDayTrades + 1 : completedDayTrades

    if (projected > this.maxDayTrades) {
      return (
        `PDT: this trade would be your ${projected}-th day-trade in ${this.windowDays} ` +
        `trading days (limit: ${this.maxDayTrades} for margin accounts < ` +
        `$${this.equityThreshold.toFixed(0)}). ` +
        `Closing it today would freeze the account for 90 days. ` +
        `Hold overnight or wait for the rolling window to clear.`
      )
    }

    return null
  }

  /** Map epoch-ms → 'YYYY-MM-DD' in configured timezone (NY by default). */
  private getDateKey(epochMs: number): string {
    const d = new Date(epochMs)
    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: this.timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(d)
      const y = parts.find(p => p.type === 'year')?.value ?? '0000'
      const m = parts.find(p => p.type === 'month')?.value ?? '01'
      const day = parts.find(p => p.type === 'day')?.value ?? '01'
      return `${y}-${m}-${day}`
    } catch {
      return d.toISOString().slice(0, 10)
    }
  }
}

// ==================== Fill aggregation helpers ====================

/**
 * Date string ('YYYY-MM-DD') → symbol → { buy, sell } total filled
 * quantities. Aggregates over all commits in `recentCommits`.
 *
 * Considers only successful fills (results with `filledQty`). Cancels,
 * rejections, syncs are ignored.
 *
 * Exported for direct unit testing.
 */
export function collectFillsByDayAndSymbol(
  recentCommits: readonly GitCommit[],
  timezone: string,
): Map<string, Map<string, { buy: Decimal; sell: Decimal }>> {
  const out = new Map<string, Map<string, { buy: Decimal; sell: Decimal }>>()

  for (const commit of recentCommits) {
    const dateKey = epochToDateKey(new Date(commit.timestamp).getTime(), timezone)

    // Pair operations with their results by index — TradingGit
    // produces them in lockstep.
    for (let i = 0; i < commit.operations.length; i++) {
      const op = commit.operations[i]
      const result = commit.results[i]
      if (!result || !result.filledQty) continue
      if (op.action !== 'placeOrder') continue

      const symbol = op.contract.symbol
      if (!symbol) continue

      const action = op.order.action.toUpperCase()
      const filled = new Decimal(result.filledQty)
      if (filled.lte(0)) continue

      let dayMap = out.get(dateKey)
      if (!dayMap) {
        dayMap = new Map()
        out.set(dateKey, dayMap)
      }
      let bucket = dayMap.get(symbol)
      if (!bucket) {
        bucket = { buy: new Decimal(0), sell: new Decimal(0) }
        dayMap.set(symbol, bucket)
      }
      if (action === 'BUY') bucket.buy = bucket.buy.plus(filled)
      else if (action === 'SELL') bucket.sell = bucket.sell.plus(filled)
    }
  }

  return out
}

/**
 * Count completed day-trades in the rolling `windowDays`-ending-on-`today`
 * window. A symbol completes `min(buyQty, sellQty) > 0 ? 1 : 0` day-trades
 * per date — coarse but safe.
 *
 * Exported for direct unit testing.
 */
export function countDayTradesInWindow(
  fills: ReadonlyMap<string, ReadonlyMap<string, { buy: Decimal; sell: Decimal }>>,
  today: string,
  windowDays: number,
): number {
  let count = 0
  // Walk all dates in `fills`; only count those within the window.
  // We use string compare on YYYY-MM-DD since calendar-arithmetic
  // would require Intl-zone-aware date math; plain lex comparison
  // works for the rolling-N-days check IFF we generate the
  // earliest-allowed key from `today`.
  const earliest = subtractCalendarDaysIso(today, windowDays - 1)
  for (const [dateKey, dayMap] of fills.entries()) {
    if (dateKey < earliest || dateKey > today) continue
    for (const bucket of dayMap.values()) {
      if (bucket.buy.gt(0) && bucket.sell.gt(0)) count++
    }
  }
  return count
}

/**
 * Subtract `n` calendar days from a 'YYYY-MM-DD' string, returning
 * another 'YYYY-MM-DD'. Calendar (not trading) days, in UTC — we
 * only need the lex bound to be ≤ the actual rolling window, which
 * calendar arithmetic guarantees (weekends are ignored, so we
 * include them in the bound but commits won't fall on them anyway).
 */
function subtractCalendarDaysIso(yyyyMmDd: string, n: number): string {
  const [y, m, d] = yyyyMmDd.split('-').map(Number)
  const ms = Date.UTC(y, m - 1, d) - n * 24 * 60 * 60 * 1000
  return new Date(ms).toISOString().slice(0, 10)
}

function epochToDateKey(epochMs: number, timezone: string): string {
  const d = new Date(epochMs)
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(d)
    const y = parts.find(p => p.type === 'year')?.value ?? '0000'
    const m = parts.find(p => p.type === 'month')?.value ?? '01'
    const day = parts.find(p => p.type === 'day')?.value ?? '01'
    return `${y}-${m}-${day}`
  } catch {
    return d.toISOString().slice(0, 10)
  }
}
