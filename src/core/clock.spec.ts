import { describe, it, expect } from 'vitest'
import { realClock, SimulatedClock, type Clock } from './clock.js'

describe('realClock', () => {
  it('returns a Date instance close to wall-clock time', () => {
    const before = Date.now()
    const t = realClock.now()
    const after = Date.now()
    expect(t).toBeInstanceOf(Date)
    expect(t.getTime()).toBeGreaterThanOrEqual(before)
    expect(t.getTime()).toBeLessThanOrEqual(after)
  })

  it('returns a fresh Date on each call', () => {
    const a = realClock.now()
    const b = realClock.now()
    // Different Date instances even if the millisecond happens to match —
    // catches the mistake of caching a single Date and re-returning it.
    expect(a).not.toBe(b)
  })
})

describe('SimulatedClock', () => {
  // ---- Construction ----

  it('starts at epoch 0 by default', () => {
    const c = new SimulatedClock()
    expect(c.now().getTime()).toBe(0)
  })

  it('accepts a Date start', () => {
    const start = new Date('2024-01-01T00:00:00Z')
    const c = new SimulatedClock(start)
    expect(c.now().getTime()).toBe(start.getTime())
  })

  it('accepts an ISO string start', () => {
    const c = new SimulatedClock('2024-06-15T12:00:00Z')
    expect(c.now().toISOString()).toBe('2024-06-15T12:00:00.000Z')
  })

  it('accepts an epoch-ms number start', () => {
    const c = new SimulatedClock(1_700_000_000_000)
    expect(c.now().getTime()).toBe(1_700_000_000_000)
  })

  it('rejects unparseable string input', () => {
    expect(() => new SimulatedClock('not a date')).toThrow(/cannot parse/)
  })

  it('rejects non-finite numeric input', () => {
    expect(() => new SimulatedClock(Number.NaN)).toThrow(/finite epoch ms/)
    expect(() => new SimulatedClock(Number.POSITIVE_INFINITY)).toThrow(/finite epoch ms/)
  })

  // ---- advanceBy ----

  it('advances by milliseconds', () => {
    const c = new SimulatedClock('2024-01-01T00:00:00Z')
    c.advanceBy(60_000)
    expect(c.now().toISOString()).toBe('2024-01-01T00:01:00.000Z')
  })

  it('allows zero advance (no-op)', () => {
    const c = new SimulatedClock(1000)
    c.advanceBy(0)
    expect(c.now().getTime()).toBe(1000)
  })

  it('rejects negative advance', () => {
    const c = new SimulatedClock(1000)
    expect(() => c.advanceBy(-1)).toThrow(/non-negative/)
  })

  it('rejects non-finite advance', () => {
    const c = new SimulatedClock(1000)
    expect(() => c.advanceBy(Number.NaN)).toThrow(/non-negative/)
    expect(() => c.advanceBy(Number.POSITIVE_INFINITY)).toThrow(/non-negative/)
  })

  // ---- advanceTo ----

  it('advances to an absolute target date', () => {
    const c = new SimulatedClock('2024-01-01T00:00:00Z')
    c.advanceTo('2024-12-31T00:00:00Z')
    expect(c.now().toISOString()).toBe('2024-12-31T00:00:00.000Z')
  })

  it('allows advancing to the same time (no-op)', () => {
    const c = new SimulatedClock(1000)
    c.advanceTo(1000)
    expect(c.now().getTime()).toBe(1000)
  })

  it('rejects rewind', () => {
    const c = new SimulatedClock('2024-06-15T00:00:00Z')
    expect(() => c.advanceTo('2024-01-01T00:00:00Z')).toThrow(/cannot rewind/)
  })

  // ---- Determinism ----

  it('returns the same time on repeated now() calls until advanced', () => {
    const c = new SimulatedClock('2024-01-01T00:00:00Z')
    const t1 = c.now().getTime()
    const t2 = c.now().getTime()
    const t3 = c.now().getTime()
    expect(t1).toBe(t2)
    expect(t2).toBe(t3)
  })

  it('returns fresh Date instances each call (not cached)', () => {
    const c = new SimulatedClock(1000)
    const a = c.now()
    const b = c.now()
    expect(a).not.toBe(b) // different objects
    expect(a.getTime()).toBe(b.getTime()) // same time
  })

  // ---- Interface compatibility ----

  it('SimulatedClock is assignable to the Clock interface', () => {
    // Compile-time check: this would fail typecheck if SimulatedClock
    // didn't satisfy Clock.
    const c: Clock = new SimulatedClock()
    expect(c.now()).toBeInstanceOf(Date)
  })
})
