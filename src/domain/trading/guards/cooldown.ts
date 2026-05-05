import { readFile, writeFile, mkdir } from 'fs/promises'
import { resolve, dirname } from 'path'
import type { OperationGuard, GuardContext } from './types.js'
import { getOperationSymbol } from '../git/types.js'

const DEFAULT_MIN_INTERVAL_MS = 60_000

/**
 * Path for the cooldown persistence file. Per-account isolation:
 * `data/trading/{accountId}/cooldown.json`. Mirrors the layout used
 * by git-persistence and snapshot/store.
 */
function cooldownFilePath(accountId: string): string {
  return resolve(`data/trading/${accountId}/cooldown.json`)
}

interface CooldownDiskState {
  // Map<symbol, lastTradeMs>
  lastTradeTime: Record<string, number>
}

export class CooldownGuard implements OperationGuard {
  readonly name = 'cooldown'
  private minIntervalMs: number
  private lastTradeTime = new Map<string, number>()

  /**
   * accountId enables per-UTA persistence. Without it, the guard runs
   * RAM-only (current behaviour) — used by unit tests that don't want
   * to touch disk.
   */
  private readonly accountId?: string
  private loaded = false

  constructor(options: Record<string, unknown>) {
    this.minIntervalMs = Number(options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS)
    const acct = options.accountId
    this.accountId = typeof acct === 'string' && acct.length > 0 ? acct : undefined
  }

  async check(ctx: GuardContext): Promise<string | null> {
    if (ctx.operation.action !== 'placeOrder') return null

    if (!this.loaded) await this.load()

    const symbol = getOperationSymbol(ctx.operation)
    const now = Date.now()
    const lastTime = this.lastTradeTime.get(symbol)

    if (lastTime != null) {
      const elapsed = now - lastTime
      if (elapsed < this.minIntervalMs) {
        const remaining = Math.ceil((this.minIntervalMs - elapsed) / 1000)
        return `Cooldown active for ${symbol}: ${remaining}s remaining`
      }
    }

    this.lastTradeTime.set(symbol, now)
    // Fire-and-forget; persistence failure shouldn't block the trade
    // path. Errors logged but swallowed.
    void this.persist().catch(err => {
      console.warn(
        `cooldown-guard: persist failed for ${this.accountId}:`,
        err instanceof Error ? err.message : err,
      )
    })
    return null
  }

  // ==================== Persistence ====================

  /**
   * Lazy-load on first check(). Constructor stays sync to keep the
   * registry factory signature unchanged.
   */
  private async load(): Promise<void> {
    this.loaded = true
    if (!this.accountId) return
    try {
      const raw = await readFile(cooldownFilePath(this.accountId), 'utf-8')
      const state = JSON.parse(raw) as CooldownDiskState
      if (state.lastTradeTime && typeof state.lastTradeTime === 'object') {
        for (const [sym, ts] of Object.entries(state.lastTradeTime)) {
          if (typeof ts === 'number' && Number.isFinite(ts)) {
            this.lastTradeTime.set(sym, ts)
          }
        }
      }
    } catch {
      // No saved state (first run / file missing / corrupted) — start
      // empty, same as before.
    }
  }

  private async persist(): Promise<void> {
    if (!this.accountId) return
    const path = cooldownFilePath(this.accountId)
    const state: CooldownDiskState = {
      lastTradeTime: Object.fromEntries(this.lastTradeTime),
    }
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(state, null, 2))
  }
}
