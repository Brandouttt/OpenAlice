import { describe, it, expect } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { createWatchlistTools } from './watchlist.js'
import { WatchlistStore } from '@/domain/watchlist/store'

// ==================== Setup ====================

async function newTools() {
  const dir = await mkdtemp(join(tmpdir(), 'watchlist-tool-test-'))
  const store = new WatchlistStore({ filePath: join(dir, 'watchlist.json') })
  const tools = createWatchlistTools(store)
  return {
    tools,
    store,
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}

async function withTools<T>(
  fn: (ctx: Awaited<ReturnType<typeof newTools>>) => Promise<T>,
): Promise<T> {
  const ctx = await newTools()
  try {
    return await fn(ctx)
  } finally {
    await ctx.cleanup()
  }
}

// Vercel AI SDK tool's execute has a complex generic type. Cast to a
// callable for testing — we're invoking the same way the agent would.
type ToolExecute<I, O> = (input: I, ctx: unknown) => Promise<O>

// ==================== watchlistAdd ====================

describe('watchlistAdd', () => {
  it('adds a single symbol and returns the entry', async () => {
    await withTools(async ({ tools }) => {
      const exec = tools.watchlistAdd.execute as ToolExecute<
        { symbols: string[]; reason?: string; tags?: string[]; notes?: string },
        { ok: boolean; added: Array<{ symbol: string; reason?: string }> }
      >
      const result = await exec({ symbols: ['nvda'], reason: 'AI strength' }, {})
      expect(result.ok).toBe(true)
      expect(result.added).toHaveLength(1)
      expect(result.added[0].symbol).toBe('NVDA')
      expect(result.added[0].reason).toBe('AI strength')
    })
  })

  it('adds multiple symbols in one call', async () => {
    await withTools(async ({ tools, store }) => {
      const exec = tools.watchlistAdd.execute as ToolExecute<
        { symbols: string[] },
        { ok: boolean; added: Array<{ symbol: string }> }
      >
      const result = await exec({ symbols: ['NVDA', 'META', 'AAPL'] }, {})
      expect(result.added.map(e => e.symbol)).toEqual(['NVDA', 'META', 'AAPL'])

      const stored = await store.list()
      expect(stored).toHaveLength(3)
    })
  })

  it('propagates tags and notes through to storage', async () => {
    await withTools(async ({ tools, store }) => {
      const exec = tools.watchlistAdd.execute as ToolExecute<
        { symbols: string[]; tags?: string[]; notes?: string },
        unknown
      >
      await exec({
        symbols: ['NVDA'],
        tags: ['ai', 'tech'],
        notes: 'watch into earnings',
      }, {})

      const entry = await store.find('NVDA')
      expect(new Set(entry?.tags)).toEqual(new Set(['ai', 'tech']))
      expect(entry?.notes).toBe('watch into earnings')
    })
  })

  it('merge-updates an existing symbol rather than duplicating', async () => {
    await withTools(async ({ tools, store }) => {
      const exec = tools.watchlistAdd.execute as ToolExecute<
        { symbols: string[]; tags?: string[] },
        unknown
      >
      await exec({ symbols: ['NVDA'], tags: ['ai'] }, {})
      await exec({ symbols: ['NVDA'], tags: ['growth'] }, {})

      const list = await store.list()
      expect(list).toHaveLength(1)
      expect(new Set(list[0].tags)).toEqual(new Set(['ai', 'growth']))
    })
  })
})

// ==================== watchlistRemove ====================

describe('watchlistRemove', () => {
  it('removes existing symbols and reports them', async () => {
    await withTools(async ({ tools, store }) => {
      await store.add({ symbol: 'NVDA' })
      await store.add({ symbol: 'META' })

      const exec = tools.watchlistRemove.execute as ToolExecute<
        { symbols: string[] },
        { ok: boolean; removed: string[]; notFound: string[] }
      >
      const result = await exec({ symbols: ['nvda'] }, {})
      expect(result.removed).toEqual(['NVDA'])
      expect(result.notFound).toEqual([])

      expect(await store.list()).toHaveLength(1)
    })
  })

  it('reports notFound for symbols that were not in the list', async () => {
    await withTools(async ({ tools, store }) => {
      await store.add({ symbol: 'NVDA' })

      const exec = tools.watchlistRemove.execute as ToolExecute<
        { symbols: string[] },
        { removed: string[]; notFound: string[] }
      >
      const result = await exec({ symbols: ['NVDA', 'XYZ'] }, {})
      expect(result.removed).toEqual(['NVDA'])
      expect(result.notFound).toEqual(['XYZ'])
    })
  })
})

// ==================== watchlistList ====================

describe('watchlistList', () => {
  it('returns empty when nothing on the list', async () => {
    await withTools(async ({ tools }) => {
      const exec = tools.watchlistList.execute as ToolExecute<
        Record<string, never>,
        { ok: boolean; count: number; entries: unknown[] }
      >
      const result = await exec({}, {})
      expect(result.count).toBe(0)
      expect(result.entries).toEqual([])
    })
  })

  it('lists entries sorted newest-first', async () => {
    await withTools(async ({ tools, store }) => {
      await store.add({ symbol: 'NVDA', now: () => new Date('2024-06-15T10:00:00Z') })
      await store.add({ symbol: 'META', now: () => new Date('2024-06-15T12:00:00Z') })
      await store.add({ symbol: 'AAPL', now: () => new Date('2024-06-15T11:00:00Z') })

      const exec = tools.watchlistList.execute as ToolExecute<
        Record<string, never>,
        { count: number; entries: Array<{ symbol: string }> }
      >
      const result = await exec({}, {})
      expect(result.count).toBe(3)
      // Newest first: META (12:00) > AAPL (11:00) > NVDA (10:00)
      expect(result.entries.map(e => e.symbol)).toEqual(['META', 'AAPL', 'NVDA'])
    })
  })
})
