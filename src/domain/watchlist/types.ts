/**
 * Watchlist — i.e. "the list of symbols I'm paying attention to."
 *
 * Single global list (broker-agnostic). When the user mentions a
 * symbol in chat ("NVDA looks strong, watch it") the AI calls
 * watchlistAdd to remember it. The automation layer (Phase 3.7)
 * later reads from here to decide which symbols its strategy
 * worker should scan.
 *
 * Storage: data/watchlist.json — single file, atomic writes.
 */

export interface WatchlistEntry {
  /** Ticker symbol, uppercase. Examples: "NVDA", "SPY", "BTC-USD". */
  symbol: string

  /** When this symbol was first added, ISO 8601. */
  addedAt: string

  /**
   * Optional free-text reason the symbol was added. Set when the
   * AI captures the user's intent ("user-flagged AI strength",
   * "earnings beat", etc.). Re-add overwrites.
   */
  reason?: string

  /**
   * Optional categorical tags. Useful for future filtering — e.g.
   * "auto-trade everything tagged 'AI'". Lowercase by convention.
   * Re-add merges (set-union) rather than overwriting.
   */
  tags?: string[]

  /** Optional free-form trader notes. Set by chat or manual edit. */
  notes?: string
}

export interface WatchlistState {
  version: 1
  entries: WatchlistEntry[]
}

/**
 * Factory — returns a fresh empty state each call. A module-level
 * constant would be mutated by callers that `state.entries.push(...)`,
 * silently polluting subsequent reads across the whole process.
 */
export function emptyWatchlist(): WatchlistState {
  return { version: 1, entries: [] }
}
