import { timingSafeEqual } from 'node:crypto'
import { after, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { syncCatalogForAccount } from '@/lib/whatsapp/catalog-sync'

/**
 * Unattended catalog sync for every account with a Meta catalog
 * connected — the "Sync now" button in Settings
 * (`/api/whatsapp/catalog/sync`) only ever syncs the calling user's
 * own account, so without this nobody's catalog refreshes unless a
 * human remembers to click it. Meant for a low-frequency schedule
 * (daily is plenty — product names/prices/availability don't churn
 * fast enough to justify the same 15-minute cadence as the flow/
 * automation sweeps) rather than the tight cron.yml schedule, since
 * each leg can be a non-trivial number of Meta API calls for a large
 * catalog.
 *
 * Auth: reuses AUTOMATION_CRON_SECRET, same as /api/flows/cron and
 * /api/automations/cron — one secret for operators to provision.
 *
 * A catalog bigger than one leg's PAGE_CAP resumes via
 * `catalog_sync_cursor` on the NEXT scheduled run rather than in this
 * same request — keeps each invocation's runtime bounded regardless
 * of catalog size.
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const supplied = request.headers.get('x-cron-secret') ?? ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = supabaseAdmin()

  const { data: configs, error } = await admin
    .from('whatsapp_config')
    .select('account_id, catalog_id, access_token, catalog_sync_cursor, catalog_sync_started_at')
    .not('catalog_id', 'is', null)

  if (error) {
    console.error('[catalog-cron] config scan failed:', error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (!configs?.length) return NextResponse.json({ synced: 0, results: [] })

  // A large catalog takes longer than external pingers wait (cron-job.org
  // gives up at 30 s): answer right away and walk the catalog after the
  // response. The sync is resumable (catalog_sync_cursor), so a pass cut
  // short by a restart continues on the next run.
  if (syncRunning) return NextResponse.json({ started: false, reason: 'already running' }, { status: 202 })
  syncRunning = true
  after(async () => {
    try {
      const results = await syncAll(admin, configs)
      console.log('[catalog-cron] done:', JSON.stringify(results).slice(0, 500))
    } finally {
      syncRunning = false
    }
  })
  return NextResponse.json({ started: true, accounts: configs.length }, { status: 202 })
}

let syncRunning = false

async function syncAll(
  admin: ReturnType<typeof supabaseAdmin>,
  configs: Parameters<typeof syncCatalogForAccount>[2][] & { account_id: string }[],
) {
  const results: { account_id: string; ok: boolean; detail: unknown }[] = []
  for (const config of configs) {
    try {
      const result = await syncCatalogForAccount(admin, config.account_id, config)
      results.push({ account_id: config.account_id, ok: !('error' in result), detail: result })
    } catch (err) {
      results.push({
        account_id: config.account_id,
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return results
}
