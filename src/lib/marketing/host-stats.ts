import type { SupabaseClient } from '@supabase/supabase-js'
import type { BusinessSettings } from '@/lib/business/settings'
import type { AdLink } from './ad-links'
import { countryOfPhone, hostScanPath, hostSummaryText } from './hosts'

// What each partner host's guests did — scans, guests, orders, sales
// (all time and this month) and their countries. Shared by the CRM's
// Advertising page and the public API (GET /api/v1/hosts).

type Db = SupabaseClient

export interface Totals {
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

export function monthName(utcOffsetHours: number): string {
  const local = new Date(Date.now() + utcOffsetHours * 3_600_000)
  return local.toLocaleDateString('es', { month: 'long', year: 'numeric', timeZone: 'UTC' })
}

export async function hostStats(db: Db, accountId: string, biz: BusinessSettings, hosts: AdLink[]) {
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

export function appBaseUrl(biz: BusinessSettings, request: Request): string {
  if (biz.publicAppUrl) return biz.publicAppUrl
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host')
  const proto = request.headers.get('x-forwarded-proto') ?? 'https'
  return host ? `${proto}://${host}` : new URL(request.url).origin
}


/** Each host with its QR link and results, best sellers first. */
export async function hostRows(db: Db, accountId: string, biz: BusinessSettings, base: string) {
  const hosts = biz.adLinks.filter((l) => l.host)
  const stats = await hostStats(db, accountId, biz, hosts)
  const month = monthName(biz.utcOffsetHours)
  const rows = hosts.map((h) => {
    const m = stats.month.get(h.code)!
    return {
      ...h,
      scanUrl: `${base}${hostScanPath(accountId, h.code)}`,
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
  return { rows, month }
}

/**
 * What another app (the designer) gets about a host: never the host's
 * phone or agreed reward — those stay in the CRM.
 */
export function hostPublicView(h: AdLink, scanUrl: string) {
  return {
    code: h.code,
    name: h.name,
    lodging: h.host?.lodging ?? '',
    scan_url: scanUrl,
    created_at: h.createdAt,
  }
}

/** The host program's terms, as the design app shows them on the sign. */
export function programView(p: BusinessSettings['hostProgram']) {
  return {
    discount_pct: p.discountPct,
    free_delivery_from: p.freeDeliveryFrom,
    valid_days: p.validDays,
  }
}
