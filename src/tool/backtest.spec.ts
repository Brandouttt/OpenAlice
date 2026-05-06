import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { createBacktestTools } from './backtest.js'
import type { EquityClientLike } from '@/domain/market-data/client/types'
import {
  register,
  _resetRegistryForTests,
  smaCrossoverStrategy,
} from '@/domain/strategy/index'

// ==================== Helpers ====================

function makeMockEquityClient(historical: Array<{
  date: string
  open: number | null
  high: number | null
  low: number | null
  close: number | null
  volume: number | null
}>): EquityClientLike {
  return {
    search: vi.fn().mockResolvedValue([]),
    getHistorical: vi.fn().mockResolvedValue(historical),
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

function makeBars(prices: number[], startDate = '2024-01-02') {
  // Skip weekends so timestamps look realistic; same shape yfinance returns.
  const out: Array<{
    date: string
    open: number
    high: number
    low: number
    close: number
    volume: number
  }> = []
  let cursor = new Date(startDate + 'T00:00:00Z')
  for (const p of prices) {
    while (cursor.getUTCDay() === 0 || cursor.getUTCDay() === 6) {
      cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000)
    }
    out.push({
      date: cursor.toISOString().slice(0, 10),
      open: p,
      high: p * 1.005,
      low: p * 0.995,
      close: p,
      volume: 1_000_000,
    })
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000)
  }
  return out
}

// ==================== Setup ====================

beforeAll(() => {
  // Each test file imports the registry fresh. Reset and re-register
  // the SMA strategy so spec ordering doesn't matter and we don't
  // depend on side-effect imports.
  _resetRegistryForTests()
  register(smaCrossoverStrategy)
})

// ==================== listStrategies ====================

describe('backtest tool: listStrategies', () => {
  it('returns the registered strategies with metadata', async () => {
    const client = makeMockEquityClient([])
    const tools = createBacktestTools(client)
    const result = await (tools.listStrategies.execute as (
      input: Record<string, unknown>,
      ctx: unknown,
    ) => Promise<{ strategies: Array<{ name: string }> }>)({}, undefined)
    const names = result.strategies.map(s => s.name)
    expect(names).toContain('sma-crossover')
  })
})

// ==================== backtestRun ====================

describe('backtest tool: backtestRun', () => {
  it('rejects an unknown strategy name with a helpful error', async () => {
    const client = makeMockEquityClient(makeBars([100, 101]))
    const tools = createBacktestTools(client)
    await expect(
      (tools.backtestRun.execute as (
        input: Record<string, unknown>,
        ctx: unknown,
      ) => Promise<unknown>)(
        {
          strategy: 'no-such-thing',
          symbol: 'SPY',
          from: '2024-01-01',
          to: '2024-01-10',
          initialCash: 10_000,
          commissionPerShare: 0,
          commissionMin: 0,
          slippageBps: 0,
          provider: 'yfinance',
          fullCurve: false,
        },
        undefined,
      ),
    ).rejects.toThrow(/Unknown strategy/)
  })

  it('rejects when provider returns fewer than 2 usable bars', async () => {
    // Single bar — not enough to backtest.
    const client = makeMockEquityClient(makeBars([100]))
    const tools = createBacktestTools(client)
    await expect(
      (tools.backtestRun.execute as (
        input: Record<string, unknown>,
        ctx: unknown,
      ) => Promise<unknown>)(
        {
          strategy: 'sma-crossover',
          symbol: 'SPY',
          from: '2024-01-01',
          to: '2024-01-02',
          initialCash: 10_000,
          commissionPerShare: 0,
          commissionMin: 0,
          slippageBps: 0,
          provider: 'yfinance',
          fullCurve: false,
        },
        undefined,
      ),
    ).rejects.toThrow(/Need at least 2/)
  })

  it('drops bars with null OHLC fields, runs on the rest', async () => {
    // 3 valid bars, 1 with null close (yfinance occasionally returns
    // these for missing-data days). Engine sees 3 bars, not 4.
    const rows = [
      ...makeBars([100, 101]),
      { date: '2024-01-04', open: 102, high: 102, low: 102, close: null as number | null, volume: 1000 },
      ...makeBars([103], '2024-01-05'),
    ]
    const client = makeMockEquityClient(rows as Parameters<typeof makeMockEquityClient>[0])
    const tools = createBacktestTools(client)

    // Strategy needs warmup of 51 bars; with 3 bars it won't trade,
    // but the engine should run cleanly without NaN.
    const result = (await (tools.backtestRun.execute as (
      input: Record<string, unknown>,
      ctx: unknown,
    ) => Promise<{ summary: { bars: number; tradeCount: number } }>)(
      {
        strategy: 'sma-crossover',
        symbol: 'SPY',
        from: '2024-01-01',
        to: '2024-01-10',
        initialCash: 10_000,
        commissionPerShare: 0,
        commissionMin: 0,
        slippageBps: 0,
        provider: 'yfinance',
        fullCurve: false,
      },
      undefined,
    ))

    expect(result.summary.bars).toBe(3) // null row dropped
    expect(result.summary.tradeCount).toBe(0) // not enough warmup
  })

  it('runs end-to-end on a downturn-then-recovery dataset that triggers a crossover', async () => {
    // Construct a price path that forces SMA(20) to fall below SMA(50)
    // and then recover above — an actual upward crossover. Strictly
    // ascending data does NOT trigger because fast never sits below
    // slow first.
    //   bars 0-29  : flat at 100
    //   bars 30-44 : descend 100 → 85 (fast SMA falls faster)
    //   bars 45-79 : recover 85 → 130 (fast catches up, crosses above)
    const flat = Array.from({ length: 30 }, () => 100)
    const down = Array.from({ length: 15 }, (_, i) => 100 - (i + 1) * (15 / 15))
    const up = Array.from({ length: 35 }, (_, i) => 85 + (i + 1) * (45 / 35))
    const prices = [...flat, ...down, ...up]
    const rows = makeBars(prices)
    const client = makeMockEquityClient(rows)
    const tools = createBacktestTools(client)

    const result = (await (tools.backtestRun.execute as (
      input: Record<string, unknown>,
      ctx: unknown,
    ) => Promise<{
      ok: boolean
      strategyName: string
      summary: { bars: number; tradeCount: number; sharpe: string }
    }>)(
      {
        strategy: 'sma-crossover',
        symbol: 'SPY',
        from: '2024-01-01',
        to: '2024-04-30',
        initialCash: 100_000,
        commissionPerShare: 0,
        commissionMin: 0,
        slippageBps: 0,
        provider: 'yfinance',
        fullCurve: false,
      },
      undefined,
    ))

    expect(result.ok).toBe(true)
    expect(result.strategyName).toBe('sma-crossover')
    expect(result.summary.bars).toBe(prices.length)
    // The constructed crossover should trigger at least one BUY entry
    // during the recovery leg. Some runs may also produce a SELL if
    // the recovery stalls late, so we assert >=1 rather than ==1.
    expect(result.summary.tradeCount).toBeGreaterThanOrEqual(1)
  })

  it('downsamples the equity curve by default but preserves it with fullCurve', async () => {
    // 60 bars — only the curve length matters for this test, not whether
    // any trades fire.
    const rows = makeBars(Array.from({ length: 60 }, (_, i) => 100 + i * 0.5))
    const client = makeMockEquityClient(rows)
    const tools = createBacktestTools(client)

    const downsampled = (await (tools.backtestRun.execute as (
      input: Record<string, unknown>,
      ctx: unknown,
    ) => Promise<{ summary: { equityCurve: unknown[] } }>)(
      {
        strategy: 'sma-crossover',
        symbol: 'SPY',
        from: '2024-01-01',
        to: '2024-04-01',
        initialCash: 100_000,
        commissionPerShare: 0,
        commissionMin: 0,
        slippageBps: 0,
        provider: 'yfinance',
        fullCurve: false,
      },
      undefined,
    ))
    expect(downsampled.summary.equityCurve.length).toBe(11) // head + tail + 9 midpoints

    const full = (await (tools.backtestRun.execute as (
      input: Record<string, unknown>,
      ctx: unknown,
    ) => Promise<{ summary: { equityCurve: unknown[] } }>)(
      {
        strategy: 'sma-crossover',
        symbol: 'SPY',
        from: '2024-01-01',
        to: '2024-04-01',
        initialCash: 100_000,
        commissionPerShare: 0,
        commissionMin: 0,
        slippageBps: 0,
        provider: 'yfinance',
        fullCurve: true,
      },
      undefined,
    ))
    expect(full.summary.equityCurve.length).toBe(60)
  })
})
