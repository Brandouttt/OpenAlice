/**
 * Watchlist store — single-file JSON persistence.
 *
 * Single instance per process. Reads on demand (no in-memory caching
 * across writes — file IS the truth). Atomic writes via temp-file +
 * rename so a crash mid-write can't leave a half-written JSON that
 * fails to parse on next read.
 */

import { readFile, writeFile, rename, mkdir } from 'fs/promises'
import { resolve, dirname } from 'path'
import { randomBytes } from 'crypto'
import type { WatchlistEntry, WatchlistState } from './types.js'
import { emptyWatchlist } from './types.js'

const DEFAULT_PATH = resolve('data/watchlist.json')

export interface WatchlistStoreOptions {
  /** Override file path (tests use tmpdir). */
  filePath?: string
}

export class WatchlistStore {
  private readonly filePath: string

  constructor(options: WatchlistStoreOptions = {}) {
    this.filePath = options.filePath ?? DEFAULT_PATH
  }

  // ==================== Read ====================

  /** Load current state. Returns a fresh empty state if file missing / corrupt. */
  async load(): Promise<WatchlistState> {
    try {
      const raw = await readFile(this.filePath, 'utf-8')
      const parsed = JSON.parse(raw) as WatchlistState
      // Validate basic shape — corrupt files start fresh rather than crash.
      if (
        parsed &&
        typeof parsed === 'object' &&
        Array.isArray(parsed.entries) &&
        parsed.version === 1
      ) {
        return parsed
      }
      return emptyWatchlist()
    } catch {
      // Missing file or parse error → start fresh.
      return emptyWatchlist()
    }
  }

  /** List all entries. */
  async list(): Promise<WatchlistEntry[]> {
    const state = await this.load()
    return state.entries
  }

  /** Lookup one. Symbol comparison is case-insensitive. */
  async find(symbol: string): Promise<WatchlistEntry | undefined> {
    const upper = symbol.toUpperCase()
    const state = await this.load()
    return state.entries.find(e => e.symbol === upper)
  }

  // ==================== Write ====================

  /**
   * Add a symbol (or merge into an existing entry).
   *   - `reason` overwrites if provided
   *   - `tags` set-union into existing tags
   *   - `notes` overwrites if provided
   *   - `addedAt` preserved if entry already exists
   * Symbol is normalised to uppercase.
   */
  async add(input: {
    symbol: string
    reason?: string
    tags?: readonly string[]
    notes?: string
    now?: () => Date
  }): Promise<WatchlistEntry> {
    const symbol = input.symbol.trim().toUpperCase()
    if (!symbol) throw new Error('watchlist add: symbol must be a non-empty string')

    const state = await this.load()
    const existing = state.entries.find(e => e.symbol === symbol)
    const now = (input.now ?? (() => new Date()))().toISOString()

    let entry: WatchlistEntry
    if (existing) {
      entry = {
        ...existing,
        // overwrite reason / notes only when provided
        reason: input.reason !== undefined ? input.reason : existing.reason,
        notes: input.notes !== undefined ? input.notes : existing.notes,
        tags: mergeTags(existing.tags, input.tags),
      }
      state.entries = state.entries.map(e => e.symbol === symbol ? entry : e)
    } else {
      entry = {
        symbol,
        addedAt: now,
        reason: input.reason,
        tags: input.tags ? Array.from(new Set(input.tags.map(t => t.toLowerCase()))) : undefined,
        notes: input.notes,
      }
      state.entries = [...state.entries, entry]
    }

    await this.save(state)
    return entry
  }

  /** Remove a symbol. Returns true if it was present. */
  async remove(symbol: string): Promise<boolean> {
    const upper = symbol.trim().toUpperCase()
    if (!upper) return false

    const state = await this.load()
    const before = state.entries.length
    state.entries = state.entries.filter(e => e.symbol !== upper)
    const changed = state.entries.length !== before
    if (changed) await this.save(state)
    return changed
  }

  // ==================== Persistence helpers ====================

  /**
   * Atomic write: write to a sibling temp file, then rename over the
   * target. POSIX rename is atomic, so readers either see the old
   * complete content or the new complete content — never a partial
   * write.
   */
  private async save(state: WatchlistState): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const tmpPath = `${this.filePath}.${randomBytes(6).toString('hex')}.tmp`
    await writeFile(tmpPath, JSON.stringify(state, null, 2))
    await rename(tmpPath, this.filePath)
  }
}

// ==================== Helpers ====================

function mergeTags(
  existing: string[] | undefined,
  incoming: readonly string[] | undefined,
): string[] | undefined {
  if (!incoming || incoming.length === 0) return existing
  const merged = new Set<string>(
    (existing ?? []).map(t => t.toLowerCase()),
  )
  for (const t of incoming) merged.add(t.toLowerCase())
  return merged.size === 0 ? undefined : Array.from(merged)
}
