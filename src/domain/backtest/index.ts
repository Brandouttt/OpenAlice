export { runBacktest } from './engine.js'
export type {
  Bar,
  BacktestConfig,
  BacktestReport,
  EquityPoint,
  Strategy,
  StrategyContext,
} from './types.js'
export { sharpe, maxDrawdown, totalReturn, returnsFromEquityCurve } from './metrics.js'
