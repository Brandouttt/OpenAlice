/**
 * MaxPositionsGuard — i.e. "no more than N stocks held at once."
 *
 * Caps the COUNT of distinct positions, not their dollar size
 * (that's max-position-size's job). Helps with attention budget
 * and diversification on small accounts: 5 positions on $4000 is
 * already $800 average per position; 10 would be too thin.
 *
 * Reject only when a BUY would create a NEW symbol's position.
 * Adding to an existing position passes through — the count
 * doesn't increase. Closing or reducing always passes.
 *
 * Stateless. Reads `ctx.positions` only.
 */

import Decimal from 'decimal.js'
import type { OperationGuard, GuardContext } from './types.js'

const DEFAULT_MAX = 5

export class MaxPositionsGuard implements OperationGuard {
  readonly name = 'max-positions'
  private max: number

  constructor(options: Record<string, unknown>) {
    this.max = Number(options.max ?? DEFAULT_MAX)
    if (!Number.isFinite(this.max) || this.max < 1) {
      throw new Error(`max-positions: max must be a positive integer, got ${options.max}`)
    }
  }

  check(ctx: GuardContext): string | null {
    if (ctx.operation.action !== 'placeOrder') return null

    const { operation, positions } = ctx
    const action = operation.order.action.toUpperCase()
    const isEntry = action === 'BUY' || action === 'SSHORT' || action === 'SELL SHORT'
    if (!isEntry) return null

    const symbol = operation.contract.symbol
    if (!symbol) return null

    // If we already hold this symbol, this order doesn't add a new
    // position — let it through.
    const existing = positions.find(p => p.contract.symbol === symbol && this.isOpen(p.quantity))
    if (existing) return null

    // Count distinct OPEN positions (some brokers leave 0-qty
    // positions in the list as "previously held" — exclude them).
    const openCount = positions.filter(p => this.isOpen(p.quantity)).length

    if (openCount >= this.max) {
      const heldSymbols = positions
        .filter(p => this.isOpen(p.quantity))
        .map(p => p.contract.symbol)
        .join(', ')
      return (
        `Already holding ${openCount} positions (limit: ${this.max}). ` +
        `Existing: ${heldSymbols}. Close one before opening ${symbol}.`
      )
    }

    return null
  }

  /**
   * A position is "open" when its quantity is non-zero. Decimal-safe
   * comparison so brokers that emit "0.00000000" don't slip through.
   */
  private isOpen(qty: Decimal | string): boolean {
    const d = qty instanceof Decimal ? qty : new Decimal(String(qty))
    return !d.isZero()
  }
}
