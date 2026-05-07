/**
 * CircuitBreakerGuard — i.e. "after N consecutive losing trades,
 * pause new entries for M minutes so the model gets a cooldown."
 *
 * "Loss" = a commit whose realized P&L moved DOWN versus the
 * previous commit. This catches actual closed-trade losses, not
 * mark-to-market wobble on open positions. Reset on any commit
 * whose realized P&L moved UP (a winning close). Commits with
 * unchanged realized P&L (open-only adjustments, syncs, etc.)
 * neither count nor reset — they're "no realized event" rather
 * than wins or losses.
 *
 * Once the consecutive-loss count hits maxConsecutiveLosses, the
 * breaker trips. While tripped, new entries are blocked until the
 * cooldown timer expires. Exits and order management always pass
 * through — the same rationale as daily-loss-cap: stops MUST still
 * fire when the breaker is tripped.
 *
 * Single piece of persistent state: `tripExpiresAt` (epoch-ms when
 * the cooldown ends). Consecutive-loss count is recomputed from
 * the commit log on every check, so it self-heals after restart.
 */

import { readFile, writeFile, mkdir } from 'fs/promises'
import { resolve, dirname } from 'path'
import Decimal from 'decimal.js'
import type { OperationGuard, GuardContext } from './types.js'
import type { GitCommit } from '../git/types.js'

const DEFAULT_MAX_CONSECUTIVE_LOSSES = 5
const DEFAULT_COOLDOWN_MINUTES = 60 * 24 // 24 hours

function diskFilePath(accountId: string): string {
  return resolve(`data/trading/${accountId}/circuit-breaker.json`)
}

interface DiskState {
  tripExpiresAt: number | null
}

export class CircuitBreakerGuard implements OperationGuard {
  readonly name = 'circuit-breaker'

  private readonly maxConsecutiveLosses: number
  private readonly cooldownMs: number
  private readonly accountId?: string
  private readonly now: () => number

  private tripExpiresAt: number | null = null
  private loaded = false

  constructor(options: Record<string, unknown>) {
    this.maxConsecutiveLosses = Number(
      options.maxConsecutiveLosses ?? DEFAULT_MAX_CONSECUTIVE_LOSSES,
    )
    if (!Number.isFinite(this.maxConsecutiveLosses) || this.maxConsecutiveLosses < 1) {
      throw new Error(
        `circuit-breaker: maxConsecutiveLosses must be a positive integer, got ${options.maxConsecutiveLosses}`,
      )
    }

    const cooldownMin = Number(options.cooldownMinutes ?? DEFAULT_COOLDOWN_MINUTES)
    if (!Number.isFinite(cooldownMin) || cooldownMin <= 0) {
      throw new Error(
        `circuit-breaker: cooldownMinutes must be a positive number, got ${options.cooldownMinutes}`,
      )
    }
    this.cooldownMs = cooldownMin * 60_000

    const acct = options.accountId
    this.accountId = typeof acct === 'string' && acct.length > 0 ? acct : undefined

    const nowFn = options.now
    this.now = typeof nowFn === 'function' ? (nowFn as () => number) : Date.now
  }

  async check(ctx: GuardContext): Promise<string | null> {
    if (ctx.operation.action !== 'placeOrder') return null

    const action = ctx.operation.order.action.toUpperCase()
    const isEntry = action === 'BUY' || action === 'SSHORT' || action === 'SELL SHORT'
    if (!isEntry) return null

    if (!this.loaded) await this.load()

    // 1. Cooldown still active?
    if (this.tripExpiresAt !== null && this.now() < this.tripExpiresAt) {
      const remainingMin = Math.ceil((this.tripExpiresAt - this.now()) / 60_000)
      return (
        `Circuit breaker tripped: ${remainingMin}min cooldown remaining. ` +
        `Reached ${this.maxConsecutiveLosses} consecutive losing trades.`
      )
    }

    // 2. Cooldown expired (or never tripped) — clear any stale trip
    //    and re-evaluate consecutive losses from the commit log.
    if (this.tripExpiresAt !== null) {
      this.tripExpiresAt = null
      void this.persistAsync()
    }

    const consecutiveLosses = countConsecutiveLosses(ctx.recentCommits)
    if (consecutiveLosses >= this.maxConsecutiveLosses) {
      this.tripExpiresAt = this.now() + this.cooldownMs
      void this.persistAsync()
      return (
        `Circuit breaker triggered: ${consecutiveLosses} consecutive losses ` +
        `≥ ${this.maxConsecutiveLosses} threshold. ` +
        `Trading paused for ${Math.round(this.cooldownMs / 60_000)} minutes. ` +
        `Exits and order management still allowed.`
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
      if (typeof state.tripExpiresAt === 'number' && Number.isFinite(state.tripExpiresAt)) {
        this.tripExpiresAt = state.tripExpiresAt
      }
    } catch {
      // No saved state / corrupt → start fresh.
    }
  }

  private async persistAsync(): Promise<void> {
    if (!this.accountId) return
    const path = diskFilePath(this.accountId)
    const state: DiskState = { tripExpiresAt: this.tripExpiresAt }
    try {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, JSON.stringify(state, null, 2))
    } catch (err) {
      console.warn(
        `circuit-breaker: persist failed for ${this.accountId}:`,
        err instanceof Error ? err.message : err,
      )
    }
  }
}

// ==================== Loss-counting helper ====================

/**
 * Walk the commit log newest → oldest, counting how many consecutive
 * commits had a NEGATIVE realized-P&L delta (i.e. closed at a loss).
 *
 * Stops counting at:
 *   - the first commit with a positive delta (winning close → reset)
 *   - the end of the available log (returns whatever was counted)
 *
 * Commits with delta = 0 (no realized event — e.g. only opens or
 * syncs) neither count nor break the streak.
 *
 * Exported for direct unit testing.
 */
export function countConsecutiveLosses(commits: readonly GitCommit[]): number {
  let count = 0
  for (let i = 0; i < commits.length - 1; i++) {
    const curr = new Decimal(commits[i].stateAfter.realizedPnL)
    const prev = new Decimal(commits[i + 1].stateAfter.realizedPnL)
    const delta = curr.minus(prev)
    if (delta.lt(0)) {
      count++
    } else if (delta.gt(0)) {
      break // winning close ends the streak
    }
    // delta == 0: no realized event; continue without incrementing
  }
  return count
}
