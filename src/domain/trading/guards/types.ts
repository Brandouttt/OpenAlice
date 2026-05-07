import type { Operation, GitCommit } from '../git/types.js'
import type { Position, AccountInfo } from '../brokers/types.js'

/** Read-only context assembled by the pipeline, consumed by guards. */
export interface GuardContext {
  readonly operation: Operation
  readonly positions: readonly Position[]
  readonly account: Readonly<AccountInfo>
  /**
   * Most recent committed operations, newest first. Capped to a
   * small window (default 20) so this is cheap to assemble per
   * check. Empty for accounts with no committed history yet.
   *
   * Guards that need per-trade outcome data (e.g. circuit-breaker
   * counting consecutive realized losses) read from here. Guards
   * that don't can ignore it.
   */
  readonly recentCommits: readonly GitCommit[]
}

/** A guard that can reject operations. Returns null to allow, or a rejection reason string. */
export interface OperationGuard {
  readonly name: string
  check(ctx: GuardContext): Promise<string | null> | string | null
}

/** Registry entry: type identifier + factory function. */
export interface GuardRegistryEntry {
  type: string
  create(options: Record<string, unknown>): OperationGuard
}
