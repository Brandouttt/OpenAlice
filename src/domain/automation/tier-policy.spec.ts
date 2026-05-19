import { describe, it, expect } from 'vitest'
import Decimal from 'decimal.js'
import { Order, UNSET_DECIMAL } from '@traderalice/ibkr'
import { Contract } from '@traderalice/ibkr'
import { createTierPolicy, DEFAULT_TIER_POLICY } from './tier-policy.js'

function makeContract(symbol: string): Contract {
  const c = new Contract()
  c.symbol = symbol
  c.secType = 'STK'
  c.currency = 'USD'
  c.exchange = 'SMART'
  return c
}

function makeOrder(opts: { action?: string; qty?: number; lmtPrice?: number; cashQty?: number } = {}): Order {
  const order = new Order()
  order.action = (opts.action as 'BUY' | 'SELL') ?? 'BUY'
  order.orderType = opts.lmtPrice != null ? 'LMT' : 'MKT'
  order.totalQuantity = opts.qty != null ? new Decimal(opts.qty) : UNSET_DECIMAL
  order.lmtPrice = opts.lmtPrice != null ? new Decimal(opts.lmtPrice) : UNSET_DECIMAL
  order.auxPrice = UNSET_DECIMAL
  order.trailStopPrice = UNSET_DECIMAL
  order.trailingPercent = UNSET_DECIMAL
  order.cashQty = opts.cashQty != null ? new Decimal(opts.cashQty) : UNSET_DECIMAL
  return order
}

// ==================== Tier classification ====================

describe('TierPolicy.classify — notional thresholds', () => {
  it('classifies small notional as auto-push', () => {
    const policy = createTierPolicy(DEFAULT_TIER_POLICY)
    const result = policy.classify({
      contract: makeContract('NVDA'),
      order: makeOrder({ qty: 1, lmtPrice: 100 }), // $100
      balance: '4000',
    })
    expect(result.decision).toBe('auto-push')
  })

  it('classifies tier-2 notional as hitl', () => {
    const policy = createTierPolicy(DEFAULT_TIER_POLICY)
    const result = policy.classify({
      contract: makeContract('NVDA'),
      order: makeOrder({ qty: 5, lmtPrice: 100 }), // $500
      balance: '4000',
    })
    expect(result.decision).toBe('hitl')
  })

  it('classifies above tier-2 cap as hard-stop', () => {
    const policy = createTierPolicy(DEFAULT_TIER_POLICY)
    const result = policy.classify({
      contract: makeContract('NVDA'),
      order: makeOrder({ qty: 50, lmtPrice: 100 }), // $5000
      balance: '4000',
    })
    expect(result.decision).toBe('hard-stop')
  })

  it('honours custom thresholds', () => {
    const policy = createTierPolicy({
      tier1MaxNotional: 100,
      tier2MaxNotional: 500,
    })

    expect(policy.classify({
      contract: makeContract('NVDA'),
      order: makeOrder({ qty: 1, lmtPrice: 50 }), // $50
      balance: '4000',
    }).decision).toBe('auto-push')

    expect(policy.classify({
      contract: makeContract('NVDA'),
      order: makeOrder({ qty: 1, lmtPrice: 200 }), // $200
      balance: '4000',
    }).decision).toBe('hitl')

    expect(policy.classify({
      contract: makeContract('NVDA'),
      order: makeOrder({ qty: 10, lmtPrice: 100 }), // $1000
      balance: '4000',
    }).decision).toBe('hard-stop')
  })
})

// ==================== Boundary conditions ====================

describe('TierPolicy.classify — boundaries', () => {
  it('exactly at tier1 cap is auto-push (inclusive)', () => {
    const policy = createTierPolicy({ tier1MaxNotional: 300, tier2MaxNotional: 1000 })
    const r = policy.classify({
      contract: makeContract('X'),
      order: makeOrder({ qty: 3, lmtPrice: 100 }), // $300
      balance: '4000',
    })
    expect(r.decision).toBe('auto-push')
  })

  it('one penny over tier1 cap is hitl', () => {
    const policy = createTierPolicy({ tier1MaxNotional: 300, tier2MaxNotional: 1000 })
    const r = policy.classify({
      contract: makeContract('X'),
      order: makeOrder({ qty: 3, lmtPrice: 100.01 }), // $300.03
      balance: '4000',
    })
    expect(r.decision).toBe('hitl')
  })
})

// ==================== ETF exemption ====================

describe('TierPolicy.classify — ETF exemption', () => {
  it('does NOT exempt by default', () => {
    const policy = createTierPolicy(DEFAULT_TIER_POLICY)
    const r = policy.classify({
      contract: makeContract('SPY'),
      order: makeOrder({ qty: 5, lmtPrice: 500 }), // $2500
      balance: '4000',
    })
    expect(r.decision).toBe('hard-stop') // size still matters
  })

  it('exempts known ETF when tier1EtfOnly=true', () => {
    const policy = createTierPolicy({
      ...DEFAULT_TIER_POLICY,
      tier1EtfOnly: true,
    })
    const r = policy.classify({
      contract: makeContract('SPY'),
      order: makeOrder({ qty: 5, lmtPrice: 500 }), // $2500
      balance: '4000',
    })
    expect(r.decision).toBe('auto-push')
    expect(r.reason).toContain('ETF')
  })

  it('does NOT exempt non-ETF when tier1EtfOnly=true', () => {
    const policy = createTierPolicy({
      ...DEFAULT_TIER_POLICY,
      tier1EtfOnly: true,
    })
    const r = policy.classify({
      contract: makeContract('NVDA'),
      order: makeOrder({ qty: 10, lmtPrice: 100 }), // $1000 — Tier 2
      balance: '4000',
    })
    expect(r.decision).toBe('hitl')
  })
})

// ==================== Notional estimation ====================

describe('TierPolicy.classify — notional estimation', () => {
  it('uses cashQty when set', () => {
    const policy = createTierPolicy({ tier1MaxNotional: 100, tier2MaxNotional: 500 })
    const r = policy.classify({
      contract: makeContract('NVDA'),
      order: makeOrder({ cashQty: 200 }), // $200 explicit
      balance: '4000',
    })
    expect(r.notional).toBe('200')
    expect(r.decision).toBe('hitl')
  })

  it('uses priceHint when no lmtPrice', () => {
    const policy = createTierPolicy({ tier1MaxNotional: 100, tier2MaxNotional: 500 })
    const r = policy.classify({
      contract: makeContract('NVDA'),
      order: makeOrder({ qty: 2 }), // MKT order, no lmt
      priceHint: '120',
      balance: '4000',
    })
    expect(r.notional).toBe('240')
    expect(r.decision).toBe('hitl')
  })

  it('uses $100 fallback when neither lmtPrice nor priceHint available', () => {
    const policy = createTierPolicy({ tier1MaxNotional: 50, tier2MaxNotional: 200 })
    const r = policy.classify({
      contract: makeContract('NVDA'),
      order: makeOrder({ qty: 1 }), // MKT, no hint → $100 fallback
      balance: '4000',
    })
    expect(r.notional).toBe('100')
    expect(r.decision).toBe('hitl')
  })
})
