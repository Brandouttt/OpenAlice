/**
 * Backtest tool — exposes the BacktestEngine to the AI as two
 * Vercel AI SDK tools:
 *
 *   - listStrategies: returns the registered strategies + their
 *     parameter shapes, so the AI can describe options to the user
 *     before choosing one.
 *   - backtestRun: runs a registered strategy against historical
 *     bars fetched from the equity client and returns the metrics
 *     report.
 *
 * The tool intentionally does NOT accept inline strategy code —
 * AI-generated strategies bypass review. To add a new strategy
 * the human commits a new file under src/domain/strategy/ and
 * registers it. See domain/strategy/README or the registry source.
 */

import { tool } from 'ai'
import { z } from 'zod'
import Decimal from 'decimal.js'
import type { EquityClientLike } from '@/domain/market-data/client/types'
import { runBacktest } from '@/domain/backtest/engine'
import type { Bar, BacktestReport } from '@/domain/backtest/types'
import { MockBroker } from '@/domain/trading/brokers/mock/index'
import { getStrategy, listStrategies } from '@/domain/strategy/index'

// ==================== Helpers ====================

/**
 * Convert OpenBB-shape historical rows (date / open / high / low /
 * close / volume, all numbers) into the engine's `Bar[]` shape
 * (Date object + Decimal-safe strings).
 *
 * Drops rows with any null OHLC field — yfinance occasionally
 * returns nulls for missing data and feeding those into the engine
 * would NaN the equity curve.
 */
function toEngineBars(rows: ReadonlyArray<{
  date: string
  open: number | null
  high: number | null
  low: number | null
  close: number | null
  volume: number | null
}>): Bar[] {
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
  // Defence-in-depth: ensure chronological even if provider sorts
  // differently.
  bars.sort((a, b) => a.ts.getTime() - b.ts.getTime())
  return bars
}

/**
 * Convert a BacktestReport into a JSON-friendly summary the AI can
 * easily pass back to the user. Equity curve is downsampled to
 * head + tail + 8 evenly-spaced midpoints so the response stays
 * compact even for 5-year runs.
 */
function summariseReport(report: BacktestReport, fullCurve = false) {
  let curve = report.equityCurve
  if (!fullCurve && curve.length > 12) {
    const sampled = [curve[0]]
    const stride = (curve.length - 2) / 9
    for (let i = 1; i <= 9; i++) {
      sampled.push(curve[Math.round(i * stride)])
    }
    sampled.push(curve[curve.length - 1])
    curve = sampled
  }
  return {
    symbol: report.symbol,
    bars: report.equityCurve.length,
    startTs: report.startTs.toISOString(),
    endTs: report.endTs.toISOString(),
    initialEquity: report.initialEquity,
    finalEquity: report.finalEquity,
    totalReturn: report.totalReturn + '%',
    sharpe: Number.isFinite(report.sharpe) ? report.sharpe.toFixed(3) : 'N/A',
    maxDrawdown: report.maxDrawdown + '%',
    tradeCount: report.tradeCount,
    durationMs: report.durationMs,
    equityCurve: curve.map(p => ({ ts: p.ts.toISOString(), equity: p.equity })),
  }
}

// ==================== Schemas ====================

const backtestRunSchema = z.object({
  strategy: z.string().describe(
    'Name of a registered strategy. Use the listStrategies tool to discover available names.',
  ),
  symbol: z.string().describe('Ticker (e.g. "SPY", "AAPL"). Equity only for v1.'),
  from: z.string().describe('ISO date for the start of the backtest, e.g. "2020-01-01".'),
  to: z.string().describe('ISO date for the end of the backtest, e.g. "2024-12-31".'),
  initialCash: z.number().int().positive().default(100_000).describe(
    'Starting cash in USD. Default 100,000.',
  ),
  params: z.record(z.string(), z.unknown()).optional().describe(
    'Strategy-specific parameter overrides, e.g. {"fast": 10, "slow": 30}. ' +
    'Defaults from the strategy metadata are used for unspecified keys.',
  ),
  fullCurve: z.boolean().default(false).describe(
    'When true, returns the full equity curve (one point per bar). ' +
    'Default false returns a downsampled 11-point summary to keep the ' +
    'response small for long backtests.',
  ),
  // Fee model
  commissionPerShare: z.number().nonnegative().default(0.005).describe(
    'Per-share commission (USD). Default 0.005 (IBKR Pro).',
  ),
  commissionMin: z.number().nonnegative().default(1).describe(
    'Minimum commission per fill (USD). Default 1 (IBKR Pro).',
  ),
  slippageBps: z.number().nonnegative().default(2).describe(
    'Slippage in basis points (1 bp = 0.01%). Default 2 — tight for liquid ETFs.',
  ),
  provider: z.string().default('yfinance').describe(
    'Historical data provider. Default yfinance.',
  ),
})

// ==================== Tool factory ====================

export function createBacktestTools(equityClient: EquityClientLike) {
  return {
    listStrategies: tool({
      description:
        'Return the catalogue of registered backtest strategies. Each entry ' +
        'includes the strategy name, a one-line description, default parameters, ' +
        'and (when set) a market-regime hint. Call this before backtestRun ' +
        'when the user asks "what strategies can I test?" or when picking a ' +
        'strategy name to use.',
      inputSchema: z.object({}),
      execute: async () => {
        return {
          strategies: listStrategies(),
        }
      },
    }),

    backtestRun: tool({
      description:
        'Run a registered backtest strategy against historical OHLCV bars. ' +
        'Returns metrics: Sharpe ratio (return per unit volatility), max ' +
        'drawdown (deepest peak-to-trough drop), total return, trade count, ' +
        'final equity, and a downsampled equity curve. Use listStrategies ' +
        'first to discover available strategy names. Network call to the ' +
        'data provider may take 5-30 seconds for multi-year ranges.',
      inputSchema: backtestRunSchema,
      execute: async (input) => {
        // 1. Look up the strategy
        const registered = getStrategy(input.strategy)
        if (!registered) {
          const available = listStrategies().map(s => s.name).join(', ')
          throw new Error(
            `Unknown strategy "${input.strategy}". Available: ${available || '(none registered)'}`,
          )
        }

        // 2. Fetch historical bars
        const rows = (await equityClient.getHistorical({
          symbol: input.symbol,
          start_date: input.from,
          end_date: input.to,
          interval: '1d',
          provider: input.provider,
        })) as Array<{
          date: string
          open: number | null
          high: number | null
          low: number | null
          close: number | null
          volume: number | null
        }>

        const bars = toEngineBars(rows)
        if (bars.length < 2) {
          throw new Error(
            `Got ${bars.length} usable bars for ${input.symbol} ${input.from}→${input.to}. ` +
            `Need at least 2. Check the symbol/date range or try a different provider.`,
          )
        }

        // 3. Build broker with the requested fee model
        const broker = new MockBroker({
          cash: input.initialCash,
          deferMarketFills: true,
          commissionPerShare: input.commissionPerShare,
          commissionMin: input.commissionMin,
          slippageBps: input.slippageBps,
        })

        // 4. Build the strategy instance
        const strategy = registered.factory(input.params ?? {})

        // 5. Run the backtest
        const report = await runBacktest(
          {
            symbol: input.symbol,
            bars,
            initialCash: input.initialCash,
            strategy,
          },
          broker,
        )

        return {
          ok: true,
          strategyName: input.strategy,
          warmupBars: registered.metadata.warmupBars,
          totalCommissionsPaid: broker.totalCommissionsPaid,
          summary: summariseReport(report, input.fullCurve),
        }
      },
    }),
  }
}

// Re-export Decimal so callers reading the report don't need a
// separate import path. (No-op if unused — tree-shaken in build.)
export { Decimal }
