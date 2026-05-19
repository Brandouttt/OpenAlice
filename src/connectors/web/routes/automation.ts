import { Hono } from 'hono'
import { z } from 'zod'
import type { EngineContext } from '../../../core/types.js'

/**
 * Automation routes — HTTP surface for the AutomationStrategySection
 * Web UI. Mirrors the AI tool surface (src/tool/automation.ts) but
 * structured for direct frontend consumption.
 *
 *   GET    /                     — list all entries (optional ?account=, ?enabled=)
 *   POST   /                     — upsert one entry
 *   DELETE /:account/:symbol/:strategy — remove
 *   PATCH  /:account/:symbol/:strategy/enabled — flip enabled flag
 *   POST   /tick                 — manual worker tick (run now)
 *
 * Symbol params are URL-encoded; the store handles uppercase
 * normalisation. The compound key uses three path segments rather
 * than one delimited string so any symbol/strategy name with `/`
 * (rare but possible for crypto pairs) wouldn't break routing.
 */
export function createAutomationRoutes(ctx: EngineContext) {
  const app = new Hono()
  const { automationStore, strategyWorker } = ctx

  // ==================== GET / — list ====================

  app.get('/', async (c) => {
    const account = c.req.query('account')
    const enabledOnly = c.req.query('enabled') === 'true'

    let entries = account
      ? await automationStore.listForAccount(account)
      : await automationStore.list()
    if (enabledOnly) entries = entries.filter(e => e.enabled)

    return c.json({ entries })
  })

  // ==================== POST / — upsert ====================

  const upsertSchema = z.object({
    accountId: z.string().min(1),
    symbol: z.string().min(1),
    strategyName: z.string().min(1),
    params: z.record(z.string(), z.unknown()).optional(),
    enabled: z.boolean().optional(),
    notes: z.string().optional(),
  })

  app.post('/', async (c) => {
    const body = await c.req.json()
    const parsed = upsertSchema.safeParse(body)
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400)
    }
    try {
      const entry = await automationStore.upsert(parsed.data)
      return c.json({ entry })
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        400,
      )
    }
  })

  // ==================== DELETE /:account/:symbol/:strategy ====================

  app.delete('/:accountId/:symbol/:strategyName', async (c) => {
    const accountId = c.req.param('accountId')
    const symbol = c.req.param('symbol')
    const strategyName = c.req.param('strategyName')
    const removed = await automationStore.remove(accountId, symbol, strategyName)
    return c.json({ removed })
  })

  // ==================== PATCH /:account/:symbol/:strategy/enabled ====================

  app.patch('/:accountId/:symbol/:strategyName/enabled', async (c) => {
    const accountId = c.req.param('accountId')
    const symbol = c.req.param('symbol')
    const strategyName = c.req.param('strategyName')
    const body = await c.req.json()
    const enabled = Boolean(body.enabled)

    const entry = await automationStore.setEnabled(accountId, symbol, strategyName, enabled)
    if (!entry) {
      return c.json({ error: 'no matching entry' }, 404)
    }
    return c.json({ entry })
  })

  // ==================== POST /tick — manual run ====================

  app.post('/tick', async (c) => {
    const report = await strategyWorker.tick()
    return c.json({
      processed: report.processed,
      errors: report.errors.map(e => ({
        entry: e.entry,
        error: e.error,
      })),
    })
  })

  return app
}
