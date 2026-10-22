import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { clearBusinessSettingsCache, loadBusinessSettings, sanitizeSettings } from '@/lib/business/settings'
import { adLinkUrl, adOriginTag, normalizeAdCode, type AdLink } from '@/lib/marketing/ad-links'

// GET /api/marketing/links → { links, whatsappNumber }
//   Each advertising link with its wa.me URL, how many contacts wrote
//   through it and how many orders/requests (board cards) they made since.
// POST /api/marketing/links { name, channel, message, code? } → { link }
// DELETE /api/marketing/links?code=TORTAS
//   Admins only. Links live in the business settings (adLinks).

type Db = ReturnType<typeof supabaseAdmin>

async function storedSettings(db: Db, accountId: string): Promise<Record<string, unknown>> {
  const { data } = await db.from('business_settings').select('settings').eq('account_id', accountId).maybeSingle()
  const s = (data as { settings?: unknown } | null)?.settings
  return s && typeof s === 'object' && !Array.isArray(s) ? (s as Record<string, unknown>) : {}
}

async function saveLinks(db: Db, accountId: string, links: AdLink[]): Promise<boolean> {
  const stored = await storedSettings(db, accountId)
  const settings = sanitizeSettings({ ...stored, adLinks: links })
  const { error } = await db
    .from('business_settings')
    .upsert({ account_id: accountId, settings, updated_at: new Date().toISOString() }, { onConflict: 'account_id' })
  if (error) console.error('[marketing] save failed:', error.message)
  clearBusinessSettingsCache(accountId)
  return !error
}

async function linkStats(db: Db, accountId: string, link: AdLink): Promise<{ contacts: number; orders: number }> {
  const { data: tag } = await db
    .from('tags')
    .select('id')
    .eq('account_id', accountId)
    .eq('name', adOriginTag(link))
    .maybeSingle()
  if (!tag) return { contacts: 0, orders: 0 }
  const { data: rows } = await db
    .from('contact_tags')
    .select('contact_id')
    .eq('tag_id', (tag as { id: string }).id)
    .limit(2000)
  const contactIds = ((rows ?? []) as { contact_id: string }[]).map((r) => r.contact_id)
  if (contactIds.length === 0) return { contacts: 0, orders: 0 }
  const { count } = await db
    .from('deals')
    .select('id', { count: 'exact', head: true })
    .in('contact_id', contactIds.slice(0, 500))
    .gte('created_at', link.createdAt)
  return { contacts: contactIds.length, orders: count ?? 0 }
}

export async function GET() {
  let ctx
  try {
    ctx = await requireRole('admin')
  } catch (err) {
    return toErrorResponse(err)
  }
  const db = supabaseAdmin()
  clearBusinessSettingsCache(ctx.accountId)
  const biz = await loadBusinessSettings(db, ctx.accountId)
  const links = await Promise.all(
    biz.adLinks.map(async (l) => ({
      ...l,
      url: biz.whatsappNumber ? adLinkUrl(biz.whatsappNumber, l) : '',
      ...(await linkStats(db, ctx.accountId, l)),
    })),
  )
  links.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return NextResponse.json({
    links,
    whatsappNumber: biz.whatsappNumber,
    businessName: biz.name,
    countryCode: biz.phoneCountryCode,
  })
}

export async function POST(request: Request) {
  let ctx
  try {
    ctx = await requireRole('admin')
  } catch (err) {
    return toErrorResponse(err)
  }
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 80) : ''
  if (!name) return NextResponse.json({ error: 'name_required' }, { status: 400 })
  const db = supabaseAdmin()
  clearBusinessSettingsCache(ctx.accountId)
  const biz = await loadBusinessSettings(db, ctx.accountId)
  const taken = new Set(biz.adLinks.map((l) => l.code))
  let code = normalizeAdCode(typeof body?.code === 'string' && body.code ? body.code : name.split(/\s+/)[0] ?? '')
  if (!code) code = 'AD'
  if (taken.has(code)) {
    if (typeof body?.code === 'string' && body.code) {
      return NextResponse.json({ error: 'code_taken' }, { status: 409 })
    }
    let n = 2
    while (taken.has(`${code.slice(0, 18)}${n}`)) n++
    code = `${code.slice(0, 18)}${n}`
  }
  const link: AdLink = {
    code,
    name,
    channel: typeof body?.channel === 'string' && body.channel.trim() ? body.channel.trim().slice(0, 40) : 'Otro',
    message: typeof body?.message === 'string' ? body.message.trim().slice(0, 300) : '',
    createdAt: new Date().toISOString(),
  }
  if (!(await saveLinks(db, ctx.accountId, [link, ...biz.adLinks]))) {
    return NextResponse.json({ error: 'save_failed' }, { status: 500 })
  }
  return NextResponse.json({ link: { ...link, url: biz.whatsappNumber ? adLinkUrl(biz.whatsappNumber, link) : '' } })
}

export async function DELETE(request: Request) {
  let ctx
  try {
    ctx = await requireRole('admin')
  } catch (err) {
    return toErrorResponse(err)
  }
  const code = normalizeAdCode(new URL(request.url).searchParams.get('code') ?? '')
  const db = supabaseAdmin()
  clearBusinessSettingsCache(ctx.accountId)
  const biz = await loadBusinessSettings(db, ctx.accountId)
  if (!(await saveLinks(db, ctx.accountId, biz.adLinks.filter((l) => l.code !== code)))) {
    return NextResponse.json({ error: 'save_failed' }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}
