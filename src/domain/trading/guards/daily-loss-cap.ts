/**
 * DailyLossCapGuard — i.e. "stop opening new trades for the day
 * after the account has lost X% from the day's anchor."
 *
 * Anchor: the NetLiquidation observed on the first guard.check()
 * call of the day. Subsequent checks compute today's P&L =
 * currentEquity − anchorEquity. When that drops below
 * -maxPercentOfEquity, new entries are blocked. Exits and other
 * non-entry operations always pass through.
 *
 * Day boundary: midnight in `timezone` (default America/New_York —
 * US market trading day). Cross-day rollover is detected lazily on
 * the next check call after midnight; if there's no trading
 * activity for hours after midnight the anchor still rolls forward
 * the moment the AI next tries to trade.
 *
 * Caveat (documented): the anchor is captured on the FIRST check
 * of the day, NOT at true midnight. If you don't trade for the
 * first few hours, intraday losses before your first trade attempt
 * don't count toward the cap. A future cron-driven anchor
 * snapshotter (market-open trigger) can tighten this; for now we
 * accept the looser semantics — they're still strictly safer than
 * having no cap at all.
 *
 * State is persisted to data/trading/{accountId}/daily-loss-cap.json
 * so a restart inside the trading day doesn't reset the anchor and
 * allow an extra 2% of pain.
 */

import { readFile, writeFile, mkdir } from 'fs/promises'
import { resolve, dirname } from 'path'
import Decimal from 'decimal.js'
import type { OperationGuard, GuardContext } from './types.js'

const DEFAULT_MAX_PERCENT = 2 // 2% per day
const DEFAULT_TZ = 'America/New_York'

function diskFilePath(accountId: string): string {
  return resolve(`data/trading/${accountId}/daily-loss-cap.json`)
}

interface DiskState {
  dateKey: string
  anchorEquity: string
}

export class DailyLossCapGuard implements OperationGuard {
  readonly name = 'daily-loss-cap'

  private readonly maxPercent: number
  private readonly timezone: string
  private readonly accountId?: string
  private readonly now: () => number

  private dateKey: string | null = null
  private anchorEquity: Decimal | null = null
  private loaded = false

  constructor(options: Record<string, unknown>) {
    this.maxPercent = Number(options.maxPercentOfEquity ?? DEFAULT_MAX_PERCENT)
    if (!Number.isFinite(this.maxPercent) || this.maxPercent <= 0) {
      throw new Error(`daily-loss-cap: maxPercentOfEquity must be a positive number, got ${options.maxPercentOfEquity}`)
    }

    this.timezone = typeof options.timezone === 'string' && options.timezone.length > 0
      ? options.timezone
      : DEFAULT_TZ

    const acct = options.accountId
    this.accountId = typeof acct === 'string' && acct.length > 0 ? acct : undefined

    // `now` injection lets specs control the clock without monkey-
    // patching Date globally. Default to Date.now in production.
    const nowFn = options.now
    this.now = typeof nowFn === 'function' ? (nowFn as () => number) : Date.now
  }

  async check(ctx: GuardContext): Promise<string | null> {
    if (ctx.operation.action !== 'placeOrder') return null

    const action = ctx.operation.order.action.toUpperCase()
    const isEntry = action === 'BUY' || action === 'SSHORT' || action === 'SELL SHORT'
    if (!isEntry) return null

    if (!this.loaded) await this.load()

    const today = this.getDateKey(this.now())
    const currentEquity = new Decimal(ctx.account.netLiquidation)
    if (currentEquity.lte(0)) return null // can't measure % on zero/negative equity

    // Day rollover (or first-ever check) → reset anchor and allow.
    if (this.dateKey !== today || this.anchorEquity === null) {
      this.dateKey = today
      this.anchorEquity = currentEquity
      void this.persistAsync()
      return null
    }

    // Today's P&L vs anchor
    const pnl = currentEquity.minus(this.anchorEquity)
    if (this.anchorEquity.lte(0)) return null
    const pnlPct = pnl.div(this.anchorEquity).mul(100)

    if (pnlPct.lt(-this.maxPercent)) {
      return (
        `Daily loss cap hit: today P&L ${pnlPct.toFixed(2)}% ` +
        `($${pnl.toFixed(2)} from anchor $${this.anchorEquity.toFixed(2)}) ` +
        `breaches -${this.maxPercent}% cap. ` +
        `New entries blocked until next trading day. Exits and order management still allowed.`
      )
    }

    return null
  }

  // ==================== Persistence ====================

  private async load(): Promise<void> {
    this.loaded = true
    if (!this.accountId) return
    try {
      const raw = await readFile(diskFilePath(this.accountId), 'utf-8')
      const state = JSON.parse(raw) as DiskState
      if (typeof state.dateKey === 'string' && typeof state.anchorEquity === 'string') {
        this.dateKey = state.dateKey
        this.anchorEquity = new Decimal(state.anchorEquity)
      }
    } catch {
      // No saved state / corrupt → start fresh.
    }
  }

  private async persistAsync(): Promise<void> {
    if (!this.accountId || this.dateKey === null || this.anchorEquity === null) return
    const path = diskFilePath(this.accountId)
    const state: DiskState = {
      dateKey: this.dateKey,
      anchorEquity: this.anchorEquity.toString(),
    }
    try {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, JSON.stringify(state, null, 2))
    } catch (err) {
      console.warn(
        `daily-loss-cap: persist failed for ${this.accountId}:`,
        err instanceof Error ? err.message : err,
      )
    }
  }

  // ==================== Date key ====================

  /**
   * Map an epoch-ms timestamp to a YYYY-MM-DD date key in the
   * configured timezone. Uses Intl.DateTimeFormat for DST-correct
   * conversion — naive UTC arithmetic would drift twice a year.
   */
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
      // Bad timezone → fall back to UTC. Logged once.
      return d.toISOString().slice(0, 10)
    }
  }
}
