import { fetchJson, headers } from './client'

/**
 * One row in the automation config — (account, symbol, strategy)
 * triple plus state. Mirrors the backend's AutomationEntry shape.
 */
export interface AutomationEntry {
  accountId: string
  symbol: string
  strategyName: string
  params: Record<string, unknown>
  enabled: boolean
  addedAt: string
  notes?: string
}

export interface AutomationListResponse {
  entries: AutomationEntry[]
}

export interface AutomationUpsertResponse {
  entry: AutomationEntry
}

export interface AutomationDeleteResponse {
  removed: boolean
}

export interface AutomationTickResponse {
  processed: number
  errors: Array<{
    entry: AutomationEntry
    error: string
  }>
}

export interface AutomationUpsertInput {
  accountId: string
  symbol: string
  strategyName: string
  params?: Record<string, unknown>
  enabled?: boolean
  notes?: string
}

export const automationApi = {
  /** List all automation entries. Optional filters. */
  async list(opts: { accountId?: string; enabledOnly?: boolean } = {}): Promise<AutomationListResponse> {
    const qs = new URLSearchParams()
    if (opts.accountId) qs.set('account', opts.accountId)
    if (opts.enabledOnly) qs.set('enabled', 'true')
    const q = qs.toString()
    return fetchJson(`/api/automation${q ? `?${q}` : ''}`)
  },

  /** Insert or merge an entry. Symbol is uppercased server-side. */
  async upsert(input: AutomationUpsertInput): Promise<AutomationUpsertResponse> {
    return fetchJson('/api/automation', {
      method: 'POST',
      headers,
      body: JSON.stringify(input),
    })
  },

  /** Remove an entry entirely. */
  async remove(accountId: string, symbol: string, strategyName: string): Promise<AutomationDeleteResponse> {
    return fetchJson(
      `/api/automation/${encodeURIComponent(accountId)}/${encodeURIComponent(symbol)}/${encodeURIComponent(strategyName)}`,
      { method: 'DELETE' },
    )
  },

  /** Flip enabled flag without touching params. */
  async setEnabled(
    accountId: string,
    symbol: string,
    strategyName: string,
    enabled: boolean,
  ): Promise<AutomationUpsertResponse> {
    return fetchJson(
      `/api/automation/${encodeURIComponent(accountId)}/${encodeURIComponent(symbol)}/${encodeURIComponent(strategyName)}/enabled`,
      {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ enabled }),
      },
    )
  },

  /** Trigger the strategy worker right now (manual "run" button). */
  async tick(): Promise<AutomationTickResponse> {
    return fetchJson('/api/automation/tick', { method: 'POST' })
  },
}
