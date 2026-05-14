import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { createAutomationTools } from './automation.js'
import { AutomationStore } from '@/domain/automation/store'
import {
  register,
  _resetRegistryForTests,
  smaCrossoverStrategy,
  leaderPullbackV1Strategy,
} from '@/domain/strategy/index'

// Vercel AI SDK tool's `execute` has a complex generic. Cast to a
// callable for testing — we invoke the same way the agent would.
type ToolExecute<I, O> = (input: I, ctx: unknown) => Promise<O>

// ==================== Setup ====================

beforeAll(() => {
  _resetRegistryForTests()
  register(smaCrossoverStrategy)
  register(leaderPullbackV1Strategy)
})

async function newTools() {
  const dir = await mkdtemp(join(tmpdir(), 'automation-tool-test-'))
  const store = new AutomationStore({ filePath: join(dir, 'strategies.json') })
  const tools = createAutomationTools(store)
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

// ==================== automationEnable ====================

describe('automationEnable', () => {
  it('creates an entry with enabled=true', async () => {
    await withTools(async ({ tools, store }) => {
      const exec = tools.automationEnable.execute as ToolExecute<
        { accountId: string; symbol: string; strategyName: string; params?: Record<string, unknown>; notes?: string },
        { ok: boolean; entry: { accountId: string; symbol: string; enabled: boolean } }
      >
      const result = await exec(
        { accountId: 'paper-alpaca', symbol: 'NVDA', strategyName: 'sma-crossover' },
        {},
      )
      expect(result.ok).toBe(true)
      expect(result.entry.enabled).toBe(true)

      const stored = await store.list()
      expect(stored).toHaveLength(1)
    })
  })

  it('rejects unknown strategy name with a helpful error', async () => {
    await withTools(async ({ tools }) => {
      const exec = tools.automationEnable.execute as ToolExecute<
        { accountId: string; symbol: string; strategyName: string },
        unknown
      >
      await expect(
        exec(
          { accountId: 'paper-alpaca', symbol: 'NVDA', strategyName: 'no-such-strategy' },
          {},
        ),
      ).rejects.toThrow(/Unknown strategy/)
    })
  })

  it('rejects bad params by surfacing the strategy factory error', async () => {
    await withTools(async ({ tools }) => {
      const exec = tools.automationEnable.execute as ToolExecute<
        { accountId: string; symbol: string; strategyName: string; params: Record<string, unknown> },
        unknown
      >
      // sma-crossover requires fast < slow
      await expect(
        exec(
          {
            accountId: 'paper-alpaca',
            symbol: 'NVDA',
            strategyName: 'sma-crossover',
            params: { fast: 50, slow: 20, qty: 100 },
          },
          {},
        ),
      ).rejects.toThrow(/rejected params/)
    })
  })

  it('re-enables a previously-disabled entry without losing params', async () => {
    await withTools(async ({ tools, store }) => {
      // Seed: disabled with custom params
      await store.upsert({
        accountId: 'paper',
        symbol: 'NVDA',
        strategyName: 'sma-crossover',
        params: { fast: 5, slow: 20, qty: 100 },
        enabled: false,
      })

      const exec = tools.automationEnable.execute as ToolExecute<
        { accountId: string; symbol: string; strategyName: string },
        { ok: boolean; entry: { params: Record<string, unknown>; enabled: boolean } }
      >
      const result = await exec(
        { accountId: 'paper', symbol: 'NVDA', strategyName: 'sma-crossover' },
        {},
      )
      expect(result.entry.enabled).toBe(true)
      expect(result.entry.params).toEqual({ fast: 5, slow: 20, qty: 100 })
    })
  })
})

// ==================== automationDisable ====================

describe('automationDisable', () => {
  it('flips an existing entry to enabled=false', async () => {
    await withTools(async ({ tools, store }) => {
      await store.upsert({ accountId: 'paper', symbol: 'NVDA', strategyName: 'sma-crossover' })

      const exec = tools.automationDisable.execute as ToolExecute<
        { accountId: string; symbol: string; strategyName: string },
        { ok: boolean; entry?: { enabled: boolean } }
      >
      const result = await exec(
        { accountId: 'paper', symbol: 'NVDA', strategyName: 'sma-crossover' },
        {},
      )
      expect(result.ok).toBe(true)
      expect(result.entry?.enabled).toBe(false)
    })
  })

  it('returns ok:false (not error) when no matching entry', async () => {
    await withTools(async ({ tools }) => {
      const exec = tools.automationDisable.execute as ToolExecute<
        { accountId: string; symbol: string; strategyName: string },
        { ok: boolean; reason?: string }
      >
      const result = await exec(
        { accountId: 'paper', symbol: 'XYZ', strategyName: 'sma-crossover' },
        {},
      )
      expect(result.ok).toBe(false)
      expect(result.reason).toBe('no matching entry')
    })
  })
})

// ==================== automationList ====================

describe('automationList', () => {
  it('lists all entries by default', async () => {
    await withTools(async ({ tools, store }) => {
      await store.upsert({ accountId: 'paper', symbol: 'NVDA', strategyName: 'sma-crossover' })
      await store.upsert({ accountId: 'paper', symbol: 'META', strategyName: 'sma-crossover', enabled: false })

      const exec = tools.automationList.execute as ToolExecute<
        { accountId?: string; enabledOnly?: boolean },
        { count: number; entries: Array<{ symbol: string }> }
      >
      const result = await exec({ enabledOnly: false }, {})
      expect(result.count).toBe(2)
    })
  })

  it('filters by accountId', async () => {
    await withTools(async ({ tools, store }) => {
      await store.upsert({ accountId: 'paper', symbol: 'NVDA', strategyName: 'sma-crossover' })
      await store.upsert({ accountId: 'live', symbol: 'NVDA', strategyName: 'sma-crossover' })

      const exec = tools.automationList.execute as ToolExecute<
        { accountId?: string; enabledOnly?: boolean },
        { count: number; entries: Array<{ accountId: string }> }
      >
      const result = await exec({ accountId: 'paper', enabledOnly: false }, {})
      expect(result.count).toBe(1)
      expect(result.entries[0].accountId).toBe('paper')
    })
  })

  it('filters enabled-only', async () => {
    await withTools(async ({ tools, store }) => {
      await store.upsert({ accountId: 'paper', symbol: 'NVDA', strategyName: 'sma-crossover', enabled: true })
      await store.upsert({ accountId: 'paper', symbol: 'META', strategyName: 'sma-crossover', enabled: false })

      const exec = tools.automationList.execute as ToolExecute<
        { accountId?: string; enabledOnly?: boolean },
        { count: number; entries: Array<{ symbol: string }> }
      >
      const result = await exec({ enabledOnly: true }, {})
      expect(result.count).toBe(1)
      expect(result.entries[0].symbol).toBe('NVDA')
    })
  })
})

// ==================== automationSetParams ====================

describe('automationSetParams', () => {
  it('overwrites params wholesale on an existing entry', async () => {
    await withTools(async ({ tools, store }) => {
      await store.upsert({
        accountId: 'paper',
        symbol: 'NVDA',
        strategyName: 'sma-crossover',
        params: { fast: 10, slow: 30, qty: 100 },
      })

      const exec = tools.automationSetParams.execute as ToolExecute<
        { accountId: string; symbol: string; strategyName: string; params: Record<string, unknown> },
        { ok: boolean; entry?: { params: Record<string, unknown> } }
      >
      const result = await exec(
        {
          accountId: 'paper',
          symbol: 'NVDA',
          strategyName: 'sma-crossover',
          params: { fast: 5, slow: 20, qty: 50 },
        },
        {},
      )
      expect(result.ok).toBe(true)
      expect(result.entry?.params).toEqual({ fast: 5, slow: 20, qty: 50 })
    })
  })

  it('returns ok:false when no matching entry (does not auto-insert)', async () => {
    await withTools(async ({ tools, store }) => {
      const exec = tools.automationSetParams.execute as ToolExecute<
        { accountId: string; symbol: string; strategyName: string; params: Record<string, unknown> },
        { ok: boolean; reason?: string }
      >
      const result = await exec(
        {
          accountId: 'paper',
          symbol: 'XYZ',
          strategyName: 'sma-crossover',
          params: { fast: 5, slow: 20, qty: 100 },
        },
        {},
      )
      expect(result.ok).toBe(false)
      expect(await store.list()).toEqual([])
    })
  })

  it('rejects params that fail strategy factory validation', async () => {
    await withTools(async ({ tools, store }) => {
      await store.upsert({
        accountId: 'paper',
        symbol: 'NVDA',
        strategyName: 'sma-crossover',
        params: { fast: 10, slow: 30, qty: 100 },
      })
      const exec = tools.automationSetParams.execute as ToolExecute<
        { accountId: string; symbol: string; strategyName: string; params: Record<string, unknown> },
        unknown
      >
      await expect(
        exec(
          {
            accountId: 'paper',
            symbol: 'NVDA',
            strategyName: 'sma-crossover',
            params: { fast: 50, slow: 20, qty: 100 }, // fast >= slow
          },
          {},
        ),
      ).rejects.toThrow(/rejected params/)
    })
  })
})

// ==================== automationRemove ====================

describe('automationRemove', () => {
  it('removes an existing entry and returns ok:true', async () => {
    await withTools(async ({ tools, store }) => {
      await store.upsert({ accountId: 'paper', symbol: 'NVDA', strategyName: 'sma-crossover' })

      const exec = tools.automationRemove.execute as ToolExecute<
        { accountId: string; symbol: string; strategyName: string },
        { ok: boolean; removed: boolean }
      >
      const result = await exec(
        { accountId: 'paper', symbol: 'NVDA', strategyName: 'sma-crossover' },
        {},
      )
      expect(result.ok).toBe(true)
      expect(result.removed).toBe(true)
      expect(await store.list()).toEqual([])
    })
  })

  it('returns ok:false when missing', async () => {
    await withTools(async ({ tools }) => {
      const exec = tools.automationRemove.execute as ToolExecute<
        { accountId: string; symbol: string; strategyName: string },
        { ok: boolean; removed: boolean }
      >
      const result = await exec(
        { accountId: 'paper', symbol: 'XYZ', strategyName: 'sma-crossover' },
        {},
      )
      expect(result.ok).toBe(false)
      expect(result.removed).toBe(false)
    })
  })
})
