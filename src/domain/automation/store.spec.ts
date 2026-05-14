import { describe, it, expect } from 'vitest'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { AutomationStore } from './store.js'

async function newStore() {
  const dir = await mkdtemp(join(tmpdir(), 'automation-test-'))
  const store = new AutomationStore({ filePath: join(dir, 'strategies.json') })
  return {
    dir,
    store,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}

async function withStore<T>(fn: (store: AutomationStore, dir: string) => Promise<T>): Promise<T> {
  const ctx = await newStore()
  try {
    return await fn(ctx.store, ctx.dir)
  } finally {
    await ctx.cleanup()
  }
}

// ==================== load ====================

describe('AutomationStore.load', () => {
  it('returns empty when file does not exist', async () => {
    await withStore(async (store) => {
      const state = await store.load()
      expect(state.entries).toEqual([])
      expect(state.version).toBe(1)
    })
  })

  it('returns empty on corrupt JSON', async () => {
    await withStore(async (store, dir) => {
      await writeFile(join(dir, 'strategies.json'), '{ not json')
      const state = await store.load()
      expect(state.entries).toEqual([])
    })
  })

  it('returns empty on wrong-shape JSON (version != 1)', async () => {
    await withStore(async (store, dir) => {
      await writeFile(join(dir, 'strategies.json'), JSON.stringify({ version: 99 }))
      const state = await store.load()
      expect(state.entries).toEqual([])
    })
  })
})

// ==================== upsert ====================

describe('AutomationStore.upsert', () => {
  it('inserts a new entry with enabled=true by default', async () => {
    await withStore(async (store) => {
      const entry = await store.upsert({
        accountId: 'paper-alpaca',
        symbol: 'nvda',
        strategyName: 'leader-pullback-v1',
      })
      expect(entry.enabled).toBe(true)
      expect(entry.symbol).toBe('NVDA') // uppercase normalised
      expect(entry.params).toEqual({})
    })
  })

  it('respects enabled=false on first insert', async () => {
    await withStore(async (store) => {
      const entry = await store.upsert({
        accountId: 'paper-alpaca',
        symbol: 'NVDA',
        strategyName: 'leader-pullback-v1',
        enabled: false,
      })
      expect(entry.enabled).toBe(false)
    })
  })

  it('rejects empty accountId / symbol / strategyName', async () => {
    await withStore(async (store) => {
      await expect(
        store.upsert({ accountId: '', symbol: 'NVDA', strategyName: 'sma-crossover' }),
      ).rejects.toThrow(/accountId/)
      await expect(
        store.upsert({ accountId: 'paper', symbol: '', strategyName: 'sma-crossover' }),
      ).rejects.toThrow(/symbol/)
      await expect(
        store.upsert({ accountId: 'paper', symbol: 'NVDA', strategyName: '' }),
      ).rejects.toThrow(/strategyName/)
    })
  })

  it('preserves addedAt when re-upserting same triple', async () => {
    await withStore(async (store) => {
      const first = new Date('2024-06-15T14:00:00Z')
      const second = new Date('2024-06-20T14:00:00Z')

      await store.upsert({
        accountId: 'paper-alpaca',
        symbol: 'NVDA',
        strategyName: 'leader-pullback-v1',
        now: () => first,
      })
      await store.upsert({
        accountId: 'paper-alpaca',
        symbol: 'NVDA',
        strategyName: 'leader-pullback-v1',
        params: { riskPerTradePct: 0.5 },
        now: () => second,
      })

      const entries = await store.list()
      expect(entries).toHaveLength(1)
      expect(entries[0].addedAt).toBe('2024-06-15T14:00:00.000Z')
      expect(entries[0].params).toEqual({ riskPerTradePct: 0.5 })
    })
  })

  it('treats different strategy names on same symbol as separate rows', async () => {
    await withStore(async (store) => {
      await store.upsert({
        accountId: 'paper-alpaca',
        symbol: 'NVDA',
        strategyName: 'leader-pullback-v1',
      })
      await store.upsert({
        accountId: 'paper-alpaca',
        symbol: 'NVDA',
        strategyName: 'sma-crossover',
      })
      const entries = await store.list()
      expect(entries).toHaveLength(2)
    })
  })

  it('treats different accountId on same symbol as separate rows', async () => {
    await withStore(async (store) => {
      await store.upsert({
        accountId: 'paper-alpaca',
        symbol: 'NVDA',
        strategyName: 'leader-pullback-v1',
      })
      await store.upsert({
        accountId: 'ibkr-live',
        symbol: 'NVDA',
        strategyName: 'leader-pullback-v1',
      })
      const entries = await store.list()
      expect(entries).toHaveLength(2)
    })
  })

  it('persists across instances', async () => {
    await withStore(async (store, dir) => {
      await store.upsert({
        accountId: 'paper-alpaca',
        symbol: 'NVDA',
        strategyName: 'leader-pullback-v1',
        params: { atrMultiplier: 2 },
      })
      const store2 = new AutomationStore({ filePath: join(dir, 'strategies.json') })
      const entries = await store2.list()
      expect(entries).toHaveLength(1)
      expect(entries[0].params).toEqual({ atrMultiplier: 2 })
    })
  })
})

// ==================== filters ====================

describe('AutomationStore filters', () => {
  it('listForAccount returns only that account\'s entries', async () => {
    await withStore(async (store) => {
      await store.upsert({ accountId: 'paper', symbol: 'NVDA', strategyName: 's1' })
      await store.upsert({ accountId: 'paper', symbol: 'META', strategyName: 's1' })
      await store.upsert({ accountId: 'live', symbol: 'NVDA', strategyName: 's1' })

      const paper = await store.listForAccount('paper')
      expect(paper.map(e => e.symbol).sort()).toEqual(['META', 'NVDA'])
    })
  })

  it('listEnabled returns only enabled entries', async () => {
    await withStore(async (store) => {
      await store.upsert({ accountId: 'paper', symbol: 'NVDA', strategyName: 's1', enabled: true })
      await store.upsert({ accountId: 'paper', symbol: 'META', strategyName: 's1', enabled: false })

      const enabled = await store.listEnabled()
      expect(enabled.map(e => e.symbol)).toEqual(['NVDA'])
    })
  })

  it('find returns the entry case-insensitively on symbol', async () => {
    await withStore(async (store) => {
      await store.upsert({ accountId: 'paper', symbol: 'NVDA', strategyName: 's1' })
      const e = await store.find('paper', 'nvda', 's1')
      expect(e?.symbol).toBe('NVDA')
    })
  })

  it('find returns undefined when missing', async () => {
    await withStore(async (store) => {
      expect(await store.find('paper', 'XYZ', 's1')).toBeUndefined()
    })
  })
})

// ==================== setEnabled ====================

describe('AutomationStore.setEnabled', () => {
  it('flips enabled flag in place', async () => {
    await withStore(async (store) => {
      await store.upsert({ accountId: 'paper', symbol: 'NVDA', strategyName: 's1', enabled: true })
      const updated = await store.setEnabled('paper', 'NVDA', 's1', false)
      expect(updated?.enabled).toBe(false)

      const reread = await store.find('paper', 'NVDA', 's1')
      expect(reread?.enabled).toBe(false)
    })
  })

  it('returns undefined when entry missing (no insert side-effect)', async () => {
    await withStore(async (store) => {
      const result = await store.setEnabled('paper', 'XYZ', 's1', false)
      expect(result).toBeUndefined()
      expect(await store.list()).toEqual([])
    })
  })
})

// ==================== remove ====================

describe('AutomationStore.remove', () => {
  it('removes an existing triple and returns true', async () => {
    await withStore(async (store) => {
      await store.upsert({ accountId: 'paper', symbol: 'NVDA', strategyName: 's1' })
      await store.upsert({ accountId: 'paper', symbol: 'META', strategyName: 's1' })
      const removed = await store.remove('paper', 'NVDA', 's1')
      expect(removed).toBe(true)

      const entries = await store.list()
      expect(entries.map(e => e.symbol)).toEqual(['META'])
    })
  })

  it('returns false when triple is not present', async () => {
    await withStore(async (store) => {
      expect(await store.remove('paper', 'XYZ', 's1')).toBe(false)
    })
  })
})
