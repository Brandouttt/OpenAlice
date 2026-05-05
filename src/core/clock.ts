/**
 * Clock — abstraction over wall-clock time so simulated time
 * (backtests, replay) can swap in without monkey-patching Date.
 *
 * Minimum surface area on purpose. Only `now()` is here. If a
 * future caller needs controllable setTimeout / setInterval,
 * extend the interface and the two implementations together.
 *
 * Default consumers should accept `Clock` as an optional
 * dependency and fall back to `realClock` when absent — a
 * RealClock instance is process-wide stateless and shareable.
 */

export interface Clock {
  /** Current time, as a Date. Replaces `new Date()` / `new Date(Date.now())`. */
  now(): Date
}

// ==================== RealClock ====================

class RealClockImpl implements Clock {
  now(): Date {
    return new Date()
  }
}

/**
 * Process-wide RealClock singleton. Stateless, safe to share. Most
 * production callsites should reference this directly rather than
 * instantiating their own.
 */
export const realClock: Clock = new RealClockImpl()

// ==================== SimulatedClock ====================

/**
 * Manually-advanced clock for tests and backtests. Time only moves
 * forward, only on explicit `advanceBy` / `advanceTo` calls.
 */
export class SimulatedClock implements Clock {
  private _epochMs: number

  constructor(start: Date | number | string = 0) {
    this._epochMs = SimulatedClock.toEpochMs(start)
  }

  now(): Date {
    return new Date(this._epochMs)
  }

  /** Move the clock forward by `ms` milliseconds. Negative input rejected. */
  advanceBy(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new Error(`SimulatedClock.advanceBy: ms must be a non-negative finite number, got ${ms}`)
    }
    this._epochMs += ms
  }

  /**
   * Move the clock forward to the given target. Rejects targets in
   * the past — simulated time is monotonic by design, so going
   * backwards is a logic bug, not a use case.
   */
  advanceTo(target: Date | number | string): void {
    const targetMs = SimulatedClock.toEpochMs(target)
    if (targetMs < this._epochMs) {
      throw new Error(
        `SimulatedClock.advanceTo: cannot rewind from ${new Date(this._epochMs).toISOString()} ` +
        `to ${new Date(targetMs).toISOString()}`,
      )
    }
    this._epochMs = targetMs
  }

  private static toEpochMs(input: Date | number | string): number {
    if (input instanceof Date) return input.getTime()
    if (typeof input === 'number') {
      if (!Number.isFinite(input)) {
        throw new Error(`SimulatedClock: numeric time must be a finite epoch ms value, got ${input}`)
      }
      return input
    }
    const parsed = Date.parse(input)
    if (Number.isNaN(parsed)) {
      throw new Error(`SimulatedClock: cannot parse "${input}" as a date`)
    }
    return parsed
  }
}
