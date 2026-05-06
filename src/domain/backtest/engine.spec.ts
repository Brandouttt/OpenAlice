import { describe, it, expect } from 'vitest'
import Decimal from 'decimal.js'
import { Order, UNSET_DECIMAL } from '@traderalice/ibkr'
import { runBacktest } from './engine.js'
import type { Bar, Strategy } from './types.js'
import { MockBroker, makeContract } from '../trading/brokers/mock/index.js'
import '../trading/contract-ext.js'

// ==================== Helpers ====================

function makeBars(
  count: number,
  closes: number[],
  startDate = new Date('2024-01-01T00:00:00Z'),
): Bar[] {
  if (closes.length !== count) {
    throw new Error(`makeBars: ${count} bars requested but ${closes.length} closes provided`)
  }
  const oneDayMs = 24 * 60 * 60 * 1000
  return Array.from({ length: count }, (_, i) => {
    const close = closes[i]
    return {
      ts: new Date(startDate.getTime() + i * oneDayMs),
      open: String(close),
      high: String(close),
      low: String(close),
      close: String(close),
      volume: '1000',
    }
  })
}

function buyOnceStrategy(qty = 10): Strategy {
  let bought = false
  return async ({ broker, symbol, index }) => {
    if (bought || index !== 0) return
    bought = true
    const contract = makeContract({ symbol, aliceId: `mock-paper|${symbol}` })
    const order = new Order()
    order.action = 'BUY'
    order.orderType = 'MKT'
    order.totalQuantity = new Decimal(qty)
    order.lmtPrice = UNSET_DECIMAL
    order.auxPrice = UNSET_DECIMAL
    order.trailStopPrice = UNSET_DECIMAL
    order.trailingPercent = UNSET_DECIMAL
    order.cashQty = UNSET_DECIMAL
    await broker.placeOrder(contract, order)
  }
}

// ==================== Validation ====================

describe('runBacktest validation', () => {
  it('throws when fewer than 2 bars', async () => {
    const broker = new MockBroker({ cash: 10_000 })
    const strategy: Strategy = async () => {}
    await expect(
      runBacktest({ symbol: 'AAPL', bars: [], initialCash: 10_000, strategy }, broker),
    ).rejects.toThrow(/at least 2 bars/)
  })

  it('throws when initialCash is non-positive', async () => {
    const broker = new MockBroker({ cash: 0 })
    const bars = makeBars(2, [100, 101])
    const strategy: Strategy = async () => {}
    await expect(
      runBacktest({ symbol: 'AAPL', bars, initialCash: 0, strategy }, broker),
    ).rejects.toThrow(/initialCash must be positive/)
  })

  it('throws when bars are out of chronological order', async () => {
    const broker = new MockBroker({ cash: 10_000 })
    const bars = makeBars(2, [100, 101])
    bars[1].ts = new Date(bars[0].ts.getTime() - 1000) // rewind bar 1
    const strategy: Strategy = async () => {}
    await expect(
      runBacktest({ symbol: 'AAPL', bars, initialCash: 10_000, strategy }, broker),
    ).rejects.toThrow(/strictly chronological/)
  })
})

// ==================== Smoke: no-op strategy ====================

describe('runBacktest no-op strategy', () => {
  it('produces a flat equity curve with no trades', async () => {
    const broker = new MockBroker({ cash: 10_000 })
    const bars = makeBars(5, [100, 101, 102, 103, 104])
    const noop: Strategy = async () => {}

    const report = await runBacktest(
      { symbol: 'AAPL', bars, initialCash: 10_000, strategy: noop },
      broker,
    )

    expect(report.equityCurve).toHaveLength(5)
    // No positions → equity stays at the initial cash regardless of price moves
    for (const point of report.equityCurve) {
      expect(point.equity).toBe('10000')
    }
    expect(report.tradeCount).toBe(0)
    expect(report.totalReturn).toBe('0.00')
    // No volatility → Sharpe is NaN; report exposes that as-is.
    expect(report.sharpe).toBeNaN()
    expect(report.maxDrawdown).toBe('0.00')
  })
})

// ==================== Long-only follow-the-price ====================

describe('runBacktest long-only', () => {
  it('equity curve tracks price after first BUY', async () => {
    const broker = new MockBroker({ cash: 10_000 })
    // Prices double from 100 to 200 over 5 bars
    const bars = makeBars(5, [100, 125, 150, 175, 200])

    const report = await runBacktest(
      {
        symbol: 'AAPL',
        bars,
        initialCash: 10_000,
        strategy: buyOnceStrategy(10),
      },
      broker,
    )

    // After bar 0 buy at 100: cash drops by 1000 → 9000 cash + 10 shares.
    // bar 0 close 100: equity = 9000 + 10 × 100 = 10_000
    // bar 4 close 200: equity = 9000 + 10 × 200 = 11_000
    expect(report.equityCurve[0].equity).toBe('10000')
    expect(report.equityCurve[4].equity).toBe('11000')
    expect(report.tradeCount).toBe(1)
    // (11000 - 10000) / 10000 = 10%
    expect(report.totalReturn).toBe('10.00')
    // Monotonically increasing → drawdown 0
    expect(report.maxDrawdown).toBe('0.00')
    // Constructed positive returns → Sharpe finite
    expect(Number.isFinite(report.sharpe)).toBe(true)
    expect(report.sharpe).toBeGreaterThan(0)
  })

  it('records drawdown when prices reverse after entry', async () => {
    const broker = new MockBroker({ cash: 10_000 })
    // Up then down: 100 → 150 (peak equity 9500 + 1500 = ...wait, math:
    // After buy at 100: cash 9000, 10 shares.
    // bar 0 close 100: equity 10_000
    // bar 1 close 150: equity 9000 + 10×150 = 10_500 (peak)
    // bar 2 close 80:  equity 9000 + 10×80  = 9_800 (trough)
    // DD = (10_500 - 9_800) / 10_500 ≈ 0.0667 → "6.67"
    const bars = makeBars(3, [100, 150, 80])

    const report = await runBacktest(
      {
        symbol: 'AAPL',
        bars,
        initialCash: 10_000,
        strategy: buyOnceStrategy(10),
      },
      broker,
    )

    expect(report.equityCurve[1].equity).toBe('10500')
    expect(report.equityCurve[2].equity).toBe('9800')
    expect(Number(report.maxDrawdown)).toBeCloseTo(6.67, 1)
    expect(Number(report.totalReturn)).toBeCloseTo(-2.0, 1)
  })
})

// ==================== Deferred market fill (look-ahead elimination) ====================

describe('runBacktest with deferMarketFills broker', () => {
  it('fills market orders at next-bar OPEN, not same-bar close', async () => {
    const broker = new MockBroker({ cash: 10_000, deferMarketFills: true })

    // Bar 0: open 100, close 110.
    // Bar 1: open 200, close 210.
    // Bar 2: open 300, close 310.
    // If strategy buys on bar 0 (sees close 110) and fill happens at
    // bar 0 close (look-ahead) → cost would be 110 × 10 = 1100.
    // With next-bar fill → cost is bar 1 open 200 × 10 = 2000.
    const bars: Bar[] = [
      { ts: new Date('2024-01-01T00:00:00Z'), open: '100', high: '120', low: '90',  close: '110', volume: '1000' },
      { ts: new Date('2024-01-02T00:00:00Z'), open: '200', high: '220', low: '190', close: '210', volume: '1000' },
      { ts: new Date('2024-01-03T00:00:00Z'), open: '300', high: '320', low: '290', close: '310', volume: '1000' },
    ]

    const report = await runBacktest(
      { symbol: 'AAPL', bars, initialCash: 10_000, strategy: buyOnceStrategy(10) },
      broker,
    )

    // Bar 0: order pending, no fill. Equity = cash 10_000.
    expect(report.equityCurve[0].equity).toBe('10000')

    // Bar 1: pending market fills at open 200 → cash 10_000 - 2000 = 8000.
    // Mark-to-market at close 210: equity = 8000 + 10×210 = 10_100.
    expect(report.equityCurve[1].equity).toBe('10100')

    // Bar 2: no new orders. Open 300, close 310:
    // equity = 8000 + 10×310 = 11_100.
    expect(report.equityCurve[2].equity).toBe('11100')
  })

  it('strands orders placed on the final bar (no next bar to flush)', async () => {
    const broker = new MockBroker({ cash: 10_000, deferMarketFills: true })
    const bars: Bar[] = [
      { ts: new Date('2024-01-01T00:00:00Z'), open: '100', high: '110', low: '90',  close: '100', volume: '1000' },
      { ts: new Date('2024-01-02T00:00:00Z'), open: '100', high: '110', low: '90',  close: '100', volume: '1000' },
    ]

    // Strategy buys ONLY on the last bar (index 1 in this 2-bar test).
    const lastBarBuy: Strategy = async ({ broker, symbol, index }) => {
      if (index !== 1) return
      const contract = makeContract({ symbol, aliceId: `mock-paper|${symbol}` })
      const order = new Order()
      order.action = 'BUY'
      order.orderType = 'MKT'
      order.totalQuantity = new Decimal(10)
      order.lmtPrice = UNSET_DECIMAL
      order.auxPrice = UNSET_DECIMAL
      order.trailStopPrice = UNSET_DECIMAL
      order.trailingPercent = UNSET_DECIMAL
      order.cashQty = UNSET_DECIMAL
      await broker.placeOrder(contract, order)
    }

    const report = await runBacktest(
      { symbol: 'AAPL', bars, initialCash: 10_000, strategy: lastBarBuy },
      broker,
    )

    // tradeCount counts placeOrder calls, not fills — so the stranded
    // order shows up here. Equity stays at initial cash because the
    // order never executed.
    expect(report.tradeCount).toBe(1)
    expect(report.equityCurve[1].equity).toBe('10000')
  })

  it('charges commission + slippage through the engine path', async () => {
    const broker = new MockBroker({
      cash: 10_000,
      deferMarketFills: true,
      commissionPerShare: 0.005,
      commissionMin: 1,
      slippageBps: 10, // 0.10%
    })
    const bars: Bar[] = [
      { ts: new Date('2024-01-01T00:00:00Z'), open: '100', high: '110', low: '90',  close: '100', volume: '1000' },
      { ts: new Date('2024-01-02T00:00:00Z'), open: '100', high: '110', low: '90',  close: '100', volume: '1000' },
    ]

    await runBacktest(
      { symbol: 'AAPL', bars, initialCash: 10_000, strategy: buyOnceStrategy(10) },
      broker,
    )

    // Effective price = 100 × (1 + 0.001) = 100.10.
    // Gross = 10 × 100.10 = 1001. Commission = max(10×0.005, 1) = 1.
    // Cash after fill = 10_000 - 1001 - 1 = 8_998.
    const account = await broker.getAccount()
    expect(account.totalCashValue).toBe('8998')
    expect(broker.totalCommissionsPaid).toBe('1')
  })
})

// ==================== Quote injection ====================

describe('runBacktest quote handling', () => {
  it('uses MockBroker.setQuote per bar so getAccount reflects current close', async () => {
    const broker = new MockBroker({ cash: 10_000 })
    const bars = makeBars(3, [50, 200, 100])

    await runBacktest(
      {
        symbol: 'AAPL',
        bars,
        initialCash: 10_000,
        strategy: buyOnceStrategy(10),
      },
      broker,
    )

    // After the run the quote should be the last bar's close.
    const finalQuote = await broker.getQuote(makeContract({ symbol: 'AAPL' }))
    expect(finalQuote.last).toBe('100')
  })

  it('strips aliceId prefix when setting the quote', async () => {
    const broker = new MockBroker({ cash: 10_000 })
    const bars = makeBars(2, [100, 110])

    // Pass an aliceId-style symbol like the trading layer uses.
    await runBacktest(
      {
        symbol: 'mock-paper|AAPL',
        bars,
        initialCash: 10_000,
        strategy: buyOnceStrategy(10),
      },
      broker,
    )

    // setQuote should have been invoked with bare "AAPL", not the full aliceId.
    const quote = await broker.getQuote(makeContract({ symbol: 'AAPL' }))
    expect(quote.last).toBe('110')
  })
})
