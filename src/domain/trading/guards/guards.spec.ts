import { describe, it, expect, vi, beforeEach } from 'vitest'
import Decimal from 'decimal.js'
import { Contract, Order, UNSET_DECIMAL } from '@traderalice/ibkr'
import { MaxPositionSizeGuard } from './max-position-size.js'
import { CooldownGuard } from './cooldown.js'
import { SymbolWhitelistGuard } from './symbol-whitelist.js'
import { PerTradeLossCapGuard } from './per-trade-loss-cap.js'
import { MaxPositionsGuard } from './max-positions.js'
import { DailyLossCapGuard } from './daily-loss-cap.js'
import { CircuitBreakerGuard, countConsecutiveLosses } from './circuit-breaker.js'
import type { GitCommit } from '../git/types.js'
import { createGuardPipeline } from './guard-pipeline.js'
import { resolveGuards, registerGuard } from './registry.js'
import type { GuardContext, OperationGuard } from './types.js'
import type { Operation } from '../git/types.js'
import type { AccountInfo, Position } from '../brokers/types.js'
import { MockBroker, makeContract, makePosition } from '../brokers/mock/index.js'
import '../contract-ext.js'

// ==================== Helpers ====================

function makePlaceOrderOp(overrides: {
  symbol?: string
  action?: 'BUY' | 'SELL'
  orderType?: string
  cashQty?: number
  totalQuantity?: Decimal
  lmtPrice?: number
  stopPrice?: number
} = {}): Operation {
  const contract = makeContract({ symbol: overrides.symbol ?? 'AAPL' })
  const order = new Order()
  order.action = overrides.action ?? 'BUY'
  order.orderType = overrides.orderType ?? 'MKT'
  order.totalQuantity = overrides.totalQuantity ?? new Decimal(10)
  if (overrides.cashQty != null) {
    order.cashQty = new Decimal(overrides.cashQty)
  }
  if (overrides.lmtPrice != null) {
    order.lmtPrice = new Decimal(overrides.lmtPrice)
  }
  const op: Operation = { action: 'placeOrder', contract, order }
  if (overrides.stopPrice != null) {
    op.tpsl = { stopLoss: { price: String(overrides.stopPrice) } }
  }
  return op
}

function makeContext(overrides: {
  operation?: Operation
  positions?: Position[]
  account?: Partial<AccountInfo>
  recentCommits?: GuardContext['recentCommits']
} = {}): GuardContext {
  return {
    operation: overrides.operation ?? makePlaceOrderOp(),
    positions: overrides.positions ?? [],
    account: {
      baseCurrency: 'USD',
      netLiquidation: '100000',
      totalCashValue: '100000',
      unrealizedPnL: '0',
      realizedPnL: '0',
      ...overrides.account,
    },
    recentCommits: overrides.recentCommits ?? [],
  }
}

// ==================== MaxPositionSizeGuard ====================

describe('MaxPositionSizeGuard', () => {
  it('allows order within limit', () => {
    const guard = new MaxPositionSizeGuard({ maxPercentOfEquity: 25 })
    const ctx = makeContext({
      operation: makePlaceOrderOp({ cashQty: 20_000 }),
      account: { netLiquidation: '100000' },
    })

    expect(guard.check(ctx)).toBeNull()
  })

  it('rejects order exceeding limit', () => {
    const guard = new MaxPositionSizeGuard({ maxPercentOfEquity: 25 })
    const ctx = makeContext({
      operation: makePlaceOrderOp({ cashQty: 30_000 }),
      account: { netLiquidation: '100000' },
    })

    const result = guard.check(ctx)
    expect(result).not.toBeNull()
    expect(result).toContain('30.0%')
    expect(result).toContain('limit: 25%')
  })

  it('considers existing position value', () => {
    const guard = new MaxPositionSizeGuard({ maxPercentOfEquity: 25 })
    const ctx = makeContext({
      operation: makePlaceOrderOp({ cashQty: 10_000 }),
      positions: [makePosition({ contract: makeContract({ symbol: 'AAPL' }), marketValue: '20000' })],
      account: { netLiquidation: '100000' },
    })

    const result = guard.check(ctx)
    expect(result).not.toBeNull()
    // 20k existing + 10k new = 30k = 30%
    expect(result).toContain('30.0%')
  })

  it('uses default 25% if no option provided', () => {
    const guard = new MaxPositionSizeGuard({})
    const ctx = makeContext({
      operation: makePlaceOrderOp({ cashQty: 26_000 }),
      account: { netLiquidation: '100000' },
    })
    expect(guard.check(ctx)).not.toBeNull()
  })

  it('skips non-placeOrder operations', () => {
    const guard = new MaxPositionSizeGuard({ maxPercentOfEquity: 1 })
    const contract = makeContract({ symbol: 'AAPL' })
    const ctx = makeContext({
      operation: { action: 'closePosition', contract },
    })
    expect(guard.check(ctx)).toBeNull()
  })

  it('allows when addedValue cannot be estimated (qty-based, no existing position)', () => {
    const guard = new MaxPositionSizeGuard({ maxPercentOfEquity: 1 })
    const ctx = makeContext({
      operation: makePlaceOrderOp({ symbol: 'NEW_STOCK', totalQuantity: new Decimal(100) }),
    })
    expect(guard.check(ctx)).toBeNull()
  })
})

// ==================== CooldownGuard ====================

describe('CooldownGuard', () => {
  it('allows first trade', async () => {
    const guard = new CooldownGuard({ minIntervalMs: 60_000 })
    const ctx = makeContext()
    expect(await guard.check(ctx)).toBeNull()
  })

  it('rejects rapid repeat trade for same symbol', async () => {
    const guard = new CooldownGuard({ minIntervalMs: 60_000 })
    const ctx = makeContext()

    await guard.check(ctx) // first — allowed
    const result = await guard.check(ctx) // second — rejected
    expect(result).not.toBeNull()
    expect(result).toContain('Cooldown active')
    expect(result).toContain('AAPL')
  })

  it('allows trade for different symbol', async () => {
    const guard = new CooldownGuard({ minIntervalMs: 60_000 })

    await guard.check(makeContext({
      operation: makePlaceOrderOp({ symbol: 'AAPL' }),
    }))

    const result = await guard.check(makeContext({
      operation: makePlaceOrderOp({ symbol: 'GOOG' }),
    }))
    expect(result).toBeNull()
  })

  it('skips non-placeOrder operations', async () => {
    const guard = new CooldownGuard({ minIntervalMs: 60_000 })
    const contract = makeContract({ symbol: 'AAPL' })
    const ctx = makeContext({
      operation: { action: 'closePosition', contract },
    })
    expect(await guard.check(ctx)).toBeNull()
  })

  // ---- Persistence ----

  it('persists lastTradeTime across instances when accountId is set', async () => {
    const { mkdtemp, rm } = await import('fs/promises')
    const { tmpdir } = await import('os')
    const { join } = await import('path')
    const tmpRoot = await mkdtemp(join(tmpdir(), 'cooldown-test-'))
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpRoot)

    try {
      const accountId = 'test-uta-1'
      const ctx = makeContext()

      // Instance 1: trade once, then drop the instance.
      const g1 = new CooldownGuard({ minIntervalMs: 60_000, accountId })
      expect(await g1.check(ctx)).toBeNull()

      // Wait for fire-and-forget persist to flush.
      await new Promise(r => setTimeout(r, 20))

      // Instance 2 (simulates restart): should see the prior trade
      // and reject a same-symbol trade within the cooldown window.
      const g2 = new CooldownGuard({ minIntervalMs: 60_000, accountId })
      const result = await g2.check(ctx)
      expect(result).not.toBeNull()
      expect(result).toContain('Cooldown active')
      expect(result).toContain('AAPL')
    } finally {
      cwdSpy.mockRestore()
      await rm(tmpRoot, { recursive: true, force: true })
    }
  })

  it('stays RAM-only when no accountId is provided', async () => {
    // No accountId → no disk read/write at all. Two instances must
    // behave independently (existing unit-test contract).
    const g1 = new CooldownGuard({ minIntervalMs: 60_000 })
    expect(await g1.check(makeContext())).toBeNull()

    const g2 = new CooldownGuard({ minIntervalMs: 60_000 })
    expect(await g2.check(makeContext())).toBeNull()
  })
})

// ==================== SymbolWhitelistGuard ====================

describe('SymbolWhitelistGuard', () => {
  it('allows whitelisted symbols', () => {
    const guard = new SymbolWhitelistGuard({ symbols: ['AAPL', 'GOOG'] })
    const ctx = makeContext()
    expect(guard.check(ctx)).toBeNull()
  })

  it('rejects non-whitelisted symbols', () => {
    const guard = new SymbolWhitelistGuard({ symbols: ['GOOG'] })
    const ctx = makeContext()
    expect(guard.check(ctx)).toContain('not in the allowed list')
  })

  it('throws on construction without symbols', () => {
    expect(() => new SymbolWhitelistGuard({})).toThrow('non-empty "symbols"')
    expect(() => new SymbolWhitelistGuard({ symbols: [] })).toThrow('non-empty "symbols"')
  })

  it('allows operations without a symbol param', () => {
    const guard = new SymbolWhitelistGuard({ symbols: ['AAPL'] })
    const ctx = makeContext({
      operation: { action: 'cancelOrder', orderId: '123' },
    })
    expect(guard.check(ctx)).toBeNull()
  })
})

// ==================== Guard Pipeline ====================

describe('createGuardPipeline', () => {
  it('returns dispatcher directly when no guards', () => {
    const dispatcher = vi.fn().mockResolvedValue({ success: true })
    const account = new MockBroker()
    const pipeline = createGuardPipeline(dispatcher, account, [])

    // Should be the same function reference
    expect(pipeline).toBe(dispatcher)
  })

  it('passes through when all guards allow', async () => {
    const dispatcher = vi.fn().mockResolvedValue({ success: true })
    const account = new MockBroker()
    const allowGuard: OperationGuard = { name: 'allow-all', check: () => null }

    const pipeline = createGuardPipeline(dispatcher, account, [allowGuard])
    const op: Operation = makePlaceOrderOp()
    const result = await pipeline(op)

    expect(dispatcher).toHaveBeenCalledWith(op)
    expect(result).toEqual({ success: true })
  })

  it('blocks when a guard rejects', async () => {
    const dispatcher = vi.fn().mockResolvedValue({ success: true })
    const account = new MockBroker()
    const denyGuard: OperationGuard = { name: 'deny-all', check: () => 'Denied!' }

    const pipeline = createGuardPipeline(dispatcher, account, [denyGuard])
    const op: Operation = makePlaceOrderOp()
    const result = await pipeline(op) as Record<string, unknown>

    expect(dispatcher).not.toHaveBeenCalled()
    expect(result.success).toBe(false)
    expect(result.error).toContain('[guard:deny-all]')
    expect(result.error).toContain('Denied!')
  })

  it('stops at first rejecting guard', async () => {
    const dispatcher = vi.fn().mockResolvedValue({ success: true })
    const account = new MockBroker()
    const guardA: OperationGuard = { name: 'A', check: vi.fn().mockReturnValue(null) }
    const guardB: OperationGuard = { name: 'B', check: vi.fn().mockReturnValue('Blocked by B') }
    const guardC: OperationGuard = { name: 'C', check: vi.fn().mockReturnValue(null) }

    const pipeline = createGuardPipeline(dispatcher, account, [guardA, guardB, guardC])
    const op: Operation = makePlaceOrderOp()
    await pipeline(op)

    expect(guardA.check).toHaveBeenCalled()
    expect(guardB.check).toHaveBeenCalled()
    expect(guardC.check).not.toHaveBeenCalled()
  })

  it('fetches positions and account info for guard context', async () => {
    const dispatcher = vi.fn().mockResolvedValue({ success: true })
    const account = new MockBroker({ accountInfo: { netLiquidation: '105000', totalCashValue: '100000', unrealizedPnL: '5000', realizedPnL: '1000' } })
    account.setPositions([makePosition()])

    let capturedCtx: GuardContext | undefined
    const spyGuard: OperationGuard = {
      name: 'spy',
      check: (ctx) => { capturedCtx = ctx; return null },
    }

    const pipeline = createGuardPipeline(dispatcher, account, [spyGuard])
    await pipeline(makePlaceOrderOp())

    expect(capturedCtx).toBeDefined()
    expect(capturedCtx!.positions).toHaveLength(1)
    expect(capturedCtx!.account.netLiquidation).toBe('105000')
  })
})

// ==================== Registry ====================

describe('resolveGuards', () => {
  it('resolves builtin guard types', () => {
    const guards = resolveGuards([
      { type: 'max-position-size', options: { maxPercentOfEquity: 25 } },
      { type: 'symbol-whitelist', options: { symbols: ['AAPL'] } },
    ])
    expect(guards).toHaveLength(2)
    expect(guards[0].name).toBe('max-position-size')
    expect(guards[1].name).toBe('symbol-whitelist')
  })

  it('skips unknown guard types with a warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const guards = resolveGuards([{ type: 'nonexistent' }])
    expect(guards).toHaveLength(0)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('nonexistent'))
    warnSpy.mockRestore()
  })

  it('returns empty for empty config', () => {
    expect(resolveGuards([])).toEqual([])
  })
})

describe('registerGuard', () => {
  it('registers a custom guard type', () => {
    registerGuard({
      type: 'test-custom',
      create: () => ({ name: 'test-custom', check: () => null }),
    })

    const guards = resolveGuards([{ type: 'test-custom' }])
    expect(guards).toHaveLength(1)
    expect(guards[0].name).toBe('test-custom')
  })
})

// ==================== PerTradeLossCapGuard ====================

describe('PerTradeLossCapGuard', () => {
  it('rejects an entry with no stop when requireStop is true (default)', () => {
    const guard = new PerTradeLossCapGuard({ maxPercentOfEquity: 1 })
    const ctx = makeContext({
      operation: makePlaceOrderOp({ lmtPrice: 100, totalQuantity: new Decimal(10) }),
    })
    const result = guard.check(ctx)
    expect(result).toContain('no stopLoss declared')
  })

  it('allows an entry with no stop when requireStop is false', () => {
    const guard = new PerTradeLossCapGuard({
      maxPercentOfEquity: 1,
      requireStop: false,
    })
    const ctx = makeContext({
      operation: makePlaceOrderOp({ lmtPrice: 100, totalQuantity: new Decimal(10) }),
    })
    expect(guard.check(ctx)).toBeNull()
  })

  it('allows a within-cap LMT-with-stop entry', () => {
    // Equity 100k, cap 1% = $1000.
    // Entry 100, stop 95, qty 100 → risk = 100 × 5 = 500. Under cap. ✓
    const guard = new PerTradeLossCapGuard({ maxPercentOfEquity: 1 })
    const ctx = makeContext({
      operation: makePlaceOrderOp({
        lmtPrice: 100,
        stopPrice: 95,
        totalQuantity: new Decimal(100),
      }),
    })
    expect(guard.check(ctx)).toBeNull()
  })

  it('rejects an over-cap LMT-with-stop entry with a useful message', () => {
    // Equity 100k, cap 1% = $1000.
    // Entry 100, stop 90, qty 200 → risk = 200 × 10 = 2000. Over cap.
    const guard = new PerTradeLossCapGuard({ maxPercentOfEquity: 1 })
    const ctx = makeContext({
      operation: makePlaceOrderOp({
        lmtPrice: 100,
        stopPrice: 90,
        totalQuantity: new Decimal(200),
      }),
    })
    const result = guard.check(ctx)
    expect(result).not.toBeNull()
    expect(result).toContain('$2000') // total risk
    expect(result).toContain('1%')
    expect(result).toContain('$1000') // cap
  })

  it('uses existing-position marketPrice when MKT order has no lmtPrice', () => {
    // MKT order with no lmtPrice. Existing position has marketPrice 100,
    // stop 95, qty 100 → risk = 500. Under 1% cap.
    const guard = new PerTradeLossCapGuard({ maxPercentOfEquity: 1 })
    const ctx = makeContext({
      operation: makePlaceOrderOp({
        stopPrice: 95,
        totalQuantity: new Decimal(100),
      }),
      positions: [
        makePosition({
          contract: makeContract({ symbol: 'AAPL' }),
          marketPrice: '100',
        }),
      ],
    })
    expect(guard.check(ctx)).toBeNull()
  })

  it('allows when MKT new symbol cannot be priced', () => {
    // No lmtPrice, no existing position → can't estimate entry. Allow.
    // Other guards / broker validation should catch.
    const guard = new PerTradeLossCapGuard({ maxPercentOfEquity: 1 })
    const ctx = makeContext({
      operation: makePlaceOrderOp({
        stopPrice: 95,
        totalQuantity: new Decimal(1000),
      }),
    })
    expect(guard.check(ctx)).toBeNull()
  })

  it('skips SELL (exit) orders', () => {
    const guard = new PerTradeLossCapGuard({ maxPercentOfEquity: 1 })
    const ctx = makeContext({
      operation: makePlaceOrderOp({
        action: 'SELL',
        lmtPrice: 100,
        stopPrice: 95,
        totalQuantity: new Decimal(10000),
      }),
    })
    expect(guard.check(ctx)).toBeNull()
  })

  it('skips non-placeOrder operations', () => {
    const guard = new PerTradeLossCapGuard({ maxPercentOfEquity: 1 })
    const ctx = makeContext({
      operation: { action: 'closePosition', contract: makeContract({ symbol: 'AAPL' }) },
    })
    expect(guard.check(ctx)).toBeNull()
  })

  it('handles netLiquidation = 0 without dividing by zero', () => {
    const guard = new PerTradeLossCapGuard({ maxPercentOfEquity: 1 })
    const ctx = makeContext({
      operation: makePlaceOrderOp({
        lmtPrice: 100,
        stopPrice: 90,
        totalQuantity: new Decimal(100),
      }),
      account: { netLiquidation: '0' },
    })
    expect(guard.check(ctx)).toBeNull() // skip rather than crash
  })

  it('uses 1% as the default cap when no option is provided', () => {
    // 1% of 100k = $1000. Risk 100×$10=$1000 → at the cap boundary,
    // strict-greater-than reject means equality passes.
    const guard = new PerTradeLossCapGuard({})
    const ctx = makeContext({
      operation: makePlaceOrderOp({
        lmtPrice: 100,
        stopPrice: 90,
        totalQuantity: new Decimal(100),
      }),
    })
    expect(guard.check(ctx)).toBeNull()
  })

  it('respects custom maxPercentOfEquity', () => {
    // Cap 0.5% of 100k = $500. Risk = 500 → at boundary, allow.
    // Risk = 600 (qty 120, $5 risk) → over cap.
    const guard = new PerTradeLossCapGuard({ maxPercentOfEquity: 0.5 })
    const ctx = makeContext({
      operation: makePlaceOrderOp({
        lmtPrice: 100,
        stopPrice: 95,
        totalQuantity: new Decimal(120),
      }),
    })
    const result = guard.check(ctx)
    expect(result).toContain('$600')
  })
})

// ==================== MaxPositionsGuard ====================

describe('MaxPositionsGuard', () => {
  it('allows the first entry into an empty portfolio', () => {
    const guard = new MaxPositionsGuard({ max: 5 })
    const ctx = makeContext()
    expect(guard.check(ctx)).toBeNull()
  })

  it('allows up to max distinct symbols', () => {
    const guard = new MaxPositionsGuard({ max: 3 })
    const ctx = makeContext({
      operation: makePlaceOrderOp({ symbol: 'NVDA' }),
      positions: [
        makePosition({ contract: makeContract({ symbol: 'AAPL' }) }),
        makePosition({ contract: makeContract({ symbol: 'GOOG' }) }),
      ],
    })
    expect(guard.check(ctx)).toBeNull()
  })

  it('rejects an entry that would create the (max+1)-th open position', () => {
    const guard = new MaxPositionsGuard({ max: 3 })
    const ctx = makeContext({
      operation: makePlaceOrderOp({ symbol: 'TSLA' }),
      positions: [
        makePosition({ contract: makeContract({ symbol: 'AAPL' }) }),
        makePosition({ contract: makeContract({ symbol: 'GOOG' }) }),
        makePosition({ contract: makeContract({ symbol: 'NVDA' }) }),
      ],
    })
    const result = guard.check(ctx)
    expect(result).toContain('limit: 3')
    expect(result).toContain('AAPL')
    expect(result).toContain('GOOG')
    expect(result).toContain('NVDA')
  })

  it('allows adding to an existing position even at the max count', () => {
    // 3 positions, max 3 — adding to AAPL doesn't push count up.
    const guard = new MaxPositionsGuard({ max: 3 })
    const ctx = makeContext({
      operation: makePlaceOrderOp({ symbol: 'AAPL' }),
      positions: [
        makePosition({ contract: makeContract({ symbol: 'AAPL' }) }),
        makePosition({ contract: makeContract({ symbol: 'GOOG' }) }),
        makePosition({ contract: makeContract({ symbol: 'NVDA' }) }),
      ],
    })
    expect(guard.check(ctx)).toBeNull()
  })

  it('does not count zero-quantity (closed) positions', () => {
    // Some brokers (Alpaca) keep entries with qty=0 for previously
    // held symbols. Those shouldn't count toward the cap.
    const guard = new MaxPositionsGuard({ max: 2 })
    const ctx = makeContext({
      operation: makePlaceOrderOp({ symbol: 'TSLA' }),
      positions: [
        makePosition({ contract: makeContract({ symbol: 'AAPL' }) }),
        makePosition({
          contract: makeContract({ symbol: 'OLDTICK' }),
          quantity: new Decimal(0),
        }),
      ],
    })
    expect(guard.check(ctx)).toBeNull() // only 1 open position counts
  })

  it('skips SELL (exit) orders', () => {
    const guard = new MaxPositionsGuard({ max: 2 })
    const ctx = makeContext({
      operation: makePlaceOrderOp({ action: 'SELL', symbol: 'TSLA' }),
      positions: [
        makePosition({ contract: makeContract({ symbol: 'AAPL' }) }),
        makePosition({ contract: makeContract({ symbol: 'GOOG' }) }),
      ],
    })
    expect(guard.check(ctx)).toBeNull()
  })

  it('skips non-placeOrder operations', () => {
    const guard = new MaxPositionsGuard({ max: 1 })
    const ctx = makeContext({
      operation: { action: 'closePosition', contract: makeContract({ symbol: 'AAPL' }) },
    })
    expect(guard.check(ctx)).toBeNull()
  })

  it('uses 5 as the default max when no option is provided', () => {
    const guard = new MaxPositionsGuard({})
    const ctx = makeContext({
      operation: makePlaceOrderOp({ symbol: 'NEW' }),
      positions: Array.from({ length: 5 }, (_, i) =>
        makePosition({ contract: makeContract({ symbol: `SYM${i}` }) }),
      ),
    })
    const result = guard.check(ctx)
    expect(result).toContain('limit: 5')
  })

  it('throws on construction with invalid max', () => {
    expect(() => new MaxPositionsGuard({ max: 0 })).toThrow(/positive integer/)
    expect(() => new MaxPositionsGuard({ max: -1 })).toThrow(/positive integer/)
  })
})

// ==================== DailyLossCapGuard ====================

describe('DailyLossCapGuard', () => {
  // Use UTC timezone in tests so dateKey math is predictable.
  // Production default is America/New_York; the guard handles it
  // identically — only the boundary moves.
  function makeGuard(opts: {
    cap?: number
    nowMs?: number
    nowFn?: () => number
  } = {}) {
    let nowMs = opts.nowMs ?? Date.UTC(2024, 5, 15, 14, 0, 0) // 2024-06-15 14:00 UTC
    return new DailyLossCapGuard({
      maxPercentOfEquity: opts.cap ?? 2,
      timezone: 'UTC',
      now: opts.nowFn ?? (() => nowMs),
      // setter for tests that need to advance time
      ...({} as Record<string, never>),
    })
  }

  it('allows the very first entry of the day (anchor capture)', async () => {
    const guard = makeGuard()
    const ctx = makeContext({
      operation: makePlaceOrderOp({ totalQuantity: new Decimal(10), lmtPrice: 100 }),
      account: { netLiquidation: '100000' },
    })
    expect(await guard.check(ctx)).toBeNull()
  })

  it('allows subsequent entries while still under the cap', async () => {
    const guard = makeGuard({ cap: 2 })
    // First call captures anchor at 100k.
    await guard.check(makeContext({
      operation: makePlaceOrderOp({ totalQuantity: new Decimal(10) }),
      account: { netLiquidation: '100000' },
    }))
    // Now equity dropped 1.5% — still under 2% cap.
    const result = await guard.check(makeContext({
      operation: makePlaceOrderOp({ totalQuantity: new Decimal(10) }),
      account: { netLiquidation: '98500' },
    }))
    expect(result).toBeNull()
  })

  it('rejects new entries once today P&L breaches -cap', async () => {
    const guard = makeGuard({ cap: 2 })
    await guard.check(makeContext({
      operation: makePlaceOrderOp({ totalQuantity: new Decimal(10) }),
      account: { netLiquidation: '100000' },
    }))
    // Equity dropped 2.5% — over cap.
    const result = await guard.check(makeContext({
      operation: makePlaceOrderOp({ totalQuantity: new Decimal(10) }),
      account: { netLiquidation: '97500' },
    }))
    expect(result).toContain('Daily loss cap hit')
    expect(result).toContain('-2.50%')
    expect(result).toContain('-2%')
  })

  it('resets the anchor when the calendar day rolls over', async () => {
    let nowMs = Date.UTC(2024, 5, 15, 14, 0, 0)
    const guard = new DailyLossCapGuard({
      maxPercentOfEquity: 2,
      timezone: 'UTC',
      now: () => nowMs,
    })

    // Day 1: anchor at 100k, then drops 3% (over cap).
    await guard.check(makeContext({
      operation: makePlaceOrderOp({ totalQuantity: new Decimal(10) }),
      account: { netLiquidation: '100000' },
    }))
    const blocked = await guard.check(makeContext({
      operation: makePlaceOrderOp({ totalQuantity: new Decimal(10) }),
      account: { netLiquidation: '97000' },
    }))
    expect(blocked).toContain('Daily loss cap hit')

    // Advance to next UTC day.
    nowMs = Date.UTC(2024, 5, 16, 14, 0, 0)

    // First check on day 2 → should reset anchor and allow.
    const allowed = await guard.check(makeContext({
      operation: makePlaceOrderOp({ totalQuantity: new Decimal(10) }),
      account: { netLiquidation: '97000' },
    }))
    expect(allowed).toBeNull()
  })

  it('does NOT cap SELL exits even when over the limit', async () => {
    const guard = makeGuard({ cap: 2 })
    await guard.check(makeContext({
      operation: makePlaceOrderOp({ totalQuantity: new Decimal(10) }),
      account: { netLiquidation: '100000' },
    }))
    // Way over cap, but a SELL must always be allowed (otherwise
    // stops can't fire and losses spiral).
    const result = await guard.check(makeContext({
      operation: makePlaceOrderOp({
        action: 'SELL',
        totalQuantity: new Decimal(10),
      }),
      account: { netLiquidation: '90000' },
    }))
    expect(result).toBeNull()
  })

  it('skips non-placeOrder operations', async () => {
    const guard = makeGuard()
    const ctx = makeContext({
      operation: { action: 'closePosition', contract: makeContract({ symbol: 'AAPL' }) },
    })
    expect(await guard.check(ctx)).toBeNull()
  })

  it('skips when netLiquidation is zero or negative', async () => {
    const guard = makeGuard()
    const ctx = makeContext({
      operation: makePlaceOrderOp({ totalQuantity: new Decimal(10) }),
      account: { netLiquidation: '0' },
    })
    expect(await guard.check(ctx)).toBeNull()
  })

  it('persists anchor across instances when accountId is set', async () => {
    const { mkdtemp, rm } = await import('fs/promises')
    const { tmpdir } = await import('os')
    const { join } = await import('path')
    const tmpRoot = await mkdtemp(join(tmpdir(), 'daily-cap-test-'))
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpRoot)

    try {
      const accountId = 'test-uta'
      const nowMs = Date.UTC(2024, 5, 15, 14, 0, 0)

      // Instance 1: capture anchor at 100k.
      const g1 = new DailyLossCapGuard({
        maxPercentOfEquity: 2,
        timezone: 'UTC',
        accountId,
        now: () => nowMs,
      })
      await g1.check(makeContext({
        operation: makePlaceOrderOp({ totalQuantity: new Decimal(10) }),
        account: { netLiquidation: '100000' },
      }))
      // Wait for fire-and-forget persist to flush.
      await new Promise(r => setTimeout(r, 30))

      // Instance 2 (simulates restart, same UTC day): equity dropped
      // 3% — must reject because anchor came back from disk.
      const g2 = new DailyLossCapGuard({
        maxPercentOfEquity: 2,
        timezone: 'UTC',
        accountId,
        now: () => nowMs,
      })
      const result = await g2.check(makeContext({
        operation: makePlaceOrderOp({ totalQuantity: new Decimal(10) }),
        account: { netLiquidation: '97000' },
      }))
      expect(result).toContain('Daily loss cap hit')
    } finally {
      cwdSpy.mockRestore()
      await rm(tmpRoot, { recursive: true, force: true })
    }
  })

  it('throws on construction with invalid maxPercentOfEquity', () => {
    expect(() => new DailyLossCapGuard({ maxPercentOfEquity: 0 })).toThrow(/positive number/)
    expect(() => new DailyLossCapGuard({ maxPercentOfEquity: -1 })).toThrow(/positive number/)
  })
})

// ==================== CircuitBreakerGuard ====================

describe('countConsecutiveLosses helper', () => {
  function commit(realizedPnL: string): GitCommit {
    // Minimal GitCommit shape — only stateAfter.realizedPnL is read.
    return {
      hash: 'h',
      parentHash: null,
      message: '',
      operations: [],
      results: [],
      stateAfter: {
        netLiquidation: '0',
        totalCashValue: '0',
        unrealizedPnL: '0',
        realizedPnL,
        positions: [],
        pendingOrders: [],
      },
      timestamp: '',
    }
  }

  it('returns 0 for empty log', () => {
    expect(countConsecutiveLosses([])).toBe(0)
  })

  it('returns 0 for a single commit (no previous to compare)', () => {
    expect(countConsecutiveLosses([commit('100')])).toBe(0)
  })

  it('counts a single losing close', () => {
    // Newest commit has lower realized PnL than previous → 1 loss.
    expect(countConsecutiveLosses([commit('80'), commit('100')])).toBe(1)
  })

  it('counts multiple consecutive losses', () => {
    // Newest first: 70 → 80 → 90 → 100 = 3 consecutive drops.
    expect(countConsecutiveLosses([
      commit('70'), commit('80'), commit('90'), commit('100'),
    ])).toBe(3)
  })

  it('breaks the streak on a winning close', () => {
    // Newest first: 70 (loss) → 80 (loss) → 100 (WIN) → 50 (no count, streak already broken)
    expect(countConsecutiveLosses([
      commit('70'), commit('80'), commit('100'), commit('50'),
    ])).toBe(2)
  })

  it('skips zero-delta commits without breaking the streak', () => {
    // Open-only / sync commits don't change realizedPnL — they
    // should neither count nor reset the streak.
    expect(countConsecutiveLosses([
      commit('70'), commit('80'), commit('80'), commit('100'),
    ])).toBe(2)
  })
})

describe('CircuitBreakerGuard', () => {
  function commit(realizedPnL: string): GitCommit {
    return {
      hash: 'h',
      parentHash: null,
      message: '',
      operations: [],
      results: [],
      stateAfter: {
        netLiquidation: '0',
        totalCashValue: '0',
        unrealizedPnL: '0',
        realizedPnL,
        positions: [],
        pendingOrders: [],
      },
      timestamp: '',
    }
  }

  it('allows entry when no losses', async () => {
    const guard = new CircuitBreakerGuard({ maxConsecutiveLosses: 5 })
    const ctx = makeContext({ recentCommits: [] })
    expect(await guard.check(ctx)).toBeNull()
  })

  it('allows entry when consecutive loss count is below threshold', async () => {
    const guard = new CircuitBreakerGuard({ maxConsecutiveLosses: 5 })
    // 3 consecutive losses, threshold 5 → still under.
    const commits = [commit('70'), commit('80'), commit('90'), commit('100')]
    expect(await guard.check(makeContext({ recentCommits: commits }))).toBeNull()
  })

  it('trips and rejects when consecutive losses hit the threshold', async () => {
    const guard = new CircuitBreakerGuard({ maxConsecutiveLosses: 3 })
    // Exactly 3 losses → triggers.
    const commits = [commit('70'), commit('80'), commit('90'), commit('100')]
    const result = await guard.check(makeContext({ recentCommits: commits }))
    expect(result).toContain('Circuit breaker triggered')
    expect(result).toContain('3 consecutive losses')
  })

  it('blocks subsequent entries during cooldown without re-evaluating', async () => {
    let nowMs = 1_000_000
    const guard = new CircuitBreakerGuard({
      maxConsecutiveLosses: 3,
      cooldownMinutes: 60,
      now: () => nowMs,
    })
    const commits = [commit('70'), commit('80'), commit('90'), commit('100')]

    // First trip
    const trip = await guard.check(makeContext({ recentCommits: commits }))
    expect(trip).toContain('Circuit breaker triggered')

    // 30 minutes later — still in cooldown
    nowMs += 30 * 60_000
    const blocked = await guard.check(makeContext({ recentCommits: commits }))
    expect(blocked).toContain('Circuit breaker tripped')
    expect(blocked).toContain('30min cooldown remaining')
  })

  it('clears the trip after cooldown expires and re-evaluates', async () => {
    let nowMs = 1_000_000
    const guard = new CircuitBreakerGuard({
      maxConsecutiveLosses: 3,
      cooldownMinutes: 60,
      now: () => nowMs,
    })
    const lossyCommits = [commit('70'), commit('80'), commit('90'), commit('100')]
    await guard.check(makeContext({ recentCommits: lossyCommits })) // trip

    // 61 minutes later — cooldown done. With a winning commit at the
    // top, the breaker should clear and allow new entries.
    nowMs += 61 * 60_000
    const winningCommits = [commit('200'), commit('70'), commit('80'), commit('90'), commit('100')]
    expect(await guard.check(makeContext({ recentCommits: winningCommits }))).toBeNull()
  })

  it('does NOT block SELL exits even when tripped', async () => {
    const guard = new CircuitBreakerGuard({ maxConsecutiveLosses: 3 })
    const commits = [commit('70'), commit('80'), commit('90'), commit('100')]
    await guard.check(makeContext({ recentCommits: commits })) // trip via a BUY check
    const result = await guard.check(makeContext({
      operation: makePlaceOrderOp({ action: 'SELL', totalQuantity: new Decimal(10) }),
      recentCommits: commits,
    }))
    expect(result).toBeNull()
  })

  it('skips non-placeOrder operations', async () => {
    const guard = new CircuitBreakerGuard({ maxConsecutiveLosses: 1 })
    const commits = [commit('70'), commit('100')] // 1 loss, would trip if BUY
    const ctx = makeContext({
      operation: { action: 'closePosition', contract: makeContract({ symbol: 'AAPL' }) },
      recentCommits: commits,
    })
    expect(await guard.check(ctx)).toBeNull()
  })

  it('persists the trip across instances', async () => {
    const { mkdtemp, rm } = await import('fs/promises')
    const { tmpdir } = await import('os')
    const { join } = await import('path')
    const tmpRoot = await mkdtemp(join(tmpdir(), 'cb-test-'))
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpRoot)

    try {
      const accountId = 'test-uta'
      const nowMs = 1_000_000
      const lossyCommits = [commit('70'), commit('80'), commit('90'), commit('100')]

      // Instance 1 — trip the breaker.
      const g1 = new CircuitBreakerGuard({
        maxConsecutiveLosses: 3,
        cooldownMinutes: 60,
        accountId,
        now: () => nowMs,
      })
      const trip = await g1.check(makeContext({ recentCommits: lossyCommits }))
      expect(trip).toContain('Circuit breaker triggered')
      // Wait for fire-and-forget persist to flush.
      await new Promise(r => setTimeout(r, 30))

      // Instance 2 (simulated restart, 30 min later) — must still be
      // in cooldown.
      const g2 = new CircuitBreakerGuard({
        maxConsecutiveLosses: 3,
        cooldownMinutes: 60,
        accountId,
        now: () => nowMs + 30 * 60_000,
      })
      const blocked = await g2.check(makeContext({ recentCommits: lossyCommits }))
      expect(blocked).toContain('Circuit breaker tripped')
    } finally {
      cwdSpy.mockRestore()
      await rm(tmpRoot, { recursive: true, force: true })
    }
  })

  it('throws on construction with invalid maxConsecutiveLosses', () => {
    expect(() => new CircuitBreakerGuard({ maxConsecutiveLosses: 0 })).toThrow(/positive integer/)
    expect(() => new CircuitBreakerGuard({ maxConsecutiveLosses: -1 })).toThrow(/positive integer/)
  })

  it('throws on construction with invalid cooldownMinutes', () => {
    expect(() => new CircuitBreakerGuard({ cooldownMinutes: 0 })).toThrow(/positive number/)
    expect(() => new CircuitBreakerGuard({ cooldownMinutes: -1 })).toThrow(/positive number/)
  })
})
