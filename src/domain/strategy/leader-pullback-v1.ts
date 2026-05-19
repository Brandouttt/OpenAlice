/**
 * leader-pullback-v1 — i.e. "buy a strong stock that's pulled back
 * to its rising 10/20-day moving average, then trail it out."
 *
 * Style: William O'Neil / Mark Minervini trend pullback. Long-only.
 * One position at a time per symbol.
 *
 * THIS FILE COVERS: single-symbol entry/exit/sizing. The strategy
 * assumes the caller has already determined the symbol is a
 * "leader" (high relative strength, narrative catalyst, etc.) via
 * a separate screener / candidate pool. The screener is a separate
 * concern and lives outside the Strategy callback interface.
 *
 * Entry (all must hold on signal-day close):
 *   1. Pullback: today's close is ≥ pullbackThresholdPct below the
 *      5-day high (default 3%).
 *   2. MA touch: today's close is within maTouchTolerancePct of
 *      MA(fast=10) OR MA(slow=20) (default 0.5%).
 *   3. MA rising: MA10[today] > MA10[5 bars ago] AND MA20[today] >
 *      MA20[5 bars ago].
 *   4. Volume confirmation: today's volume ≥ MA(volume, 30) — i.e.
 *      not a "dead-volume" pullback that's likely to break down.
 *
 * Order semantics (under BacktestEngine's deferred-fill mode):
 *   Decisions are made on bar i's close; the actual fill happens
 *   at bar i+1's open. The strategy assumes this and sizes / stops
 *   from signal-day data.
 *
 * Position sizing:
 *   risk-dollars = balance × riskPerTradePct (default 1%)
 *   shares       = floor(risk-dollars / (entry − stop))
 *   notional cap = balance × maxNotionalPct (default 30%) —
 *                  cap shares if computed notional exceeds this.
 *
 * Exit state machine:
 *   flat → BUY signal → entry order placed → state becomes 'full'.
 *   full:
 *     - stop hit (low breaches initialStop) → SELL all → flat
 *     - TP1 hit (close ≥ entry + 1.5R) AND ≥ 2 shares → SELL half →
 *       'partial' (remember partialQty)
 *     - time stop (≥ timeStopBars since entry AND highestSinceEntry
 *       hasn't exceeded entry × (1+timeStopMinReturnPct/100)) →
 *       SELL all → flat
 *   partial:
 *     - trail stop on MA10 × (1 − ma10TrailTolerancePct/100):
 *       close < trail → SELL remaining → flat
 *     - same time stop applies
 *
 * State is held in the closure: per-symbol, per-strategy-instance.
 * The strategy assumes EXCLUSIVE control over the symbol's position;
 * manual trades from elsewhere will confuse internal accounting. A
 * future v2 should sync from broker.getPositions() at each tick.
 */

import Decimal from 'decimal.js'
import type { IBroker } from '../trading/brokers/types.js'
import { makeContract } from '../trading/brokers/mock/index.js'
import '../trading/contract-ext.js'
import type { Bar, Strategy } from '../backtest/types.js'
import { makeMarketOrder, sma } from './sma-crossover.js'
import type { RegisteredStrategy } from './types.js'

// ==================== Indicator helpers ====================

/**
 * Average True Range over `period` bars, computed from the most
 * recent `period+1` bars in `bars`. Returns null when there isn't
 * enough history. Plain number — Decimal is overkill for ATR
 * which is itself an average of differences.
 */
export function atr(bars: readonly Bar[], period: number): number | null {
  if (bars.length < period + 1) return null
  let sum = 0
  for (let i = bars.length - period; i < bars.length; i++) {
    const h = Number(bars[i].high)
    const l = Number(bars[i].low)
    const pc = Number(bars[i - 1].close)
    const tr = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc))
    sum += tr
  }
  return sum / period
}

/** Highest close among the last `lookback` bars (inclusive of latest). */
function highestClose(bars: readonly Bar[], lookback: number): number {
  const start = Math.max(0, bars.length - lookback)
  let hi = -Infinity
  for (let i = start; i < bars.length; i++) {
    const c = Number(bars[i].close)
    if (c > hi) hi = c
  }
  return hi
}

// ==================== Parameter shape ====================

export interface LeaderPullbackParams {
  // Entry
  pullbackThresholdPct: number   // default 3 — drop from 5-day high
  pullbackLookbackBars: number   // default 5 — window for the 5-day high
  maFast: number                 // default 10
  maSlow: number                 // default 20
  maTouchTolerancePct: number    // default 0.5 — how close to MA10/MA20
  maRisingLookback: number       // default 5 — MA today > MA N bars ago
  volumeMaLookback: number       // default 30 — volume-MA period

  // Exit
  atrPeriod: number              // default 14
  atrMultiplier: number          // default 1 — stop = low − atrMultiplier × ATR
  ma20StopTolerancePct: number   // default 2 — alt stop = MA20 × (1 − x/100)
  tp1RMultiple: number           // default 1.5 — first scale-out trigger
  tp1ScaleOutPct: number         // default 50 — % of position closed at TP1
  ma10TrailTolerancePct: number  // default 2 — TP2 trail = MA10 × (1 − x/100)
  timeStopBars: number           // default 10
  timeStopMinReturnPct: number   // default 5 — must exceed entry × (1+x/100)

  // Sizing
  riskPerTradePct: number        // default 1 — % of balance per trade
  maxNotionalPct: number         // default 30 — % of balance hard cap
}

const DEFAULTS: LeaderPullbackParams = {
  pullbackThresholdPct: 3,
  pullbackLookbackBars: 5,
  maFast: 10,
  maSlow: 20,
  maTouchTolerancePct: 0.5,
  maRisingLookback: 5,
  volumeMaLookback: 30,
  atrPeriod: 14,
  atrMultiplier: 1,
  ma20StopTolerancePct: 2,
  tp1RMultiple: 1.5,
  tp1ScaleOutPct: 50,
  ma10TrailTolerancePct: 2,
  timeStopBars: 10,
  timeStopMinReturnPct: 5,
  riskPerTradePct: 1,
  maxNotionalPct: 30,
}

// ==================== Strategy factory ====================

type Phase = 'flat' | 'full' | 'partial'

interface TradeState {
  phase: Phase
  entryPrice: Decimal     // realised fill price (next-bar open after signal)
  signalDayLow: Decimal   // for stop computation
  initialStop: Decimal
  entryBarIndex: number
  initialQty: Decimal
  remainingQty: Decimal
  highestSinceEntry: Decimal
}

export function makeLeaderPullback(
  overrides: Partial<LeaderPullbackParams> = {},
): Strategy {
  const p: LeaderPullbackParams = { ...DEFAULTS, ...overrides }

  // Validate ordering invariants
  if (p.maFast >= p.maSlow) {
    throw new Error(
      `leader-pullback-v1: maFast (${p.maFast}) must be less than maSlow (${p.maSlow})`,
    )
  }

  let state: TradeState | null = null  // null = flat
  let pendingEntry: {
    signalDayLow: Decimal
    initialStop: Decimal
    signalBarIndex: number
    targetQty: Decimal
    signalDayClose: Decimal
  } | null = null

  // Assigned to a const so we can attach getState / resetState
  // methods. The IIFE-wrapped function body is otherwise unchanged.
  const fn: Strategy = (async (ctx) => {
    const { broker, history, bar, index, symbol } = ctx
    const closes = history.map(b => Number(b.close))

    // ---- Handle pending entry: previous bar said BUY, today's
    //      open was the fill. Promote pending → state.
    if (pendingEntry && state === null) {
      // Engine fills at THIS bar's open. We use it as the realised
      // entry. Quantity already submitted; we trust the broker to
      // confirm via getPositions but for the closure we adopt the
      // assumed shares.
      state = {
        phase: 'full',
        entryPrice: new Decimal(bar.open),
        signalDayLow: pendingEntry.signalDayLow,
        initialStop: pendingEntry.initialStop,
        entryBarIndex: index,
        initialQty: pendingEntry.targetQty,
        remainingQty: pendingEntry.targetQty,
        highestSinceEntry: new Decimal(bar.high),
      }
      pendingEntry = null
    }

    // ---- Update highest-since-entry tracker
    if (state) {
      const h = new Decimal(bar.high)
      if (h.gt(state.highestSinceEntry)) state.highestSinceEntry = h
    }

    // ---- IN POSITION: check exits
    if (state) {
      const close = new Decimal(bar.close)
      const low = new Decimal(bar.low)

      // Compute trailing stop based on MA10
      const ma10Now = sma(closes, p.maFast)

      // 1. Stop hit (today's low breaches initialStop or trail stop)
      const trailStop = state.phase === 'partial' && ma10Now != null
        ? new Decimal(ma10Now).mul(1 - p.ma10TrailTolerancePct / 100)
        : null
      const effectiveStop = trailStop && trailStop.gt(state.initialStop)
        ? trailStop
        : state.initialStop

      if (low.lt(effectiveStop) || close.lt(effectiveStop)) {
        // Close remaining. GUARD: only clear internal state when
        // the broker actually accepted the exit. If a guard rejects
        // (e.g. cooldown spec) the position is still open — leave
        // state as-is and the next bar will re-attempt.
        const exitResult = await placeSell(broker, symbol, state.remainingQty)
        if (wasConfirmed(exitResult)) {
          state = null
        }
        return
      }

      // 2. Time stop
      const barsHeld = index - state.entryBarIndex
      if (barsHeld >= p.timeStopBars) {
        const minHigh = state.entryPrice.mul(1 + p.timeStopMinReturnPct / 100)
        if (state.highestSinceEntry.lt(minHigh)) {
          const exitResult = await placeSell(broker, symbol, state.remainingQty)
          if (wasConfirmed(exitResult)) {
            state = null
          }
          return
        }
      }

      // 3. TP1 (only fires in 'full' phase, and only if qty ≥ 2)
      if (state.phase === 'full') {
        const R = state.entryPrice.minus(state.initialStop)
        const tp1Trigger = state.entryPrice.plus(R.mul(p.tp1RMultiple))
        if (close.gte(tp1Trigger) && state.remainingQty.gte(2)) {
          const sellQty = state.remainingQty
            .mul(p.tp1ScaleOutPct / 100)
            .floor()
          if (sellQty.gt(0)) {
            const sellResult = await placeSell(broker, symbol, sellQty)
            // Only progress to 'partial' phase if the partial close
            // actually went through. Otherwise stay in 'full' and
            // retry on the next bar that still meets the TP1 trigger.
            if (wasConfirmed(sellResult)) {
              state.remainingQty = state.remainingQty.minus(sellQty)
              state.phase = 'partial'
            }
          }
        }
      }

      return
    }

    // ---- FLAT: check entry conditions
    // Need enough history for the slowest indicator (volume-MA-30 by default)
    const minBars = Math.max(p.maSlow, p.volumeMaLookback, p.atrPeriod) + 1
    if (history.length < minBars) return

    const closeNum = Number(bar.close)
    const lowNum = Number(bar.low)

    // 1. Pullback ≥ pullbackThresholdPct from 5-day high
    const recentHigh = highestClose(history, p.pullbackLookbackBars)
    const dropPct = ((recentHigh - closeNum) / recentHigh) * 100
    if (dropPct < p.pullbackThresholdPct) return

    // 2. MA touch
    const ma10 = sma(closes, p.maFast)
    const ma20 = sma(closes, p.maSlow)
    if (ma10 == null || ma20 == null) return
    const touchMa10 = Math.abs(closeNum - ma10) / closeNum <= p.maTouchTolerancePct / 100
    const touchMa20 = Math.abs(closeNum - ma20) / closeNum <= p.maTouchTolerancePct / 100
    if (!touchMa10 && !touchMa20) return

    // 3. Both MAs rising
    const ma10Prev = sma(closes.slice(0, -p.maRisingLookback), p.maFast)
    const ma20Prev = sma(closes.slice(0, -p.maRisingLookback), p.maSlow)
    if (ma10Prev == null || ma20Prev == null) return
    if (!(ma10 > ma10Prev && ma20 > ma20Prev)) return

    // 4. Volume confirmation
    const volumes = history.map(b => Number(b.volume))
    const volMa = sma(volumes, p.volumeMaLookback)
    if (volMa == null) return
    if (Number(bar.volume) < volMa) return

    // ---- All conditions met. Compute stop, size, place BUY.
    const atrValue = atr(history, p.atrPeriod)
    if (atrValue == null) return

    const stopFromAtr = lowNum - p.atrMultiplier * atrValue
    const stopFromMa = ma20 * (1 - p.ma20StopTolerancePct / 100)
    const stopRaw = Math.max(stopFromAtr, stopFromMa) // closer of the two
    if (stopRaw >= closeNum) return // degenerate — would mean negative R

    const initialStop = new Decimal(stopRaw)
    const signalClose = new Decimal(closeNum)
    const riskPerShare = signalClose.minus(initialStop)
    if (riskPerShare.lte(0)) return

    // Sizing — need balance from broker
    const account = await broker.getAccount()
    const balance = new Decimal(account.netLiquidation)
    if (balance.lte(0)) return

    const riskDollars = balance.mul(p.riskPerTradePct / 100)
    let qty = riskDollars.div(riskPerShare).floor()

    // Notional cap
    const notional = qty.mul(signalClose)
    const notionalCap = balance.mul(p.maxNotionalPct / 100)
    if (notional.gt(notionalCap)) {
      qty = notionalCap.div(signalClose).floor()
    }
    if (qty.lte(0)) return

    // Place BUY — fills at next bar's open under deferred-fill mode.
    // GUARD: only set pendingEntry when the broker actually accepted
    // the order. If GitTrackedBroker classifies this as Tier 2 (HITL)
    // it returns status='PendingSubmit' — the human may reject, so we
    // must NOT progress strategy state assuming fill. If hard-stopped
    // (Tier 3) success=false. Either way: abandon this signal, the
    // strategy will re-evaluate on next bar.
    const buyResult = await placeBuy(broker, symbol, qty.toNumber())
    if (!wasConfirmed(buyResult)) return

    pendingEntry = {
      signalDayLow: new Decimal(lowNum),
      initialStop,
      signalBarIndex: index,
      targetQty: qty,
      signalDayClose: signalClose,
    }
  }) as Strategy

  fn.getState = () => {
    // Three observable phases: flat (no position, no pending),
    // pending (BUY placed, awaiting next-bar fill), full / partial.
    if (state === null && pendingEntry === null) {
      return { position: 'flat', details: {} }
    }
    if (state === null && pendingEntry !== null) {
      return {
        position: 'flat', // not in position yet — order pending fill
        details: {
          pendingEntry: {
            initialStop: pendingEntry.initialStop.toString(),
            signalBarIndex: pendingEntry.signalBarIndex,
            targetQty: pendingEntry.targetQty.toString(),
            signalDayClose: pendingEntry.signalDayClose.toString(),
          },
        },
      }
    }
    // state !== null — in position
    const s = state!
    return {
      position: s.phase === 'partial' ? 'partial' : 'long',
      details: {
        phase: s.phase,
        entryPrice: s.entryPrice.toString(),
        initialStop: s.initialStop.toString(),
        initialQty: s.initialQty.toString(),
        remainingQty: s.remainingQty.toString(),
        entryBarIndex: s.entryBarIndex,
        highestSinceEntry: s.highestSinceEntry.toString(),
      },
    }
  }

  fn.resetState = () => {
    state = null
    pendingEntry = null
  }

  return fn
}

// ==================== Order helpers ====================

/**
 * An order is "confirmed" when the broker accepted it AND it's not
 * sitting in a pending-approval state. In backtest + auto-push live
 * mode the status is 'Submitted' or 'Filled'. In HITL mode the
 * GitTrackedBroker returns 'PendingSubmit' — the user may reject,
 * so the strategy must NOT progress internal state as if filled.
 *
 * Strategies should call this on every broker response before
 * mutating their own position tracking.
 */
function wasConfirmed(result: { success: boolean; orderState?: { status?: string } } | undefined): boolean {
  if (!result || !result.success) return false
  const status = result.orderState?.status
  if (status === 'PendingSubmit') return false
  return true
}

async function placeBuy(broker: IBroker, symbol: string, qty: number) {
  const contract = makeContract({ symbol, aliceId: `mock-paper|${symbol}` })
  return broker.placeOrder(contract, makeMarketOrder('BUY', qty))
}

async function placeSell(broker: IBroker, symbol: string, qty: Decimal) {
  const qtyNum = qty.toNumber()
  if (qtyNum <= 0) return undefined
  const contract = makeContract({ symbol, aliceId: `mock-paper|${symbol}` })
  return broker.placeOrder(contract, makeMarketOrder('SELL', qtyNum))
}

// ==================== Registry entry ====================

export const leaderPullbackV1Strategy: RegisteredStrategy = {
  metadata: {
    name: 'leader-pullback-v1',
    description:
      'Long-only pullback entry on strong stocks. Requires the symbol ' +
      'to already pass a "leader" screen (high relative strength, ' +
      'narrative catalyst) — that selection happens outside this strategy. ' +
      'Entry: pullback ≥3% from 5-day high + touch of rising 10/20-day MA ' +
      '+ above-average volume. Exit: ATR/MA20 stop, TP1 at 1.5R scaling ' +
      'out 50%, MA10 trailing stop for the runner, time stop after 10 bars.',
    warmupBars: 31, // max(maSlow=20, volumeMaLookback=30, atrPeriod=14) + 1
    defaults: {
      pullbackThresholdPct: 3,
      atrMultiplier: 1,
      tp1RMultiple: 1.5,
      timeStopBars: 10,
      riskPerTradePct: 1,
      maxNotionalPct: 30,
    },
    parameters: [
      {
        name: 'pullbackThresholdPct',
        description: 'Min drop from 5-day high to qualify (%).',
        default: 3,
        range: { min: 0.5, max: 20 },
      },
      {
        name: 'atrMultiplier',
        description: 'Initial stop = low − N × ATR(14). Larger N → wider stop, smaller size.',
        default: 1,
        range: { min: 0.5, max: 5 },
      },
      {
        name: 'tp1RMultiple',
        description: 'Take-profit trigger as multiples of initial risk R. Default 1.5R.',
        default: 1.5,
        range: { min: 1, max: 5 },
      },
      {
        name: 'timeStopBars',
        description: 'Close if no new 5% high within this many bars after entry.',
        default: 10,
        range: { min: 3, max: 60 },
      },
      {
        name: 'riskPerTradePct',
        description: '% of equity risked per trade. 1% default — Minervini baseline.',
        default: 1,
        range: { min: 0.25, max: 5 },
      },
      {
        name: 'maxNotionalPct',
        description: '% of equity max for any single position (overrides risk-based size if larger).',
        default: 30,
        range: { min: 5, max: 100 },
      },
    ],
    marketRegime: 'trending',
  },
  factory: (params) => makeLeaderPullback(params as Partial<LeaderPullbackParams>),
}
