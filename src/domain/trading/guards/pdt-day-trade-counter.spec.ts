import { describe, it, expect } from 'vitest'
import Decimal from 'decimal.js'
import { Order, UNSET_DECIMAL } from '@traderalice/ibkr'
import {
  PdtDayTradeCounterGuard,
  collectFillsByDayAndSymbol,
  countDayTradesInWindow,
} from './pdt-day-trade-counter.js'
import type { GuardContext } from './types.js'
import type { GitCommit, Operation, OperationResult, GitState } from '../git/types.js'
import type { AccountInfo, Position } from '../brokers/types.js'
import { makeContract } from '../brokers/mock/index.js'
import '../contract-ext.js'

// ==================== Helpers ====================

function makeOrder(action: 'BUY' | 'SELL', qty: number): Order {
  const order = new Order()
  order.action = action
  order.orderType = 'MKT'
  order.totalQuantity = new Decimal(qty)
  order.lmtPrice = UNSET_DECIMAL
  order.auxPrice = UNSET_DECIMAL
  order.trailStopPrice = UNSET_DECIMAL
  order.trailingPercent = UNSET_DECIMAL
  order.cashQty = UNSET_DECIMAL
  return order
}

function makePlaceOp(symbol: string, action: 'BUY' | 'SELL', qty: number): Operation {
  return {
    action: 'placeOrder',
    contract: makeContract({ symbol, aliceId: `mock-paper|${symbol}` }),
    order: makeOrder(action, qty),
  }
}

function makeFilledResult(qty: number): OperationResult {
  return {
    action: 'placeOrder',
    success: true,
    status: 'filled',
    filledQty: String(qty),
    filledPrice: '100',
  }
}

function makeCommit(opts: {
  ts: string
  fills: Array<{ symbol: string; action: 'BUY' | 'SELL'; qty: number }>
  realizedPnL?: string
}): GitCommit {
  const operations = opts.fills.map(f => makePlaceOp(f.symbol, f.action, f.qty))
  const results = opts.fills.map(f => makeFilledResult(f.qty))
  const stateAfter: GitState = {
    netLiquidation: '10000',
    totalCashValue: '10000',
    unrealizedPnL: '0',
    realizedPnL: opts.realizedPnL ?? '0',
    positions: [],
    pendingOrders: [],
  }
  return {
    hash: 'h-' + opts.ts.slice(0, 10),
    parentHash: null,
    message: 'test',
    operations,
    results,
    stateAfter,
    timestamp: opts.ts,
  }
}

function makeCtx(overrides: {
  operation?: Operation
  positions?: Position[]
  account?: Partial<AccountInfo>
  recentCommits?: readonly GitCommit[]
} = {}): GuardContext {
  return {
    operation: overrides.operation ?? makePlaceOp('AAPL', 'BUY', 10),
    positions: overrides.positions ?? [],
    account: {
      baseCurrency: 'USD',
      netLiquidation: '10000', // under $25k → PDT applies
      totalCashValue: '10000',
      unrealizedPnL: '0',
      realizedPnL: '0',
      ...overrides.account,
    },
    recentCommits: overrides.recentCommits ?? [],
  }
}

// Helper: build a guard with a fixed "now" in UTC for predictable date keys
function makeGuard(opts: {
  maxDayTrades?: number
  windowDays?: number
  accountType?: 'margin' | 'cash'
  equityThreshold?: number
  nowMs?: number
} = {}) {
  const nowMs = opts.nowMs ?? Date.UTC(2024, 5, 17, 14, 0, 0) // 2024-06-17 14:00 UTC = 10:00 ET
  return new PdtDayTradeCounterGuard({
    maxDayTrades: opts.maxDayTrades ?? 3,
    windowDays: opts.windowDays ?? 5,
    accountType: opts.accountType ?? 'margin',
    equityThreshold: opts.equityThreshold ?? 25_000,
    timezone: 'UTC', // simplifies date math in tests
    now: () => nowMs,
  })
}

// ==================== collectFillsByDayAndSymbol ====================

describe('collectFillsByDayAndSymbol', () => {
  it('aggregates buys and sells per (date, symbol)', () => {
    const commits: GitCommit[] = [
      makeCommit({
        ts: '2024-06-17T14:00:00Z',
        fills: [{ symbol: 'AAPL', action: 'BUY', qty: 100 }],
      }),
      makeCommit({
        ts: '2024-06-17T15:00:00Z',
        fills: [{ symbol: 'AAPL', action: 'SELL', qty: 100 }],
      }),
    ]
    const fills = collectFillsByDayAndSymbol(commits, 'UTC')
    const day = fills.get('2024-06-17')
    expect(day).toBeDefined()
    expect(day!.get('AAPL')!.buy.toString()).toBe('100')
    expect(day!.get('AAPL')!.sell.toString()).toBe('100')
  })

  it('skips operations without filledQty', () => {
    const commit: GitCommit = {
      hash: 'h1',
      parentHash: null,
      message: 'unfilled',
      operations: [makePlaceOp('AAPL', 'BUY', 100)],
      results: [{
        action: 'placeOrder',
        success: false,
        status: 'rejected',
        error: 'no funds',
      }],
      stateAfter: {
        netLiquidation: '0',
        totalCashValue: '0',
        unrealizedPnL: '0',
        realizedPnL: '0',
        positions: [],
        pendingOrders: [],
      },
      timestamp: '2024-06-17T14:00:00Z',
    }
    const fills = collectFillsByDayAndSymbol([commit], 'UTC')
    expect(fills.size).toBe(0)
  })
})

// ==================== countDayTradesInWindow ====================

describe('countDayTradesInWindow', () => {
  it('counts a same-day buy+sell pair as one day-trade', () => {
    const fills = new Map<string, Map<string, { buy: Decimal; sell: Decimal }>>([
      ['2024-06-17', new Map([
        ['AAPL', { buy: new Decimal(100), sell: new Decimal(100) }],
      ])],
    ])
    expect(countDayTradesInWindow(fills, '2024-06-17', 5)).toBe(1)
  })

  it('does not count same-day-only-one-side fills', () => {
    const fills = new Map<string, Map<string, { buy: Decimal; sell: Decimal }>>([
      ['2024-06-17', new Map([
        ['AAPL', { buy: new Decimal(100), sell: new Decimal(0) }],
      ])],
    ])
    expect(countDayTradesInWindow(fills, '2024-06-17', 5)).toBe(0)
  })

  it('counts each symbol with both buy and sell once per date', () => {
    const fills = new Map<string, Map<string, { buy: Decimal; sell: Decimal }>>([
      ['2024-06-17', new Map([
        ['AAPL', { buy: new Decimal(100), sell: new Decimal(100) }],
        ['NVDA', { buy: new Decimal(50), sell: new Decimal(50) }],
      ])],
      ['2024-06-16', new Map([
        ['TSLA', { buy: new Decimal(10), sell: new Decimal(10) }],
      ])],
    ])
    expect(countDayTradesInWindow(fills, '2024-06-17', 5)).toBe(3)
  })

  it('excludes dates outside the window', () => {
    // Window 5 days ending 2024-06-17 → earliest 2024-06-13 (5 calendar days back)
    const fills = new Map<string, Map<string, { buy: Decimal; sell: Decimal }>>([
      ['2024-06-17', new Map([['AAPL', { buy: new Decimal(1), sell: new Decimal(1) }]])],
      ['2024-06-13', new Map([['NVDA', { buy: new Decimal(1), sell: new Decimal(1) }]])],
      ['2024-06-12', new Map([['TSLA', { buy: new Decimal(1), sell: new Decimal(1) }]])],
    ])
    expect(countDayTradesInWindow(fills, '2024-06-17', 5)).toBe(2)
  })
})

// ==================== Guard end-to-end ====================

describe('PdtDayTradeCounterGuard', () => {
  it('allows a buy with no prior history (1st trade ever)', () => {
    const guard = makeGuard()
    expect(guard.check(makeCtx())).toBeNull()
  })

  it('allows the 3rd day-trade (cap is exclusive)', () => {
    // 3 prior day-trades on different symbols, 4th would be NEW.
    // We test the BOUNDARY: this BUY would create the 4th DT only
    // if it pairs with an existing same-day SELL. Here we're going
    // long for the first time today on AAPL — no opposite-side
    // earlier today, so projected count stays at 3.
    const today = '2024-06-17'
    const commits: GitCommit[] = [
      makeCommit({ ts: `${today}T13:00:00Z`, fills: [
        { symbol: 'NVDA', action: 'BUY', qty: 50 },
        { symbol: 'NVDA', action: 'SELL', qty: 50 },
      ]}),
      makeCommit({ ts: `${today}T14:00:00Z`, fills: [
        { symbol: 'TSLA', action: 'BUY', qty: 10 },
        { symbol: 'TSLA', action: 'SELL', qty: 10 },
      ]}),
      makeCommit({ ts: `${today}T15:00:00Z`, fills: [
        { symbol: 'GOOG', action: 'BUY', qty: 5 },
        { symbol: 'GOOG', action: 'SELL', qty: 5 },
      ]}),
    ]
    const guard = makeGuard()
    const result = guard.check(makeCtx({
      operation: makePlaceOp('AAPL', 'BUY', 100), // new symbol — won't pair
      recentCommits: commits,
    }))
    expect(result).toBeNull()
  })

  it('rejects a 4th day-trade (closing AAPL today after 3 prior round-trips)', () => {
    const today = '2024-06-17'
    const commits: GitCommit[] = [
      makeCommit({ ts: `${today}T13:00:00Z`, fills: [
        { symbol: 'NVDA', action: 'BUY', qty: 50 },
        { symbol: 'NVDA', action: 'SELL', qty: 50 },
      ]}),
      makeCommit({ ts: `${today}T14:00:00Z`, fills: [
        { symbol: 'TSLA', action: 'BUY', qty: 10 },
        { symbol: 'TSLA', action: 'SELL', qty: 10 },
      ]}),
      makeCommit({ ts: `${today}T15:00:00Z`, fills: [
        { symbol: 'GOOG', action: 'BUY', qty: 5 },
        { symbol: 'GOOG', action: 'SELL', qty: 5 },
      ]}),
      // Earlier today bought AAPL — selling NOW would complete the 4th DT.
      makeCommit({ ts: `${today}T16:00:00Z`, fills: [
        { symbol: 'AAPL', action: 'BUY', qty: 100 },
      ]}),
    ]
    const guard = makeGuard()
    const result = guard.check(makeCtx({
      operation: makePlaceOp('AAPL', 'SELL', 100),
      recentCommits: commits,
    }))
    expect(result).not.toBeNull()
    expect(result).toContain('PDT')
    expect(result).toContain('4-th')
    expect(result).toContain('limit: 3')
  })

  it('does NOT count same-day BUY then SELL across DIFFERENT days as a day-trade', () => {
    // Bought yesterday, selling today → swing trade, NOT a day-trade.
    const commits: GitCommit[] = [
      makeCommit({ ts: '2024-06-14T14:00:00Z', fills: [
        { symbol: 'AAPL', action: 'BUY', qty: 100 },
      ]}),
    ]
    const guard = makeGuard({ nowMs: Date.UTC(2024, 5, 17, 14, 0, 0) })
    const result = guard.check(makeCtx({
      operation: makePlaceOp('AAPL', 'SELL', 100),
      recentCommits: commits,
    }))
    expect(result).toBeNull()
  })

  it('skips when accountType is cash', () => {
    const guard = makeGuard({ accountType: 'cash' })
    // Even with 4 day-trades it should pass.
    const today = '2024-06-17'
    const commits: GitCommit[] = [
      makeCommit({ ts: `${today}T13:00:00Z`, fills: [
        { symbol: 'NVDA', action: 'BUY', qty: 50 },
        { symbol: 'NVDA', action: 'SELL', qty: 50 },
        { symbol: 'TSLA', action: 'BUY', qty: 10 },
        { symbol: 'TSLA', action: 'SELL', qty: 10 },
        { symbol: 'GOOG', action: 'BUY', qty: 5 },
        { symbol: 'GOOG', action: 'SELL', qty: 5 },
        { symbol: 'AAPL', action: 'BUY', qty: 100 },
      ]}),
    ]
    expect(guard.check(makeCtx({
      operation: makePlaceOp('AAPL', 'SELL', 100),
      recentCommits: commits,
    }))).toBeNull()
  })

  it('skips when account equity ≥ threshold', () => {
    const guard = makeGuard({ equityThreshold: 25_000 })
    const today = '2024-06-17'
    const commits: GitCommit[] = [
      makeCommit({ ts: `${today}T13:00:00Z`, fills: [
        { symbol: 'NVDA', action: 'BUY', qty: 50 }, { symbol: 'NVDA', action: 'SELL', qty: 50 },
        { symbol: 'TSLA', action: 'BUY', qty: 10 }, { symbol: 'TSLA', action: 'SELL', qty: 10 },
        { symbol: 'GOOG', action: 'BUY', qty: 5 }, { symbol: 'GOOG', action: 'SELL', qty: 5 },
        { symbol: 'AAPL', action: 'BUY', qty: 100 },
      ]}),
    ]
    const ctx = makeCtx({
      operation: makePlaceOp('AAPL', 'SELL', 100),
      account: { netLiquidation: '30000' }, // above threshold
      recentCommits: commits,
    })
    expect(guard.check(ctx)).toBeNull()
  })

  it('skips non-placeOrder operations', () => {
    const guard = makeGuard()
    const ctx = makeCtx({
      operation: { action: 'closePosition', contract: makeContract({ symbol: 'AAPL' }) },
    })
    expect(guard.check(ctx)).toBeNull()
  })

  it('rolling window expires: same 4 day-trades 6 days ago shouldn\'t block today', () => {
    const guard = makeGuard({ nowMs: Date.UTC(2024, 5, 17, 14, 0, 0) })
    // Old day-trades from 2024-06-10 (7 calendar days back, > 5-day window)
    const oldDay = '2024-06-10'
    const commits: GitCommit[] = [
      makeCommit({ ts: `${oldDay}T14:00:00Z`, fills: [
        { symbol: 'NVDA', action: 'BUY', qty: 50 }, { symbol: 'NVDA', action: 'SELL', qty: 50 },
        { symbol: 'TSLA', action: 'BUY', qty: 10 }, { symbol: 'TSLA', action: 'SELL', qty: 10 },
        { symbol: 'GOOG', action: 'BUY', qty: 5 }, { symbol: 'GOOG', action: 'SELL', qty: 5 },
        { symbol: 'AMZN', action: 'BUY', qty: 5 }, { symbol: 'AMZN', action: 'SELL', qty: 5 },
      ]}),
    ]
    expect(guard.check(makeCtx({
      operation: makePlaceOp('AAPL', 'BUY', 100),
      recentCommits: commits,
    }))).toBeNull()
  })

  it('throws on construction with invalid options', () => {
    expect(() => new PdtDayTradeCounterGuard({ maxDayTrades: -1 })).toThrow(/non-negative/)
    expect(() => new PdtDayTradeCounterGuard({ windowDays: 0 })).toThrow(/positive integer/)
  })
})
