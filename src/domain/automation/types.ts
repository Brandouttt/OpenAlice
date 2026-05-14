/**
 * Automation entry — i.e. "auto-trade this (account, symbol, strategy)
 * triple". The strategy worker (Phase 3.7b) reads enabled entries
 * from this config and runs the corresponding strategy on each tick.
 *
 * Storage: data/automation/strategies.json — single global file,
 * each entry carrying its own accountId. Per-account split was
 * considered and rejected for v1: cross-account queries ("what
 * strategies are running in total?") are simpler with one file,
 * and the entry-level accountId already gives isolation when
 * needed.
 */

export interface AutomationEntry {
  /** Owning UTA id, e.g. "paper-alpaca", "ibkr-live". */
  accountId: string

  /** Ticker symbol, uppercase. */
  symbol: string

  /** Registered strategy name, e.g. "leader-pullback-v1". */
  strategyName: string

  /**
   * Parameter overrides for this (account, symbol, strategy)
   * instance. Merged on top of the strategy's metadata.defaults.
   * Free-shape — the strategy factory validates.
   */
  params: Record<string, unknown>

  /**
   * Master switch. The worker only ticks entries where enabled=true.
   * Disabled entries are KEPT in the file (so re-enabling preserves
   * the same params) rather than deleted.
   */
  enabled: boolean

  /** When this entry was first added, ISO 8601. */
  addedAt: string

  /** Optional free-form notes — e.g. "earnings catalyst expected next week". */
  notes?: string
}

export interface AutomationState {
  version: 1
  entries: AutomationEntry[]
}

/** Fresh empty state. Factory, not a constant — see watchlist for why. */
export function emptyAutomation(): AutomationState {
  return { version: 1, entries: [] }
}

/**
 * Compound key identifying a unique automation row. Stringified
 * for use as a Map key when the worker caches strategy closures.
 */
export function automationKey(e: Pick<AutomationEntry, 'accountId' | 'symbol' | 'strategyName'>): string {
  return `${e.accountId}::${e.symbol}::${e.strategyName}`
}
