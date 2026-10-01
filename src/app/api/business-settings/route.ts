import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import {
  DEFAULT_BUSINESS_SETTINGS,
  clearBusinessSettingsCache,
  loadBusinessSettings,
  sanitizeSettings,
} from '@/lib/business/settings'

// GET /api/business-settings → { settings, defaults }
//   The account's business settings (merged over the defaults), for
//   Settings → My business. Any member may read them.
//
// PUT /api/business-settings  { settings }
//   Admins only. The body is checked key by key against the defaults
//   (wrong types and bad list items are dropped) and saved whole, so
//   the bot picks it up within a minute (per-process cache) — at once
//   on the server that handled the save.

export async function GET() {
  let ctx
  try {
    ctx = await requireRole('viewer')
  } catch (err) {
    return toErrorResponse(err)
  }
  const db = supabaseAdmin()
  clearBusinessSettingsCache(ctx.accountId)
  const settings = await loadBusinessSettings(db, ctx.accountId)
  return NextResponse.json({ settings, defaults: DEFAULT_BUSINESS_SETTINGS })
}

const MAX_BYTES = 200_000

export async function PUT(request: Request) {
  let ctx
  try {
    ctx = await requireRole('admin')
  } catch (err) {
    return toErrorResponse(err)
  }
  const raw = await request.text()
  if (raw.length > MAX_BYTES) {
    return NextResponse.json({ error: 'Settings too large' }, { status: 413 })
  }
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return NextResponse.json({ error: 'Malformed JSON' }, { status: 400 })
  }
  const input = (body as { settings?: unknown } | null)?.settings
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return NextResponse.json({ error: 'Missing settings object' }, { status: 400 })
  }

  const settings = sanitizeSettings(input)
  const db = supabaseAdmin()
  const { error } = await db
    .from('business_settings')
    .upsert(
      { account_id: ctx.accountId, settings, updated_at: new Date().toISOString() },
      { onConflict: 'account_id' },
    )
  if (error) {
    console.error('[business-settings] save failed:', error.message)
    return NextResponse.json({ error: 'Save failed' }, { status: 500 })
  }
  clearBusinessSettingsCache(ctx.accountId)
  return NextResponse.json({ settings })
}
