import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import type { AutomationEntry } from '../api/automation'
import { Toggle } from '../components/Toggle'

/**
 * Strategy automation section — i.e. the UI surface for managing
 * which (account, symbol, strategy) triples the worker should run.
 *
 * v1 scope: list + enable/disable toggle + delete + manual "run now".
 * Add / edit form is deferred — the user uses chat (AI tools) to
 * configure new entries for now.
 */
export function AutomationStrategySection() {
  const [entries, setEntries] = useState<AutomationEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tickRunning, setTickRunning] = useState(false)
  const [tickReport, setTickReport] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const { entries } = await api.automation.list()
      setEntries(entries)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    // Refresh every 10s — the worker may add / update entries via chat
    const id = setInterval(load, 10_000)
    return () => clearInterval(id)
  }, [load])

  const handleToggle = async (entry: AutomationEntry, next: boolean) => {
    try {
      await api.automation.setEnabled(entry.accountId, entry.symbol, entry.strategyName, next)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const handleDelete = async (entry: AutomationEntry) => {
    if (!confirm(
      `Remove automation for ${entry.symbol} (${entry.strategyName}) on ${entry.accountId}?\n\n` +
      `Params and notes will be lost. Disable instead if you want to keep them.`,
    )) return
    try {
      await api.automation.remove(entry.accountId, entry.symbol, entry.strategyName)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const handleTick = async () => {
    setTickRunning(true)
    setTickReport(null)
    try {
      const r = await api.automation.tick()
      const errSummary = r.errors.length > 0
        ? ` (${r.errors.length} error${r.errors.length > 1 ? 's' : ''})`
        : ''
      setTickReport(`Ran worker: ${r.processed} processed${errSummary}`)
      setTimeout(() => setTickReport(null), 5000)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setTickRunning(false)
    }
  }

  return (
    <div className="bg-bg rounded-lg border border-border">
      {/* ==================== Header ==================== */}
      <div className="px-4 py-3 border-b border-border flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-lg">🤖</span>
          <div>
            <div className="text-sm font-medium text-text">Strategy Automation</div>
            <div className="text-xs text-text-muted">
              Per-symbol strategy on/off. Worker runs on cron tick + below.
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {tickReport && (
            <span className="text-xs text-accent">{tickReport}</span>
          )}
          <button
            onClick={handleTick}
            disabled={tickRunning}
            className="btn-primary-sm"
            title="Run the strategy worker right now (skip the cron wait)"
          >
            {tickRunning ? 'Running…' : 'Run Now'}
          </button>
        </div>
      </div>

      {/* ==================== Body ==================== */}
      <div className="p-4">
        {loading ? (
          <div className="text-xs text-text-muted">Loading…</div>
        ) : error ? (
          <div className="text-xs text-red-400">
            {error}
            <button
              onClick={() => { setError(null); load() }}
              className="ml-2 text-text-muted hover:text-text"
            >
              Retry
            </button>
          </div>
        ) : entries.length === 0 ? (
          <div className="text-xs text-text-muted py-2">
            No automation entries yet. Ask the AI in chat to add one:
            <span className="block mt-1 text-text font-mono">
              "Enable leader-pullback-v1 on NVDA in paper-alpaca with 0.5% risk"
            </span>
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-text-muted text-left border-b border-border">
                <th className="py-2 pr-3">Account</th>
                <th className="py-2 pr-3">Symbol</th>
                <th className="py-2 pr-3">Strategy</th>
                <th className="py-2 pr-3">Params</th>
                <th className="py-2 pr-3">Enabled</th>
                <th className="py-2"></th>
              </tr>
            </thead>
            <tbody>
              {entries.map(e => (
                <tr
                  key={`${e.accountId}::${e.symbol}::${e.strategyName}`}
                  className="border-b border-border/40 hover:bg-bg-secondary/30"
                >
                  <td className="py-2 pr-3 text-text-muted">{e.accountId}</td>
                  <td className="py-2 pr-3 font-mono font-medium">{e.symbol}</td>
                  <td className="py-2 pr-3">{e.strategyName}</td>
                  <td className="py-2 pr-3 text-text-muted font-mono text-[11px]">
                    {Object.keys(e.params).length === 0
                      ? '(defaults)'
                      : Object.entries(e.params)
                          .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
                          .join(', ')}
                  </td>
                  <td className="py-2 pr-3">
                    <Toggle checked={e.enabled} onChange={(v) => handleToggle(e, v)} />
                  </td>
                  <td className="py-2 text-right">
                    <button
                      onClick={() => handleDelete(e)}
                      className="text-text-muted hover:text-red-400"
                      title="Remove this automation entry"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
