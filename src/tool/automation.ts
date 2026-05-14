/**
 * Automation tools — AI-callable surface to enable / disable / list /
 * configure the (account, symbol, strategy) automation entries that
 * the strategy worker (Phase 3.7b) will read.
 *
 * Typical chat flow:
 *
 *   You: "Auto-trade leader-pullback-v1 on NVDA in my paper account."
 *   AI:  automationEnable({
 *          accountId: "paper-alpaca",
 *          symbol: "NVDA",
 *          strategyName: "leader-pullback-v1",
 *          params: { riskPerTradePct: 0.5 }
 *        })
 *
 *   You: "Pause NVDA automation for now."
 *   AI:  automationDisable({
 *          accountId: "paper-alpaca",
 *          symbol: "NVDA",
 *          strategyName: "leader-pullback-v1"
 *        })
 *
 * Strategy names must match the strategy registry (Phase 1.5).
 * The tool validates against the registry before writing config —
 * misspelled names fail loud rather than getting silently saved.
 */

import { tool } from 'ai'
import { z } from 'zod'
import { AutomationStore } from '@/domain/automation/store'
import { getStrategy, listStrategies } from '@/domain/strategy/index'

export function createAutomationTools(store: AutomationStore) {
  return {
    automationEnable: tool({
      description:
        'Enable auto-trading on a (account, symbol, strategy) triple. ' +
        'Creates the entry if missing (enabled=true by default), or ' +
        'updates an existing one to enabled=true. Optional `params` ' +
        'override strategy defaults. Use when the user says ' +
        '"auto-trade NVDA with leader-pullback in my paper account" ' +
        'or "turn automation back on for META". Strategy name MUST ' +
        'match a registered strategy — call listStrategies tool first ' +
        'if unsure.',
      inputSchema: z.object({
        accountId: z.string().min(1).describe(
          'UTA account id, e.g. "paper-alpaca", "ibkr-live".',
        ),
        symbol: z.string().min(1).describe('Ticker symbol, e.g. "NVDA".'),
        strategyName: z.string().min(1).describe(
          'Registered strategy name, e.g. "leader-pullback-v1".',
        ),
        params: z.record(z.string(), z.unknown()).optional().describe(
          'Parameter overrides on top of the strategy defaults. ' +
          'Example: {"riskPerTradePct": 0.5, "atrMultiplier": 1.5}.',
        ),
        notes: z.string().optional().describe('Optional free-form trader notes.'),
      }),
      execute: async ({ accountId, symbol, strategyName, params, notes }) => {
        const registered = getStrategy(strategyName)
        if (!registered) {
          const available = listStrategies().map(s => s.name).join(', ')
          throw new Error(
            `Unknown strategy "${strategyName}". Registered: ${available || '(none)'}`,
          )
        }
        // Defensively try the factory so bad params surface immediately,
        // not at the worker's first tick.
        try {
          registered.factory({ ...registered.metadata.defaults, ...(params ?? {}) })
        } catch (err) {
          throw new Error(
            `Strategy "${strategyName}" rejected params: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
        const entry = await store.upsert({
          accountId,
          symbol,
          strategyName,
          params,
          enabled: true,
          notes,
        })
        return { ok: true, entry }
      },
    }),

    automationDisable: tool({
      description:
        'Disable an existing automation entry without deleting it. ' +
        'Params and notes are preserved so re-enabling later is one ' +
        'call. Returns ok:false (not an error) if no matching entry ' +
        'exists. Use when the user says "pause NVDA", "turn off SMA ' +
        'on AAPL", etc.',
      inputSchema: z.object({
        accountId: z.string().min(1),
        symbol: z.string().min(1),
        strategyName: z.string().min(1),
      }),
      execute: async ({ accountId, symbol, strategyName }) => {
        const updated = await store.setEnabled(accountId, symbol, strategyName, false)
        return updated
          ? { ok: true, entry: updated }
          : { ok: false, reason: 'no matching entry' as const }
      },
    }),

    automationRemove: tool({
      description:
        'Delete an automation entry entirely. Different from disable: ' +
        'remove forgets the params and notes too. Use when the user ' +
        'is sure they no longer want this combination at all.',
      inputSchema: z.object({
        accountId: z.string().min(1),
        symbol: z.string().min(1),
        strategyName: z.string().min(1),
      }),
      execute: async ({ accountId, symbol, strategyName }) => {
        const removed = await store.remove(accountId, symbol, strategyName)
        return { ok: removed, removed }
      },
    }),

    automationList: tool({
      description:
        'List all automation entries (enabled + disabled). Optional ' +
        'filters: by accountId, or only enabled. Use when the user ' +
        'asks "what\'s automated?" or before adding a new entry to ' +
        'check for duplicates.',
      inputSchema: z.object({
        accountId: z.string().optional().describe(
          'When set, return only this account\'s entries.',
        ),
        enabledOnly: z.boolean().default(false).describe(
          'When true, exclude disabled entries.',
        ),
      }),
      execute: async ({ accountId, enabledOnly }) => {
        let entries = accountId
          ? await store.listForAccount(accountId)
          : await store.list()
        if (enabledOnly) entries = entries.filter(e => e.enabled)
        return { ok: true, count: entries.length, entries }
      },
    }),

    automationSetParams: tool({
      description:
        'Replace the params on an existing automation entry. The new ' +
        'params object overwrites the old one wholesale (not merged) — ' +
        'pass the full param set you want, including unchanged keys. ' +
        'Validates against the strategy\'s factory before saving.',
      inputSchema: z.object({
        accountId: z.string().min(1),
        symbol: z.string().min(1),
        strategyName: z.string().min(1),
        params: z.record(z.string(), z.unknown()).describe(
          'Full param set. Strategy defaults are merged in by the worker.',
        ),
      }),
      execute: async ({ accountId, symbol, strategyName, params }) => {
        const registered = getStrategy(strategyName)
        if (!registered) {
          throw new Error(`Unknown strategy "${strategyName}"`)
        }
        try {
          registered.factory({ ...registered.metadata.defaults, ...params })
        } catch (err) {
          throw new Error(
            `Strategy "${strategyName}" rejected params: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
        const existing = await store.find(accountId, symbol, strategyName)
        if (!existing) {
          return { ok: false, reason: 'no matching entry' as const }
        }
        const updated = await store.upsert({
          accountId,
          symbol,
          strategyName,
          params,
        })
        return { ok: true, entry: updated }
      },
    }),
  }
}
