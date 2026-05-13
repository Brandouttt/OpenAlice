import { describe, it, expect } from 'vitest'
import { sma, makeSmaCrossover, smaCrossoverStrategy } from './sma-crossover.js'

describe('sma helper', () => {
  it('returns null when not enough data', () => {
    expect(sma([1, 2, 3], 5)).toBeNull()
  })

  it('computes the average over the last `period` values', () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toBe(4) // (3+4+5)/3
    expect(sma([10, 20, 30], 3)).toBe(20)
  })

  it('uses the last N values when more data is provided than needed', () => {
    expect(sma([100, 100, 100, 1, 2, 3], 3)).toBe(2) // (1+2+3)/3
  })
})

describe('makeSmaCrossover validation', () => {
  it('rejects fast >= slow', () => {
    expect(() => makeSmaCrossover({ fast: 50, slow: 50, qty: 10 })).toThrow(
      /must be less than slow/,
    )
    expect(() => makeSmaCrossover({ fast: 60, slow: 50, qty: 10 })).toThrow(
      /must be less than slow/,
    )
  })

  it('rejects non-positive periods or qty', () => {
    expect(() => makeSmaCrossover({ fast: 0, slow: 50, qty: 10 })).toThrow(/>= 1/)
    expect(() => makeSmaCrossover({ fast: 20, slow: 0, qty: 10 })).toThrow(/>= 1/)
    expect(() => makeSmaCrossover({ fast: 20, slow: 50, qty: 0 })).toThrow(/>= 1/)
  })
})

describe('makeSmaCrossover state introspection', () => {
  it('starts in flat position', () => {
    const strategy = makeSmaCrossover({ fast: 5, slow: 20, qty: 10 })
    const state = strategy.getState()
    expect(state.position).toBe('flat')
    expect(state.details).toMatchObject({ inPosition: false, fast: 5, slow: 20, qty: 10 })
  })

  it('resetState restores flat position even after many calls', () => {
    const strategy = makeSmaCrossover({ fast: 5, slow: 20, qty: 10 })
    // Force inPosition=true by reading then setting through resetState
    // We can't externally toggle without an entry signal, so verify
    // resetState is at least callable and idempotent.
    strategy.resetState()
    expect(strategy.getState().position).toBe('flat')
    strategy.resetState()
    expect(strategy.getState().position).toBe('flat')
  })

  it('getState reports parameters in details', () => {
    const strategy = makeSmaCrossover({ fast: 7, slow: 21, qty: 50 })
    const details = strategy.getState().details
    expect(details).toMatchObject({ fast: 7, slow: 21, qty: 50 })
  })
})

describe('smaCrossoverStrategy registry entry', () => {
  it('exposes the canonical metadata', () => {
    expect(smaCrossoverStrategy.metadata.name).toBe('sma-crossover')
    expect(smaCrossoverStrategy.metadata.warmupBars).toBeGreaterThanOrEqual(50)
    expect(smaCrossoverStrategy.metadata.marketRegime).toBe('trending')
  })

  it('factory accepts overridden params', () => {
    // Should not throw for a valid override.
    const strategy = smaCrossoverStrategy.factory({ fast: 5, slow: 20, qty: 50 })
    expect(typeof strategy).toBe('function')
  })

  it('factory falls back to defaults for missing params', () => {
    const strategy = smaCrossoverStrategy.factory({})
    expect(typeof strategy).toBe('function')
  })

  it('factory propagates validation errors', () => {
    expect(() => smaCrossoverStrategy.factory({ fast: 100, slow: 50 })).toThrow(
      /must be less than slow/,
    )
  })
})
