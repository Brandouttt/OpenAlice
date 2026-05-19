/**
 * Strategy worker — periodic automation runner.
 *
 * Registers a cron job (`__strategy-worker__`) and a `cron.fire`
 * listener. On every tick:
 *
 *   1. Read enabled entries from AutomationStore.
 *   2. For each entry, look up the UTA + the registered strategy.
 *   3. Fetch the latest historical bars via EquityClientLike.
 *   4. Look up or build a Strategy closure from a per-key cache.
 *   5. Call strategy(ctx) with the latest bar.
 *
 * The cache key is automationKey(entry) — the (accountId, symbol,
 * strategyName) triple. Closures persist for the worker's lifetime
 * so the strategy keeps its position state across ticks. Process
 * restart wipes the cache; the strategy starts from `flat` again,
 * which is documented limitation 3 (broker may already hold a
 * position from a prior session — see Phase 3.6 doc).
 *
 * Failure isolation: one bad entry (unknown strategy, network
 * error, strategy throws) is logged and skipped. The loop never
 * dies on a single failure.
 *
 * Order routing: strategies call ctx.broker.placeOrder() directly
 * on the UTA's broker. That goes through the UTA's guard pipeline
 * but NOT through TradingGit stage/commit/push. Phase 3.3
 * approval-tier guard, when added, will route through staging so
 * the user sees pending orders in PushApprovalPanel before they
 * fill. For now: orders auto-fill.
 */

import type { EventLogEntry } from '../../core/event-log.js'
import type { CronFirePayload } from '../../core/agent-event.js'
import type { CronEngine } from '../../task/cron/engine.js'
import type { Listener } from '../../core/listener.js'
import type { ListenerRegistry } from '../../core/listener-registry.js'
import type { UTAManager } from '../trading/uta-manager.js'
import type { EquityClientLike } from '../market-data/client/types.js'
import type { ConnectorCenter } from '../../core/connector-center.js'
import type { AutomationStore } from './store.js'
import type { Strategy, Bar } from '../backtest/types.js'
import { getStrategy } from '../strategy/index.js'
import { automationKey, type AutomationEntry } from './types.js'
import { GitTrackedBroker } from './git-tracked-broker.js'
import { createTierPolicy, DEFAULT_TIER_POLICY, type TierPolicyConfig } from './tier-policy.js'

const STRATEGY_WORKER_JOB_NAME = '__strategy-worker__'

const DEFAULT_HISTORY_BARS = 60 // bars to fetch per tick — enough warmup for all v1 strategies

export interface StrategyWorkerConfig {
  enabled: boolean
  /** Cron `every` spec, e.g. "5m", "1h". */
  every: string
  /** How many recent daily bars to fetch per tick. Default 60. */
  historyBars?: number
  /**
   * Tier policy used by GitTrackedBroker to classify orders into
   * auto-push / HITL / hard-stop. Default DEFAULT_TIER_POLICY (300 / 1000).
   */
  tierPolicy?: TierPolicyConfig
}

export interface StrategyWorker {
  start(): Promise<void>
  stop(): void
  /** Manual trigger — used by tests and the "run now" UI button. */
  tick(): Promise<StrategyWorkerTickReport>
  readonly listener: Listener<'cron.fire'>
}

export interface StrategyWorkerTickReport {
  processed: number
  errors: Array<{ entry: AutomationEntry; error: string }>
}

export function createStrategyWorker(deps: {
  store: AutomationStore
  utaManager: UTAManager
  equityClient: EquityClientLike
  cronEngine: CronEngine
  registry: ListenerRegistry
  config: StrategyWorkerConfig
  /**
   * Optional. When set, the worker pushes a notification through
   * connectorCenter (Telegram + Web) whenever a strategy creates a
   * new HITL-pending commit. Without this, the user must manually
   * open the trading panel to see pending orders.
   */
  connectorCenter?: ConnectorCenter
}): StrategyWorker {
  const { store, utaManager, equityClient, cronEngine, registry, config, connectorCenter } = deps
  const historyBars = config.historyBars ?? DEFAULT_HISTORY_BARS
  const tierPolicy = createTierPolicy(config.tierPolicy ?? DEFAULT_TIER_POLICY)

  // Strategy closure cache, keyed by automationKey. Survives across
  // ticks but not across process restarts.
  const strategyCache = new Map<string, Strategy>()

  let processing = false
  let registered = false

  async function tick(): Promise<StrategyWorkerTickReport> {
    const report: StrategyWorkerTickReport = { processed: 0, errors: [] }
    const enabled = await store.listEnabled()

    for (const entry of enabled) {
      try {
        await processEntry(entry)
        report.processed++
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        report.errors.push({ entry, error: msg })
        console.warn(
          `strategy-worker: ${entry.accountId}/${entry.symbol}/${entry.strategyName} failed:`,
          msg,
        )
      }
    }

    return report
  }

  async function processEntry(entry: AutomationEntry): Promise<void> {
    // 1. Resolve the UTA
    const uta = utaManager.get(entry.accountId)
    if (!uta) {
      throw new Error(`UTA not found: ${entry.accountId}`)
    }
    if (uta.disabled) {
      // Skip silently — disabled UTAs are an operator-intent signal.
      return
    }

    // 2. Resolve the strategy from registry
    const registered = getStrategy(entry.strategyName)
    if (!registered) {
      throw new Error(`Unknown strategy: ${entry.strategyName}`)
    }

    // 3. Fetch bars
    const bars = await fetchBars(entry.symbol)
    if (bars.length < 2) {
      throw new Error(`Insufficient bars (got ${bars.length}, need ≥2)`)
    }

    // 4. Get-or-build strategy closure
    const key = automationKey(entry)
    let strategy = strategyCache.get(key)
    if (!strategy) {
      strategy = registered.factory({
        ...registered.metadata.defaults,
        ...entry.params,
      })
      strategyCache.set(key, strategy)
    }

    // 5. Wrap the broker so strategy orders flow through TradingGit.
    //    Tier policy decides auto-push vs HITL approval vs hard-stop.
    //    Read methods delegate straight to the underlying broker.
    const trackedBroker = new GitTrackedBroker({
      inner: uta.broker,
      uta,
      tierPolicy,
      strategyName: entry.strategyName,
    })

    // 6. Capture pre-call pending state so we can detect a new
    //    HITL commit after the strategy runs.
    const pendingBefore = uta.status().pendingHash

    // 7. Call strategy with the latest bar.
    //
    // The worker presents the FULL recent history (last `historyBars`
    // entries). The strategy reads from `history` and decides on the
    // last one (`bar`). This matches the BacktestEngine's ctx shape so
    // strategy code is identical in backtest and live.
    const latestBar = bars[bars.length - 1]
    await strategy({
      bar: latestBar,
      history: bars,
      index: bars.length - 1,
      broker: trackedBroker,
      symbol: entry.symbol,
    })

    // 8. If a new HITL commit was created by the strategy, push a
    //    notification through the connector center so the user
    //    sees it on mobile / Web UI.
    const statusAfter = uta.status()
    if (
      connectorCenter &&
      statusAfter.pendingHash &&
      statusAfter.pendingHash !== pendingBefore
    ) {
      const opCount = statusAfter.staged.length
      const text =
        `📋 ${entry.strategyName} on ${entry.symbol} (${entry.accountId}) ` +
        `staged ${opCount} op${opCount > 1 ? 's' : ''} for approval. ` +
        `Open /trading on Telegram or the Trading panel to Approve / Reject.`
      try {
        await connectorCenter.notify(text, { source: 'strategy-worker' })
      } catch (err) {
        console.warn(
          'strategy-worker: notify failed:',
          err instanceof Error ? err.message : err,
        )
      }
    }
  }

  async function fetchBars(symbol: string): Promise<Bar[]> {
    // Fetch the last `historyBars` daily bars via the typebb /
    // OpenBB equity client. We use yesterday as end_date and an
    // approximate start `historyBars × 1.5` days back to allow for
    // weekends + holidays.
    const end = new Date()
    const startMs = end.getTime() - Math.ceil(historyBars * 1.5) * 24 * 60 * 60 * 1000
    const start = new Date(startMs)

    const rows = (await equityClient.getHistorical({
      symbol,
      start_date: start.toISOString().slice(0, 10),
      end_date: end.toISOString().slice(0, 10),
      interval: '1d',
      provider: 'yfinance',
    })) as Array<{
      date: string
      open: number | null
      high: number | null
      low: number | null
      close: number | null
      volume: number | null
    }>

    const bars: Bar[] = []
    for (const r of rows) {
      if (r.open == null || r.high == null || r.low == null || r.close == null) continue
      bars.push({
        ts: new Date(r.date),
        open: String(r.open),
        high: String(r.high),
        low: String(r.low),
        close: String(r.close),
        volume: String(r.volume ?? 0),
      })
    }
    bars.sort((a, b) => a.ts.getTime() - b.ts.getTime())
    // Cap to the most recent `historyBars` so older entries don't
    // bloat the strategy's history view.
    return bars.length > historyBars ? bars.slice(-historyBars) : bars
  }

  async function handleFire(entry: EventLogEntry<CronFirePayload>): Promise<void> {
    if (entry.payload.jobName !== STRATEGY_WORKER_JOB_NAME) return
    if (processing) return

    processing = true
    try {
      const report = await tick()
      if (report.processed > 0 || report.errors.length > 0) {
        console.log(
          `strategy-worker: tick processed ${report.processed}, errors ${report.errors.length}`,
        )
      }
    } catch (err) {
      console.warn(
        'strategy-worker: tick error:',
        err instanceof Error ? err.message : err,
      )
    } finally {
      processing = false
    }
  }

  const listener: Listener<'cron.fire'> = {
    name: 'strategy-worker',
    subscribes: 'cron.fire',
    handle: handleFire,
  }

  return {
    listener,
    tick,

    async start() {
      const existing = cronEngine.list().find(j => j.name === STRATEGY_WORKER_JOB_NAME)
      if (existing) {
        await cronEngine.update(existing.id, {
          schedule: { kind: 'every', every: config.every },
          enabled: config.enabled,
        })
      } else {
        await cronEngine.add({
          name: STRATEGY_WORKER_JOB_NAME,
          schedule: { kind: 'every', every: config.every },
          payload: '',
          enabled: config.enabled,
        })
      }

      if (!registered) {
        registry.register(listener)
        registered = true
      }
    },

    stop() {
      if (registered) {
        registry.unregister(listener.name)
        registered = false
      }
    },
  }
}
