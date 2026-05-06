import { describe, it, expect } from 'vitest'
import {
  returnsFromEquityCurve,
  sharpe,
  maxDrawdown,
  totalReturn,
} from './metrics.js'

describe('returnsFromEquityCurve', () => {
  it('returns empty for fewer than 2 points', () => {
    expect(returnsFromEquityCurve([])).toEqual([])
    expect(returnsFromEquityCurve([100])).toEqual([])
  })

  it('computes simple period returns', () => {
    expect(returnsFromEquityCurve([100, 110])).toEqual([0.1])
    expect(returnsFromEquityCurve([100, 110, 99])).toEqual([0.1, -0.1])
  })

  it('skips zero-prior pairs to avoid divide-by-zero', () => {
    // [0, 100, 110] → first pair is 0 → 100, ratio undefined; skip.
    // Second pair 100 → 110 contributes 0.1.
    expect(returnsFromEquityCurve([0, 100, 110])).toEqual([0.1])
  })
})

describe('sharpe', () => {
  it('NaN when fewer than 2 returns', () => {
    expect(sharpe([], 0, 252)).toBeNaN()
    expect(sharpe([0.01], 0, 252)).toBeNaN()
  })

  it('NaN when std dev is zero (constant returns)', () => {
    expect(sharpe([0.01, 0.01, 0.01], 0, 252)).toBeNaN()
  })

  it('annualizes daily returns by sqrt(252)', () => {
    // Constructed: returns with mean 0.001 and known std → expect a
    // specific annualized number. Use simple [0.002, 0.000] → mean
    // 0.001, sample std ≈ 0.001414. Annualized:
    //   sharpe = (0.001 / 0.001414) × sqrt(252) ≈ 0.7071 × 15.875 ≈ 11.23
    const s = sharpe([0.002, 0.000], 0, 252)
    expect(s).toBeCloseTo(11.225, 1)
  })

  it('subtracts risk-free rate per period', () => {
    // riskFreeAnnual=0.252, periodsPerYear=252 → rf_per_period=0.001
    // returns=[0.002, 0.000] → mean 0.001 → numerator becomes 0
    const s = sharpe([0.002, 0.000], 0.252, 252)
    expect(s).toBeCloseTo(0, 6)
  })
})

describe('maxDrawdown', () => {
  it('zero for monotonically increasing curve', () => {
    expect(maxDrawdown([100, 110, 120, 130])).toBe(0)
  })

  it('zero for length-0 or length-1 curve', () => {
    expect(maxDrawdown([])).toBe(0)
    expect(maxDrawdown([100])).toBe(0)
  })

  it('catches simple peak-to-trough drop', () => {
    // 100 → 120 (peak) → 90 (trough). DD = (120-90)/120 = 0.25
    expect(maxDrawdown([100, 120, 90])).toBeCloseTo(0.25, 6)
  })

  it('uses the WORST peak-to-trough across the whole curve', () => {
    // 100 → 110 → 80 (DD 0.273) → 90 → 70 (peak still 110, DD 0.364) → 200
    // Worst drawdown is from peak 110 to trough 70 = (110-70)/110 ≈ 0.3636
    expect(maxDrawdown([100, 110, 80, 90, 70, 200])).toBeCloseTo(0.3636, 3)
  })

  it('keeps the peak as the curve advances', () => {
    // Equity hits new high at 130, then drops to 100. DD = 30/130 ≈ 0.231
    expect(maxDrawdown([100, 110, 130, 100])).toBeCloseTo(0.2308, 3)
  })
})

describe('totalReturn', () => {
  it('zero for length < 2', () => {
    expect(totalReturn([])).toBe(0)
    expect(totalReturn([100])).toBe(0)
  })

  it('zero when start equity is zero', () => {
    expect(totalReturn([0, 100])).toBe(0)
  })

  it('computes (end-start)/start', () => {
    expect(totalReturn([100, 120])).toBeCloseTo(0.2, 6)
    expect(totalReturn([100, 90])).toBeCloseTo(-0.1, 6)
  })

  it('only looks at endpoints, ignores intermediate', () => {
    expect(totalReturn([100, 50, 150, 200, 110])).toBeCloseTo(0.1, 6)
  })
})
