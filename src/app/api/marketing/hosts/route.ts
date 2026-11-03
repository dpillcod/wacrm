import { after, NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { clearBusinessSettingsCache, loadBusinessSettings } from '@/lib/business/settings'
import { HOST_CHANNEL, normalizeAdCode, pickAdCode, type AdLink } from '@/lib/marketing/ad-links'
import { hostDefaultMessage, hostScanPath } from '@/lib/marketing/hosts'
import { appBaseUrl, hostPublicView, hostRows, programView } from '@/lib/marketing/host-stats'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'
import { saveSettingsPatch } from '@/lib/marketing/settings-store'

// GET   /api/marketing/hosts → { program, hosts } — each Airbnb host with
//       its QR URL and what their guests did: scans, guests, orders and
//       sales (all time and this month), guests' countries, the summary
//       to send them. Sorted by sales.
// POST  { name, lodging, phone, reward, code? } → { host }
// PATCH { code, name?, lodging?, phone?, reward? } → { ok }
// PUT   { program } → { program }
// Deleting a host: DELETE /api/marketing/links?code=…
// Admins only. Each change is also announced to the account's webhooks
// (host.created / host.updated / host.deleted / host_program.updated),
// so the design app picks up new hosts and their QR links by itself.

export async function GET(request: Request) {
  let ctx
  try {
    ctx = await requireRole('admin')
  } catch (err) {
    return toErrorResponse(err)
  }
  const db = supabaseAdmin()
  clearBusinessSettingsCache(ctx.accountId)
  const biz = await loadBusinessSettings(db, ctx.accountId)
  const { rows, month } = await hostRows(db, ctx.accountId, biz, appBaseUrl(biz, request))
  return NextResponse.json({
    program: biz.hostProgram,
    hosts: rows,
    hasNumber: Boolean(biz.whatsappNumber),
    businessName: biz.name,
    month,
  })
}

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '')

export async function POST(request: Request) {
  let ctx
  try {
    ctx = await requireRole('admin')
  } catch (err) {
    return toErrorResponse(err)
  }
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  const name = text(body?.name, 80)
  const lodging = text(body?.lodging, 80)
  if (!name) return NextResponse.json({ error: 'name_required' }, { status: 400 })
  const db = supabaseAdmin()
  clearBusinessSettingsCache(ctx.accountId)
  const biz = await loadBusinessSettings(db, ctx.accountId)
  const code = pickAdCode(text(body?.code, 20), name, biz.adLinks.map((l) => l.code))
  if (!code) return NextResponse.json({ error: 'code_taken' }, { status: 409 })
  const link: AdLink = {
    code,
    name,
    channel: HOST_CHANNEL,
    message: hostDefaultMessage(lodging || name),
    createdAt: new Date().toISOString(),
    host: { lodging, phone: text(body?.phone, 20).replace(/\D/g, ''), reward: text(body?.reward, 120) },
  }
  if (!(await saveSettingsPatch(db, ctx.accountId, { adLinks: [link, ...biz.adLinks] }))) {
    return NextResponse.json({ error: 'save_failed' }, { status: 500 })
  }
  const accountId = ctx.accountId
  const scanUrl = `${appBaseUrl(biz, request)}${hostScanPath(accountId, code)}`
  after(() => dispatchWebhookEvent(db, accountId, 'host.created', hostPublicView(link, scanUrl)))
  return NextResponse.json({ host: link })
}

export async function PATCH(request: Request) {
  let ctx
  try {
    ctx = await requireRole('admin')
  } catch (err) {
    return toErrorResponse(err)
  }
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  const code = normalizeAdCode(text(body?.code, 20))
  const db = supabaseAdmin()
  clearBusinessSettingsCache(ctx.accountId)
  const biz = await loadBusinessSettings(db, ctx.accountId)
  const current = biz.adLinks.find((l) => l.code === code && l.host)
  if (!current?.host) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  const pick = (key: string, max: number, fallback: string) =>
    typeof body?.[key] === 'string' ? text(body[key], max) : fallback
  const lodging = pick('lodging', 80, current.host.lodging)
  const updated: AdLink = {
    ...current,
    name: pick('name', 80, current.name) || current.name,
    message: lodging !== current.host.lodging ? hostDefaultMessage(lodging || current.name) : current.message,
    host: {
      lodging,
      phone: pick('phone', 20, current.host.phone).replace(/\D/g, ''),
      reward: pick('reward', 120, current.host.reward),
    },
  }
  const links = biz.adLinks.map((l) => (l.code === code ? updated : l))
  if (!(await saveSettingsPatch(db, ctx.accountId, { adLinks: links }))) {
    return NextResponse.json({ error: 'save_failed' }, { status: 500 })
  }
  if (updated.name !== current.name || lodging !== current.host.lodging) {
    const accountId = ctx.accountId
    const scanUrl = `${appBaseUrl(biz, request)}${hostScanPath(accountId, code)}`
    after(() => dispatchWebhookEvent(db, accountId, 'host.updated', hostPublicView(updated, scanUrl)))
  }
  return NextResponse.json({ ok: true })
}

export async function PUT(request: Request) {
  let ctx
  try {
    ctx = await requireRole('admin')
  } catch (err) {
    return toErrorResponse(err)
  }
  const body = (await request.json().catch(() => null)) as { program?: unknown } | null
  const program = body?.program
  if (!program || typeof program !== 'object' || Array.isArray(program)) {
    return NextResponse.json({ error: 'program_required' }, { status: 400 })
  }
  const db = supabaseAdmin()
  if (!(await saveSettingsPatch(db, ctx.accountId, { hostProgram: program }))) {
    return NextResponse.json({ error: 'save_failed' }, { status: 500 })
  }
  const saved = (await loadBusinessSettings(db, ctx.accountId)).hostProgram
  const accountId = ctx.accountId
  after(() => dispatchWebhookEvent(db, accountId, 'host_program.updated', programView(saved)))
  return NextResponse.json({ program: saved })
}
