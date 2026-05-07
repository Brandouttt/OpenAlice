import type { OperationGuard, GuardRegistryEntry } from './types.js'
import { MaxPositionSizeGuard } from './max-position-size.js'
import { CooldownGuard } from './cooldown.js'
import { SymbolWhitelistGuard } from './symbol-whitelist.js'
import { PerTradeLossCapGuard } from './per-trade-loss-cap.js'
import { MaxPositionsGuard } from './max-positions.js'
import { DailyLossCapGuard } from './daily-loss-cap.js'

const builtinGuards: GuardRegistryEntry[] = [
  { type: 'max-position-size',   create: (opts) => new MaxPositionSizeGuard(opts) },
  { type: 'cooldown',            create: (opts) => new CooldownGuard(opts) },
  { type: 'symbol-whitelist',    create: (opts) => new SymbolWhitelistGuard(opts) },
  { type: 'per-trade-loss-cap',  create: (opts) => new PerTradeLossCapGuard(opts) },
  { type: 'max-positions',       create: (opts) => new MaxPositionsGuard(opts) },
  { type: 'daily-loss-cap',      create: (opts) => new DailyLossCapGuard(opts) },
]

const registry = new Map<string, GuardRegistryEntry['create']>(
  builtinGuards.map(g => [g.type, g.create]),
)

/** Register a custom guard type (for third-party extensions). */
export function registerGuard(entry: GuardRegistryEntry): void {
  registry.set(entry.type, entry.create)
}

/**
 * Context that resolveGuards forwards into every guard's options blob.
 * Existing per-guard `options` win on key collision; context fills in
 * missing keys. Enables guards to learn the owning UTA without each
 * config entry having to repeat `accountId`.
 */
export interface GuardResolveContext {
  /** Owning UTA id — guards that persist to disk key off this. */
  accountId?: string
}

/** Resolve config entries into guard instances via the registry. */
export function resolveGuards(
  configs: Array<{ type: string; options?: Record<string, unknown> }>,
  context: GuardResolveContext = {},
): OperationGuard[] {
  const guards: OperationGuard[] = []
  for (const cfg of configs) {
    const factory = registry.get(cfg.type)
    if (!factory) {
      console.warn(`guard: unknown type "${cfg.type}", skipped`)
      continue
    }
    // Per-config options win; context fills missing keys only.
    const merged = { ...context, ...(cfg.options ?? {}) }
    guards.push(factory(merged))
  }
  return guards
}
