/**
 * Watchlist tool — i.e. AI-callable surface for the persistent
 * watchlist. The AI chat captures user intent ("watch NVDA, it's
 * showing strength") and calls these tools to remember the symbol.
 *
 * Global watchlist (broker-agnostic). Per-account automation
 * enable/disable lives elsewhere (Phase 3.7 automation worker).
 */

import { tool } from 'ai'
import { z } from 'zod'
import { WatchlistStore } from '@/domain/watchlist/store'

export function createWatchlistTools(store: WatchlistStore) {
  return {
    watchlistAdd: tool({
      description:
        'Add one or more symbols to the watchlist. Symbols are normalised ' +
        'to uppercase. If a symbol already exists, the call MERGES rather ' +
        'than replaces: `reason` and `notes` overwrite when provided, ' +
        '`tags` set-union into existing tags, and `addedAt` is preserved. ' +
        'Use this when the user mentions a symbol they want to track ' +
        '("I like NVDA", "add SPY to my watchlist", "watch META + AAPL ' +
        'for earnings"). Returns the added/updated entries.',
      inputSchema: z.object({
        symbols: z.array(z.string().min(1)).min(1).describe(
          'One or more ticker symbols (e.g. ["NVDA"], ["META", "AAPL"]).',
        ),
        reason: z.string().optional().describe(
          'Why this symbol matters now — set from chat context. Examples: ' +
          '"user-flagged AI strength", "earnings beat", "pullback to MA50".',
        ),
        tags: z.array(z.string()).optional().describe(
          'Categorical tags, lowercase by convention. Examples: ' +
          '["ai", "tech", "earnings-play"]. Useful for future filtering.',
        ),
        notes: z.string().optional().describe(
          'Free-form trader notes attached to the symbol.',
        ),
      }),
      execute: async ({ symbols, reason, tags, notes }) => {
        const added = []
        for (const symbol of symbols) {
          const entry = await store.add({ symbol, reason, tags, notes })
          added.push(entry)
        }
        return { ok: true, added }
      },
    }),

    watchlistRemove: tool({
      description:
        'Remove one or more symbols from the watchlist. Case-insensitive ' +
        'symbol matching. Returns the symbols that were actually removed ' +
        '(those that existed); silently ignores symbols that were not in ' +
        'the list. Use when the user says "drop NVDA from my watchlist" ' +
        'or "I no longer care about META".',
      inputSchema: z.object({
        symbols: z.array(z.string().min(1)).min(1).describe(
          'One or more ticker symbols to remove.',
        ),
      }),
      execute: async ({ symbols }) => {
        const removed: string[] = []
        const notFound: string[] = []
        for (const symbol of symbols) {
          const ok = await store.remove(symbol)
          if (ok) removed.push(symbol.toUpperCase())
          else notFound.push(symbol.toUpperCase())
        }
        return { ok: true, removed, notFound }
      },
    }),

    watchlistList: tool({
      description:
        'List all symbols on the watchlist with their metadata (addedAt, ' +
        'reason, tags, notes). Sorted by most-recently-added first. Use ' +
        'when the user asks "what am I watching?" or before deciding ' +
        'which symbols to backtest / trade.',
      inputSchema: z.object({}),
      execute: async () => {
        const entries = await store.list()
        // Newest first
        const sorted = [...entries].sort((a, b) =>
          b.addedAt.localeCompare(a.addedAt),
        )
        return { ok: true, count: sorted.length, entries: sorted }
      },
    }),
  }
}
