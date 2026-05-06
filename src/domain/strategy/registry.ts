/**
 * Strategy registry — a name → RegisteredStrategy lookup.
 *
 * Each strategy file exports a `RegisteredStrategy` and registers
 * itself with a single `register(...)` call. The backtest tool
 * (and, later, the live runner) only ever holds string names; the
 * registry is the indirection that lets new strategies appear
 * without touching call sites.
 *
 * Manual switching (the user's chosen approach for v1): the live
 * runner — when it exists — will read `data/config/active-strategy.json`
 * for `{ name, params }` and call `getStrategy(name).factory(params)`.
 * That config is NOT created here; the registry is purely the
 * lookup layer.
 */

import type { RegisteredStrategy, StrategyMetadata } from './types.js'

const registry = new Map<string, RegisteredStrategy>()

/**
 * Register a strategy. Throws on duplicate names so accidents
 * (two strategies fighting for the same key) fail loud.
 */
export function register(strategy: RegisteredStrategy): void {
  const name = strategy.metadata.name
  if (!name || typeof name !== 'string') {
    throw new Error(`registerStrategy: metadata.name must be a non-empty string`)
  }
  if (registry.has(name)) {
    throw new Error(
      `registerStrategy: "${name}" is already registered. Names must be unique.`,
    )
  }
  registry.set(name, strategy)
}

/** Lookup a strategy by name. Returns undefined when missing. */
export function getStrategy(name: string): RegisteredStrategy | undefined {
  return registry.get(name)
}

/**
 * List all registered strategies' metadata. Used by the backtest
 * tool's `listStrategies` call so the AI can describe the available
 * options back to the user.
 */
export function listStrategies(): StrategyMetadata[] {
  return Array.from(registry.values()).map(s => s.metadata)
}

/**
 * Test-only escape hatch: clear the registry. Production code
 * should never call this; it's exposed so unit tests can register
 * fixture strategies in a clean slate.
 */
export function _resetRegistryForTests(): void {
  registry.clear()
}
