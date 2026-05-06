/**
 * Strategy registry — public surface.
 *
 * Importing this module triggers all built-in strategy registrations
 * via side effect. Consumers should import from here once at startup
 * (or once per test file) before calling `getStrategy(...)`.
 */

import { register } from './registry.js'
import { smaCrossoverStrategy } from './sma-crossover.js'

// Register built-in strategies. Each call is idempotent only if the
// registry is empty — duplicate registration throws. Don't import
// this file twice in the same process; tests that need a clean slate
// should call `_resetRegistryForTests` before re-registering.
register(smaCrossoverStrategy)

export { register, getStrategy, listStrategies, _resetRegistryForTests } from './registry.js'
export type { RegisteredStrategy, StrategyMetadata, StrategyParameter, MarketRegime } from './types.js'
export { smaCrossoverStrategy, makeSmaCrossover, sma, makeMarketOrder } from './sma-crossover.js'
export type { SmaCrossoverParams } from './sma-crossover.js'
