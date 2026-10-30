import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { clearBusinessSettingsCache, loadBusinessSettings, type BusinessSettings } from '@/lib/business/settings'
import { HOST_CHANNEL, normalizeAdCode, pickAdCode, type AdLink } from '@/lib/marketing/ad-links'
import { countryOfPhone, hostDefaultMessage, hostScanPath, hostSummaryText } from '@/lib/marketing/hosts'
import { saveSettingsPatch } from '@/lib/marketing/settings-store'

// GET   /api/marketing/hosts → { program, hosts } — each Airbnb host with
//       its QR URL and what their guests did: scans, guests, orders and
//       sales (all time and this month), guests' countries, the summary
//       to send them. Sorted by sales.
// POST  { name, lodging, phone, reward, code? } → { host }
// PATCH { code, name?, lodging?, phone?, reward? } → { ok }
// PUT   { program } → { program }
// Deleting a host: DELETE /api/marketing/links?code=…
// Admins only.

type Db = ReturnType<typeof supabaseAdmin>

interface Totals {
  scans: number
  guests: number
  orders: number
  sales: number
}

const zero = (): Totals => ({ scans: 0, guests: 0, orders: 0, sales: 0 })

function monthStart(utcOffsetHours: number): Date {
  const local = new Date(Date.now() + utcOffsetHours * 3_600_000)
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - utcOffsetHours * 3_600_000)
}

function monthName(utcOffsetHours: number): string {
  const local = new Date(Date.now() + utcOffsetHours * 3_600_000)
  return local.toLocaleDateString('es', { month: 'long', year: 'numeric', timeZone: 'UTC' })
}

async function hostStats(db: Db, accountId: string, biz: BusinessSettings, hosts: AdLink[]) {
  const codes = hosts.map((h) => h.code)
  const since = monthStart(biz.utcOffsetHours).getTime()
  const all = new Map(codes.map((c) => [c, zero()]))
  const month = new Map(codes.map((c) => [c, zero()]))
  const countries = new Map(codes.map((c) => [c, new Map<string, number>()]))
  const lastOrder = new Map<string, string>()
  if (codes.length === 0) return { all, month, countries, lastOrder }

  const [{ data: scans }, { data: guests }] = await Promise.all([
    db.from('ad_link_scans').select('code, scanned_at').eq('account_id', accountId).in('code', codes).limit(50000),
    db
      .from('ad_link_contacts')
      .select('code, contact_id, first_seen_at, last_seen_at, contacts(phone)')
      .eq('account_id', accountId)
      .in('code', codes)
      .limit(10000),
  ])
  for (const s of (scans ?? []) as { code: string; scanned_at: string }[]) {
    all.get(s.code)!.scans++
    if (Date.parse(s.scanned_at) >= since) month.get(s.code)!.scans++
  }

  type GuestRow = {
    code: string
    contact_id: string
    first_seen_at: string
    last_seen_at: string
    contacts: { phone: string | null } | { phone: string | null }[] | null
  }
  const guestRows = (guests ?? []) as GuestRow[]
  for (const g of guestRows) {
    all.get(g.code)!.guests++
    if (Date.parse(g.first_seen_at) >= since) month.get(g.code)!.guests++
    const contact = Array.isArray(g.contacts) ? g.contacts[0] : g.contacts
    const country = countryOfPhone(contact?.phone ?? '')
    const byCountry = countries.get(g.code)!
    byCountry.set(country, (byCountry.get(country) ?? 0) + 1)
  }

  // Orders: the guest's cards on the order board, made while the
  // discount applied (first message with the code → last one + validity).
  const contactIds = [...new Set(guestRows.map((g) => g.contact_id))]
  if (contactIds.length === 0) return { all, month, countries, lastOrder }
  const { data: board } = await db
    .from('pipelines')
    .select('id, pipeline_stages(id, name)')
    .eq('account_id', accountId)
    .eq('name', biz.orderBoard.pipelineName)
    .limit(1)
    .maybeSingle()
  if (!board) return { all, month, countries, lastOrder }
  const cancelled = new Set(
    ((board as { pipeline_stages: { id: string; name: string }[] }).pipeline_stages ?? [])
      .filter((st) => /^cancel/i.test(st.name.trim()))
      .map((st) => st.id),
  )
  const deals: { contact_id: string; stage_id: string; status: string; value: number | null; created_at: string }[] = []
  for (let i = 0; i < contactIds.length; i += 200) {
    const { data } = await db
      .from('deals')
      .select('contact_id, stage_id, status, value, created_at')
      .eq('account_id', accountId)
      .eq('pipeline_id', (board as { id: string }).id)
      .in('contact_id', contactIds.slice(i, i + 200))
      .limit(5000)
    deals.push(...((data ?? []) as typeof deals))
  }
  const validMs = biz.hostProgram.validDays * 86_400_000
  for (const d of deals) {
    if (cancelled.has(d.stage_id) || d.status === 'lost') continue
    const at = Date.parse(d.created_at)
    // The host whose QR the guest used most recently before this order.
    const host = guestRows
      .filter(
        (g) =>
          g.contact_id === d.contact_id &&
          Date.parse(g.first_seen_at) <= at &&
          at <= Date.parse(g.last_seen_at) + validMs,
      )
      .sort((a, b) => Date.parse(b.first_seen_at) - Date.parse(a.first_seen_at))[0]
    if (!host) continue
    const value = Number(d.value) || 0
    const t = all.get(host.code)!
    t.orders++
    t.sales += value
    if (at >= since) {
      const m = month.get(host.code)!
      m.orders++
      m.sales += value
    }
    if ((lastOrder.get(host.code) ?? '') < d.created_at) lastOrder.set(host.code, d.created_at)
  }
  return { all, month, countries, lastOrder }
}

function appBaseUrl(biz: BusinessSettings, request: Request): string {
  if (biz.publicAppUrl) return biz.publicAppUrl
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host')
  const proto = request.headers.get('x-forwarded-proto') ?? 'https'
  return host ? `${proto}://${host}` : new URL(request.url).origin
}

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
  const hosts = biz.adLinks.filter((l) => l.host)
  const stats = await hostStats(db, ctx.accountId, biz, hosts)
  const base = appBaseUrl(biz, request)
  const month = monthName(biz.utcOffsetHours)
  const rows = hosts.map((h) => {
    const m = stats.month.get(h.code)!
    return {
      ...h,
      scanUrl: `${base}${hostScanPath(ctx.accountId, h.code)}`,
      all: stats.all.get(h.code)!,
      month: m,
      countries: [...stats.countries.get(h.code)!.entries()]
        .map(([country, count]) => ({ country, count }))
        .sort((a, b) => b.count - a.count),
      lastOrderAt: stats.lastOrder.get(h.code) ?? null,
      summary: hostSummaryText(h, { month, guests: m.guests, orders: m.orders, sales: m.sales }),
    }
  })
  rows.sort((a, b) => b.all.sales - a.all.sales || b.all.orders - a.all.orders || b.all.scans - a.all.scans)
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
  return NextResponse.json({ program: (await loadBusinessSettings(db, ctx.accountId)).hostProgram })
}
