/**
 * ITradingGit — Trading-as-Git interface
 *
 * Git-style three-phase workflow for trading operations:
 *   add → commit → push → log / show / status
 */

import type {
  CommitHash,
  Operation,
  AddResult,
  CommitPrepareResult,
  PushResult,
  RejectResult,
  GitStatus,
  GitCommit,
  CommitLogEntry,
  GitExportState,
  GitState,
  PriceChangeInput,
  SimulatePriceChangeResult,
  OrderStatusUpdate,
  SyncResult,
} from './types.js'

export interface ITradingGit {
  // ---- git add / commit / push ----

  add(operation: Operation): AddResult
  commit(message: string): CommitPrepareResult
  push(): Promise<PushResult>
  reject(reason?: string): Promise<RejectResult>

  // ---- git log / show / status ----

  log(options?: { limit?: number; symbol?: string }): CommitLogEntry[]
  show(hash: CommitHash): GitCommit | null
  status(): GitStatus

  /**
   * Most recent commits as full GitCommit objects (newest first).
   * Differs from `log()` which returns lighter CommitLogEntry summaries.
   * Used by guards that need per-commit P&L (stateAfter.realizedPnL).
   */
  recentCommits(limit: number): GitCommit[]

  // ---- git pull (sync pending orders) ----

  sync(updates: OrderStatusUpdate[], currentState: GitState): Promise<SyncResult>
  getPendingOrderIds(): Array<{ orderId: string; symbol: string }>

  // ---- serialization ----

  exportState(): GitExportState
  setCurrentRound(round: number): void

  // ---- simulation ----

  simulatePriceChange(priceChanges: PriceChangeInput[]): Promise<SimulatePriceChangeResult>
}

export interface TradingGitConfig {
  executeOperation: (operation: Operation) => Promise<unknown>
  getGitState: () => Promise<GitState>
  onCommit?: (state: GitExportState) => void | Promise<void>
}
