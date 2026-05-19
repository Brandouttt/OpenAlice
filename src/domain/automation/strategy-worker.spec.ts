import { describe, it, expect, vi } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { createStrategyWorker } from './strategy-worker.js'
import { AutomationStore } from './store.js'
import type { EquityClientLike } from '../market-data/client/types.js'
import type { UTAManager } from '../trading/uta-manager.js'
import type { CronEngine } from '../../task/cron/engine.js'
import type { ListenerRegistry } from '../../core/listener-registry.js'
import { MockBroker } from '../trading/brokers/mock/index.js'
import {
  register as registerStrategy,
  _resetRegistryForTests,
  smaCrossoverStrategy,
} from '../strategy/index.js'

/**
 * The worker calls EquityClient.getHistorical and UTAManager.get
 * and pokes the cron engine + listener registry. For unit tests we
 * stub all four — only the worker's own logic is under test.
 */

function mockEquityClient(rows: Array<{
  date: string
  open: number | null
  high: number | null
  low: number | null
  close: number | null
  volume: number | null
}>): EquityClientLike {
  return {
    search: vi.fn().mockResolvedValue([]),
    getHistorical: vi.fn().mockResolvedValue(rows),
    getProfile: vi.fn(),
    getKeyMetrics: vi.fn(),
    getIncomeStatement: vi.fn(),
    getBalanceSheet: vi.fn(),
    getCashFlow: vi.fn(),
    getFinancialRatios: vi.fn(),
    getEstimateConsensus: vi.fn(),
    getCalendarEarnings: vi.fn(),
    getInsiderTrading: vi.fn(),
    getGainers: vi.fn(),
    getLosers: vi.fn(),
    getActive: vi.fn(),
  } as unknown as EquityClientLike
}

function mockUtaManager(utas: Record<string, { broker: MockBroker; disabled?: boolean }>): UTAManager {
  return {
    get: vi.fn((id: string) => {
      const u = utas[id]
      if (!u) return undefined
      // GitTrackedBroker now routes placeOrder through uta.git +
      // uta.push(), and the worker reads uta.status() to detect
      // newly-pending HITL commits. Stub all three so the wrapper
      // path doesn't crash. The mock git is a no-op store —
      // intercepted orders are not actually persisted, which is
      // fine for these unit tests.
      const stagedOps: unknown[] = []
      let pendingHash: string | null = null
      let pendingMessage: string | null = null
      const fakeGit = {
        add: vi.fn((op: unknown) => {
          stagedOps.push(op)
        }),
        commit: vi.fn((message: string) => {
          pendingHash = 'mock' + (stagedOps.length).toString().padStart(4, '0')
          pendingMessage = message
        }),
      }
      return {
        broker: u.broker,
        disabled: u.disabled ?? false,
        id: 'mock-uta',
        git: fakeGit,
        status: () => ({
          staged: stagedOps,
          pendingMessage,
          pendingHash,
          head: null,
          commitCount: 0,
        }),
        push: vi.fn(async () => ({
          hash: pendingHash ?? '',
          message: pendingMessage ?? '',
          operationCount: stagedOps.length,
          submitted: [{
            action: 'placeOrder',
            success: true,
            status: 'submitted',
            orderId: 'mock-1',
          }],
          rejected: [],
        })),
      }
    }),
  } as unknown as UTAManager
}

function mockCronEngine(): CronEngine {
  return {
    list: vi.fn().mockReturnValue([]),
    add: vi.fn().mockResolvedValue('job-1'),
    update: vi.fn().mockResolvedValue(undefined),
  } as unknown as CronEngine
}

function mockRegistry(): ListenerRegistry {
  return {
    register: vi.fn(),
    unregister: vi.fn(),
  } as unknown as ListenerRegistry
}

async function withStore<T>(fn: (store: AutomationStore) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'automation-worker-test-'))
  const store = new AutomationStore({ filePath: join(dir, 'strategies.json') })
  try {
    return await fn(store)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// Build N+ bars of flat-then-rising daily data — enough to satisfy
// the sma-crossover warmup (51 bars) without triggering an entry.
function flatBars(count: number, startPrice = 100): Array<{
  date: string; open: number; high: number; low: number; close: number; volume: number
}> {
  const out = []
  let cursor = new Date('2024-01-02T00:00:00Z')
  for (let i = 0; i < count; i++) {
    while (cursor.getUTCDay() === 0 || cursor.getUTCDay() === 6) {
      cursor = new Date(cursor.getTime() + 86_400_000)
    }
    out.push({
      date: cursor.toISOString().slice(0, 10),
      open: startPrice,
      high: startPrice * 1.005,
      low: startPrice * 0.995,
      close: startPrice,
      volume: 1_000_000,
    })
    cursor = new Date(cursor.getTime() + 86_400_000)
  }
  return out
}

// ==================== tick — happy path ====================

describe('strategy-worker tick', () => {
  it('processes 0 entries when nothing is enabled', async () => {
    await withStore(async (store) => {
      // Ensure registry is in a known state for tests that need
      // strategy lookup; this test doesn't use it but cleans up.
      _resetRegistryForTests()
      registerStrategy(smaCrossoverStrategy)

      const worker = createStrategyWorker({
        store,
        utaManager: mockUtaManager({}),
        equityClient: mockEquityClient([]),
        cronEngine: mockCronEngine(),
        registry: mockRegistry(),
        config: { enabled: true, every: '1h' },
      })

      const report = await worker.tick()
      expect(report.processed).toBe(0)
      expect(report.errors).toEqual([])
    })
  })

  it('skips disabled entries', async () => {
    await withStore(async (store) => {
      _resetRegistryForTests()
      registerStrategy(smaCrossoverStrategy)

      await store.upsert({
        accountId: 'paper-mock',
        symbol: 'NVDA',
        strategyName: 'sma-crossover',
        enabled: false, // disabled
      })

      const worker = createStrategyWorker({
        store,
        utaManager: mockUtaManager({
          'paper-mock': { broker: new MockBroker() },
        }),
        equityClient: mockEquityClient(flatBars(60)),
        cronEngine: mockCronEngine(),
        registry: mockRegistry(),
        config: { enabled: true, every: '1h' },
      })

      const report = await worker.tick()
      expect(report.processed).toBe(0)
    })
  })

  it('processes one enabled entry with flat data and no errors', async () => {
    await withStore(async (store) => {
      _resetRegistryForTests()
      registerStrategy(smaCrossoverStrategy)

      await store.upsert({
        accountId: 'paper-mock',
        symbol: 'NVDA',
        strategyName: 'sma-crossover',
        params: { fast: 5, slow: 20, qty: 10 },
        enabled: true,
      })

      const broker = new MockBroker({ cash: 10_000 })
      const worker = createStrategyWorker({
        store,
        utaManager: mockUtaManager({ 'paper-mock': { broker } }),
        equityClient: mockEquityClient(flatBars(60)),
        cronEngine: mockCronEngine(),
        registry: mockRegistry(),
        config: { enabled: true, every: '1h' },
      })

      const report = await worker.tick()
      expect(report.processed).toBe(1)
      expect(report.errors).toEqual([])
    })
  })

  it('reports an error when UTA is missing instead of dying', async () => {
    await withStore(async (store) => {
      _resetRegistryForTests()
      registerStrategy(smaCrossoverStrategy)

      await store.upsert({
        accountId: 'no-such-uta',
        symbol: 'NVDA',
        strategyName: 'sma-crossover',
        enabled: true,
      })

      const worker = createStrategyWorker({
        store,
        utaManager: mockUtaManager({}), // no UTAs
        equityClient: mockEquityClient(flatBars(60)),
        cronEngine: mockCronEngine(),
        registry: mockRegistry(),
        config: { enabled: true, every: '1h' },
      })

      const report = await worker.tick()
      expect(report.processed).toBe(0)
      expect(report.errors).toHaveLength(1)
      expect(report.errors[0].error).toMatch(/UTA not found/)
    })
  })

  it('reports an error when strategy is unknown', async () => {
    await withStore(async (store) => {
      _resetRegistryForTests()
      // Don't register any strategy this time

      await store.upsert({
        accountId: 'paper-mock',
        symbol: 'NVDA',
        strategyName: 'nonexistent-strategy',
        enabled: true,
      })

      const worker = createStrategyWorker({
        store,
        utaManager: mockUtaManager({
          'paper-mock': { broker: new MockBroker() },
        }),
        equityClient: mockEquityClient(flatBars(60)),
        cronEngine: mockCronEngine(),
        registry: mockRegistry(),
        config: { enabled: true, every: '1h' },
      })

      const report = await worker.tick()
      expect(report.errors[0].error).toMatch(/Unknown strategy/)
    })
  })

  it('reports an error when too few bars come back', async () => {
    await withStore(async (store) => {
      _resetRegistryForTests()
      registerStrategy(smaCrossoverStrategy)

      await store.upsert({
        accountId: 'paper-mock',
        symbol: 'NVDA',
        strategyName: 'sma-crossover',
        enabled: true,
      })

      const worker = createStrategyWorker({
        store,
        utaManager: mockUtaManager({
          'paper-mock': { broker: new MockBroker() },
        }),
        equityClient: mockEquityClient([]), // empty data
        cronEngine: mockCronEngine(),
        registry: mockRegistry(),
        config: { enabled: true, every: '1h' },
      })

      const report = await worker.tick()
      expect(report.errors[0].error).toMatch(/Insufficient bars/)
    })
  })

  it('reuses strategy closures across ticks (cache survives within process)', async () => {
    await withStore(async (store) => {
      _resetRegistryForTests()
      // Spy factory so we can count how many closures are built.
      let factoryCount = 0
      registerStrategy({
        metadata: smaCrossoverStrategy.metadata,
        factory: (params) => {
          factoryCount++
          return smaCrossoverStrategy.factory(params)
        },
      })

      await store.upsert({
        accountId: 'paper-mock',
        symbol: 'NVDA',
        strategyName: 'sma-crossover',
        enabled: true,
      })

      const worker = createStrategyWorker({
        store,
        utaManager: mockUtaManager({
          'paper-mock': { broker: new MockBroker() },
        }),
        equityClient: mockEquityClient(flatBars(60)),
        cronEngine: mockCronEngine(),
        registry: mockRegistry(),
        config: { enabled: true, every: '1h' },
      })

      await worker.tick()
      await worker.tick()
      await worker.tick()

      // Built once on first tick, reused after.
      expect(factoryCount).toBe(1)
    })
  })
})

// ==================== start / stop ====================

describe('strategy-worker start / stop', () => {
  it('start adds the cron job and registers the listener', async () => {
    await withStore(async (store) => {
      _resetRegistryForTests()
      registerStrategy(smaCrossoverStrategy)

      const cronEngine = mockCronEngine()
      const registry = mockRegistry()
      const worker = createStrategyWorker({
        store,
        utaManager: mockUtaManager({}),
        equityClient: mockEquityClient([]),
        cronEngine,
        registry,
        config: { enabled: true, every: '1h' },
      })

      await worker.start()
      expect(cronEngine.add).toHaveBeenCalled()
      expect(registry.register).toHaveBeenCalled()
    })
  })

  it('stop unregisters the listener', async () => {
    await withStore(async (store) => {
      _resetRegistryForTests()
      registerStrategy(smaCrossoverStrategy)

      const registry = mockRegistry()
      const worker = createStrategyWorker({
        store,
        utaManager: mockUtaManager({}),
        equityClient: mockEquityClient([]),
        cronEngine: mockCronEngine(),
        registry,
        config: { enabled: true, every: '1h' },
      })

      await worker.start()
      worker.stop()
      expect(registry.unregister).toHaveBeenCalled()
    })
  })

  it('does NOT overwrite an existing cron job (user enable state preserved across restarts)', async () => {
    // The original bug: every restart called cronEngine.update with
    // config.enabled, silently turning OFF the user's automation
    // because main.ts hard-codes config.enabled=false at boot. This
    // test pins the fix: when the cron job already exists, leave it
    // alone.
    await withStore(async (store) => {
      _resetRegistryForTests()
      registerStrategy(smaCrossoverStrategy)

      // Simulate "the cron job is already there from a previous run"
      const existingJob = { id: 'job-1', name: '__strategy-worker__' }
      const cronEngine = {
        list: vi.fn().mockReturnValue([existingJob]),
        add: vi.fn().mockResolvedValue('job-1'),
        update: vi.fn().mockResolvedValue(undefined),
      } as unknown as Parameters<typeof createStrategyWorker>[0]['cronEngine']

      const worker = createStrategyWorker({
        store,
        utaManager: mockUtaManager({}),
        equityClient: mockEquityClient([]),
        cronEngine,
        registry: mockRegistry(),
        // config.enabled=false should NOT clobber the existing job
        config: { enabled: false, every: '1h' },
      })

      await worker.start()
      expect(cronEngine.update).not.toHaveBeenCalled()
      expect(cronEngine.add).not.toHaveBeenCalled()
    })
  })
})
