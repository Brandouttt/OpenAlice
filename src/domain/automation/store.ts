/**
 * Automation config store — single-file JSON persistence.
 *
 * Mirrors WatchlistStore: atomic writes via temp-file + rename,
 * corrupt-file tolerance, per-test isolation via custom filePath.
 *
 * Primary key is the (accountId, symbol, strategyName) triple.
 * Re-adding an existing triple MERGES — params are replaced when
 * provided, enabled / notes are overwritten when provided, addedAt
 * is preserved.
 */

import { readFile, writeFile, rename, mkdir } from 'fs/promises'
import { resolve, dirname } from 'path'
import { randomBytes } from 'crypto'
import type { AutomationEntry, AutomationState } from './types.js'
import { automationKey, emptyAutomation } from './types.js'

const DEFAULT_PATH = resolve('data/automation/strategies.json')

export interface AutomationStoreOptions {
  filePath?: string
}

export class AutomationStore {
  private readonly filePath: string

  constructor(options: AutomationStoreOptions = {}) {
    this.filePath = options.filePath ?? DEFAULT_PATH
  }

  // ==================== Read ====================

  async load(): Promise<AutomationState> {
    try {
      const raw = await readFile(this.filePath, 'utf-8')
      const parsed = JSON.parse(raw) as AutomationState
      if (
        parsed &&
        typeof parsed === 'object' &&
        Array.isArray(parsed.entries) &&
        parsed.version === 1
      ) {
        return parsed
      }
      return emptyAutomation()
    } catch {
      return emptyAutomation()
    }
  }

  async list(): Promise<AutomationEntry[]> {
    const state = await this.load()
    return state.entries
  }

  /** Filter helper — all entries for one account. */
  async listForAccount(accountId: string): Promise<AutomationEntry[]> {
    const entries = await this.list()
    return entries.filter(e => e.accountId === accountId)
  }

  /** Filter helper — only enabled entries (worker's primary query). */
  async listEnabled(): Promise<AutomationEntry[]> {
    const entries = await this.list()
    return entries.filter(e => e.enabled)
  }

  async find(
    accountId: string,
    symbol: string,
    strategyName: string,
  ): Promise<AutomationEntry | undefined> {
    const key = automationKey({ accountId, symbol: symbol.toUpperCase(), strategyName })
    const entries = await this.list()
    return entries.find(e => automationKey(e) === key)
  }

  // ==================== Write ====================

  /**
   * Upsert (insert or merge-update). `enabled` defaults to true on
   * first insert; on update, omitted fields are preserved.
   */
  async upsert(input: {
    accountId: string
    symbol: string
    strategyName: string
    params?: Record<string, unknown>
    enabled?: boolean
    notes?: string
    now?: () => Date
  }): Promise<AutomationEntry> {
    const accountId = input.accountId.trim()
    const symbol = input.symbol.trim().toUpperCase()
    const strategyName = input.strategyName.trim()
    if (!accountId) throw new Error('automation upsert: accountId must be non-empty')
    if (!symbol) throw new Error('automation upsert: symbol must be non-empty')
    if (!strategyName) throw new Error('automation upsert: strategyName must be non-empty')

    const state = await this.load()
    const key = automationKey({ accountId, symbol, strategyName })
    const existing = state.entries.find(e => automationKey(e) === key)
    const now = (input.now ?? (() => new Date()))().toISOString()

    let entry: AutomationEntry
    if (existing) {
      entry = {
        ...existing,
        params: input.params !== undefined ? input.params : existing.params,
        enabled: input.enabled !== undefined ? input.enabled : existing.enabled,
        notes: input.notes !== undefined ? input.notes : existing.notes,
        // addedAt preserved
      }
      state.entries = state.entries.map(e => automationKey(e) === key ? entry : e)
    } else {
      entry = {
        accountId,
        symbol,
        strategyName,
        params: input.params ?? {},
        enabled: input.enabled !== undefined ? input.enabled : true,
        notes: input.notes,
        addedAt: now,
      }
      state.entries = [...state.entries, entry]
    }

    await this.save(state)
    return entry
  }

  /** Remove an entry entirely. Returns true if it existed. */
  async remove(accountId: string, symbol: string, strategyName: string): Promise<boolean> {
    const key = automationKey({
      accountId,
      symbol: symbol.toUpperCase(),
      strategyName,
    })
    const state = await this.load()
    const before = state.entries.length
    state.entries = state.entries.filter(e => automationKey(e) !== key)
    const changed = state.entries.length !== before
    if (changed) await this.save(state)
    return changed
  }

  /** Convenience: flip enabled without touching params. */
  async setEnabled(
    accountId: string,
    symbol: string,
    strategyName: string,
    enabled: boolean,
  ): Promise<AutomationEntry | undefined> {
    const existing = await this.find(accountId, symbol, strategyName)
    if (!existing) return undefined
    return this.upsert({ accountId, symbol, strategyName, enabled })
  }

  // ==================== Persistence helpers ====================

  private async save(state: AutomationState): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const tmpPath = `${this.filePath}.${randomBytes(6).toString('hex')}.tmp`
    await writeFile(tmpPath, JSON.stringify(state, null, 2))
    await rename(tmpPath, this.filePath)
  }
}
