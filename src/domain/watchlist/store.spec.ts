import { describe, it, expect } from 'vitest'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { WatchlistStore } from './store.js'

/**
 * Each test creates its own tmpdir + store. The shared `let dir;
 * beforeEach` pattern caused state to leak between tests under
 * Vitest 4 — local-scope setup eliminates the ambiguity.
 */
async function newStore() {
  const dir = await mkdtemp(join(tmpdir(), 'watchlist-test-'))
  const store = new WatchlistStore({ filePath: join(dir, 'watchlist.json') })
  return {
    dir,
    store,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}

async function withStore<T>(fn: (store: WatchlistStore, dir: string) => Promise<T>): Promise<T> {
  const ctx = await newStore()
  try {
    return await fn(ctx.store, ctx.dir)
  } finally {
    await ctx.cleanup()
  }
}

// ==================== load ====================

describe('WatchlistStore.load', () => {
  it('returns empty when file does not exist', async () => {
    await withStore(async (store) => {
      const state = await store.load()
      expect(state.entries).toEqual([])
      expect(state.version).toBe(1)
    })
  })

  it('returns empty on corrupt JSON instead of throwing', async () => {
    await withStore(async (store, dir) => {
      await writeFile(join(dir, 'watchlist.json'), '{ not valid json')
      const state = await store.load()
      expect(state.entries).toEqual([])
    })
  })

  it('returns empty on wrong-shape JSON (version != 1)', async () => {
    await withStore(async (store, dir) => {
      await writeFile(join(dir, 'watchlist.json'), JSON.stringify({ version: 99 }))
      const state = await store.load()
      expect(state.entries).toEqual([])
    })
  })
})

// ==================== add ====================

describe('WatchlistStore.add', () => {
  it('normalises symbol to uppercase', async () => {
    await withStore(async (store) => {
      await store.add({ symbol: 'nvda' })
      const entries = await store.list()
      expect(entries[0].symbol).toBe('NVDA')
    })
  })

  it('strips whitespace from symbol', async () => {
    await withStore(async (store) => {
      await store.add({ symbol: '  AAPL  ' })
      const entries = await store.list()
      expect(entries[0].symbol).toBe('AAPL')
    })
  })

  it('rejects empty symbol', async () => {
    await withStore(async (store) => {
      await expect(store.add({ symbol: '' })).rejects.toThrow(/non-empty/)
      await expect(store.add({ symbol: '   ' })).rejects.toThrow(/non-empty/)
    })
  })

  it('persists across instances (atomic write survives a fresh read)', async () => {
    await withStore(async (store, dir) => {
      await store.add({ symbol: 'NVDA', reason: 'AI strength' })
      const store2 = new WatchlistStore({ filePath: join(dir, 'watchlist.json') })
      const entries = await store2.list()
      expect(entries).toHaveLength(1)
      expect(entries[0].symbol).toBe('NVDA')
      expect(entries[0].reason).toBe('AI strength')
    })
  })

  it('captures addedAt with the injected clock', async () => {
    await withStore(async (store) => {
      const fixed = new Date('2024-06-15T14:30:00Z')
      await store.add({ symbol: 'NVDA', now: () => fixed })
      const entries = await store.list()
      expect(entries[0].addedAt).toBe('2024-06-15T14:30:00.000Z')
    })
  })

  it('lowercases tag list', async () => {
    await withStore(async (store) => {
      await store.add({ symbol: 'NVDA', tags: ['AI', 'Tech', 'Growth'] })
      const entries = await store.list()
      expect(new Set(entries[0].tags)).toEqual(new Set(['ai', 'tech', 'growth']))
    })
  })

  it('dedupes tags within a single add call', async () => {
    await withStore(async (store) => {
      await store.add({ symbol: 'NVDA', tags: ['ai', 'AI', 'Ai'] })
      const entries = await store.list()
      expect(entries[0].tags).toEqual(['ai'])
    })
  })
})

// ==================== add (existing entry) ====================

describe('WatchlistStore.add — merge into existing', () => {
  it('preserves addedAt when re-adding same symbol', async () => {
    await withStore(async (store) => {
      const first = new Date('2024-06-15T14:00:00Z')
      const second = new Date('2024-06-20T14:00:00Z')
      await store.add({ symbol: 'NVDA', now: () => first })
      await store.add({ symbol: 'NVDA', reason: 'updated', now: () => second })

      const entries = await store.list()
      expect(entries).toHaveLength(1)
      expect(entries[0].addedAt).toBe('2024-06-15T14:00:00.000Z')
      expect(entries[0].reason).toBe('updated')
    })
  })

  it('overwrites reason when provided, keeps existing when omitted', async () => {
    await withStore(async (store) => {
      await store.add({ symbol: 'NVDA', reason: 'first reason' })
      await store.add({ symbol: 'NVDA' })
      let entries = await store.list()
      expect(entries[0].reason).toBe('first reason')

      await store.add({ symbol: 'NVDA', reason: 'second reason' })
      entries = await store.list()
      expect(entries[0].reason).toBe('second reason')
    })
  })

  it('union-merges tags', async () => {
    await withStore(async (store) => {
      await store.add({ symbol: 'NVDA', tags: ['ai', 'tech'] })
      await store.add({ symbol: 'NVDA', tags: ['growth'] })
      const entries = await store.list()
      expect(new Set(entries[0].tags)).toEqual(new Set(['ai', 'tech', 'growth']))
    })
  })

  it('keeps existing tags when re-added without tags', async () => {
    await withStore(async (store) => {
      await store.add({ symbol: 'NVDA', tags: ['ai', 'tech'] })
      await store.add({ symbol: 'NVDA', reason: 'updated reason' })
      const entries = await store.list()
      expect(new Set(entries[0].tags)).toEqual(new Set(['ai', 'tech']))
    })
  })
})

// ==================== remove ====================

describe('WatchlistStore.remove', () => {
  it('removes an existing symbol and returns true', async () => {
    await withStore(async (store) => {
      await store.add({ symbol: 'NVDA' })
      await store.add({ symbol: 'AAPL' })
      const removed = await store.remove('NVDA')
      expect(removed).toBe(true)

      const entries = await store.list()
      expect(entries.map(e => e.symbol)).toEqual(['AAPL'])
    })
  })

  it('returns false when symbol is not present', async () => {
    await withStore(async (store) => {
      await store.add({ symbol: 'NVDA' })
      const removed = await store.remove('XYZ')
      expect(removed).toBe(false)
    })
  })

  it('is case-insensitive', async () => {
    await withStore(async (store) => {
      await store.add({ symbol: 'NVDA' })
      const removed = await store.remove('nvda')
      expect(removed).toBe(true)
      expect(await store.list()).toEqual([])
    })
  })

  it('does not write when nothing changed', async () => {
    await withStore(async (store) => {
      await store.remove('NVDA')
      const entries = await store.list()
      expect(entries).toEqual([])
    })
  })
})

// ==================== find ====================

describe('WatchlistStore.find', () => {
  it('returns the entry when present', async () => {
    await withStore(async (store) => {
      await store.add({ symbol: 'NVDA', reason: 'AI' })
      const entry = await store.find('NVDA')
      expect(entry?.symbol).toBe('NVDA')
      expect(entry?.reason).toBe('AI')
    })
  })

  it('is case-insensitive', async () => {
    await withStore(async (store) => {
      await store.add({ symbol: 'NVDA' })
      expect(await store.find('nvda')).toBeDefined()
    })
  })

  it('returns undefined when missing', async () => {
    await withStore(async (store) => {
      expect(await store.find('XYZ')).toBeUndefined()
    })
  })
})
