/**
 * Guard Pipeline
 *
 * The only place that touches the account: assembles a GuardContext,
 * then passes it through the guard chain. Guards themselves never
 * see the account.
 */

import type { Operation, GitCommit } from '../git/types.js'
import type { IBroker } from '../brokers/types.js'
import type { OperationGuard, GuardContext } from './types.js'

export interface GuardPipelineOptions {
  /**
   * Lazy callback returning the most recent committed operations,
   * newest first. The pipeline calls this on every dispatch so the
   * commit log seen by guards is always fresh. Default: returns
   * empty array (i.e. guards that need history will simply see
   * nothing — safe degradation).
   */
  recentCommits?: () => readonly GitCommit[] | Promise<readonly GitCommit[]>
}

export function createGuardPipeline(
  dispatcher: (op: Operation) => Promise<unknown>,
  account: IBroker,
  guards: OperationGuard[],
  options: GuardPipelineOptions = {},
): (op: Operation) => Promise<unknown> {
  if (guards.length === 0) return dispatcher

  return async (op: Operation): Promise<unknown> => {
    const [positions, accountInfo, recentCommits] = await Promise.all([
      account.getPositions(),
      account.getAccount(),
      options.recentCommits ? Promise.resolve(options.recentCommits()) : Promise.resolve([]),
    ])

    const ctx: GuardContext = {
      operation: op,
      positions,
      account: accountInfo,
      recentCommits,
    }

    for (const guard of guards) {
      const rejection = await guard.check(ctx)
      if (rejection != null) {
        return { success: false, error: `[guard:${guard.name}] ${rejection}` }
      }
    }

    return dispatcher(op)
  }
}
