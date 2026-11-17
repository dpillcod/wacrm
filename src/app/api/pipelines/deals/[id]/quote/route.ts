import { randomBytes } from 'node:crypto'
import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { loadBusinessSettings, renderText } from '@/lib/business/settings'
import { customerWindowOpen } from '@/lib/pipelines/order-cards'
import { localPhone } from '@/lib/whatsapp/phone-utils'
import { SendMessageError, sendMessageToConversation } from '@/lib/whatsapp/send-message'
import { buildQuotePdf } from '@/lib/pipelines/quote-pdf'
import {
  localDate,
  quoteDraftFromNotes,
  quoteMoney,
  quoteNumber,
  quoteReplyIds,
  quoteTotals,
  sanitizeQuoteItems,
  type Quote,
  type QuoteSeller,
} from '@/lib/pipelines/quote'

// GET  /api/pipelines/deals/:id/quote
//   → { quote, windowOpen } — the saved quote, or a draft from the card's list.
// POST /api/pipelines/deals/:id/quote
//   { items, delivery, validDays, notes, customerName, customerId, action }
//   action 'save' → { quote }            (card value = total)
//   action 'pdf'  → the PDF (saved first)
//   action 'send' → { sent, reason? }    PDF + [✅ Acepto] [✏️ Cambiar algo] in the chat,
//                   only within the free 24 h window; the card moves to "Cotizado".

type Db = ReturnType<typeof supabaseAdmin>

const CHAT_MEDIA_BUCKET = 'chat-media'

interface DealRow {
  id: string
  title: string
  notes: string | null
  account_id: string
  contact_id: string | null
  conversation_id: string | null
  pipeline_id: string
  stage_id: string
  quote: Quote | null
}

async function loadDeal(db: Db, id: string, accountId: string): Promise<DealRow | null> {
  const { data } = await db
    .from('deals')
    .select('id, title, notes, account_id, contact_id, conversation_id, pipeline_id, stage_id, quote')
    .eq('id', id)
    .eq('account_id', accountId)
    .maybeSingle()
  return (data as DealRow | null) ?? null
}

async function contactOf(db: Db, contactId: string | null, countryCode: string) {
  if (!contactId) return { name: '', phone: '' }
  const { data } = await db.from('contacts').select('name, phone').eq('id', contactId).maybeSingle()
  const c = data as { name?: string | null; phone?: string | null } | null
  return {
    name: c?.name?.trim() ?? '',
    phone: c?.phone ? localPhone(c.phone.replace(/^\+/, ''), countryCode) : '',
  }
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  let ctx
  try {
    ctx = await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }
  const db = supabaseAdmin()
  const deal = await loadDeal(db, id, ctx.accountId)
  if (!deal) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const biz = await loadBusinessSettings(db, ctx.accountId)
  let quote = deal.quote
  if (!quote) {
    const draft = quoteDraftFromNotes(deal.notes)
    const contact = await contactOf(db, deal.contact_id, biz.phoneCountryCode)
    quote = {
      number: quoteNumber(deal.title, deal.id),
      items: draft.items,
      delivery: 0,
      validDays: biz.quote.validDays,
      notes: '',
      customerName: draft.customerName || contact.name,
      customerId: draft.customerId,
      customerPhone: contact.phone,
      createdAt: new Date().toISOString(),
      status: 'draft',
    }
  }
  const windowOpen = deal.conversation_id ? await customerWindowOpen(db, deal.conversation_id) : false
  return NextResponse.json({ quote, windowOpen })
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  let ctx
  try {
    ctx = await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }
  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'bad_json' }, { status: 400 })
  }
  const action = body.action === 'pdf' || body.action === 'send' ? body.action : 'save'
  const db = supabaseAdmin()
  const deal = await loadDeal(db, id, ctx.accountId)
  if (!deal) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const biz = await loadBusinessSettings(db, ctx.accountId)

  const items = sanitizeQuoteItems(body.items)
  if (!items.length) return NextResponse.json({ error: 'no_items' }, { status: 400 })
  const num = (v: unknown, min: number, max: number, dflt: number) => {
    const n = Number(v)
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : dflt
  }
  const str = (v: unknown, max: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
  const contact = await contactOf(db, deal.contact_id, biz.phoneCountryCode)
  const quote: Quote = {
    number: deal.quote?.number ?? quoteNumber(deal.title, deal.id),
    items,
    delivery: Math.round(num(body.delivery, 0, 100000, 0) * 100) / 100,
    validDays: Math.round(num(body.validDays, 1, 60, biz.quote.validDays)),
    notes: String(body.notes ?? '').trim().slice(0, 1500),
    customerName: str(body.customerName, 120),
    customerId: str(body.customerId, 20).replace(/[^\dA-Z]/gi, ''),
    customerPhone: contact.phone,
    createdAt: new Date().toISOString(),
    sentAt: deal.quote?.sentAt ?? null,
    status: deal.quote?.status === 'accepted' ? 'accepted' : deal.quote?.status ?? 'draft',
  }
  const totals = quoteTotals(quote)

  if (action === 'send') {
    if (items.some((i) => !i.unitPrice)) {
      return NextResponse.json({ sent: false, reason: 'missing_prices' })
    }
    if (!deal.conversation_id || !deal.contact_id) {
      return NextResponse.json({ sent: false, reason: 'no_conversation' })
    }
    if (!(await customerWindowOpen(db, deal.conversation_id))) {
      // Saved anyway: the staff member can download the PDF and call.
      await db.from('deals').update({ quote, value: totals.total }).eq('id', deal.id)
      return NextResponse.json({ sent: false, reason: 'window_closed' })
    }
  }

  const seller: QuoteSeller = {
    name: biz.name,
    legalName: biz.quote.legalName,
    taxId: biz.quote.taxId,
    address: biz.quote.address,
    phone: biz.quote.phone || biz.callCenterPhone,
    email: biz.quote.email,
    website: biz.websiteUrl.replace(/^https?:\/\//, '').replace(/\/$/, ''),
    footer: biz.quote.footer,
    utcOffsetHours: biz.utcOffsetHours,
  }
  const pdf = await buildQuotePdf(quote, seller)
  const filename = `Cotizacion-${quote.number}.pdf`

  if (action === 'save' || action === 'pdf') {
    await db.from('deals').update({ quote, value: totals.total }).eq('id', deal.id)
    if (action === 'save') return NextResponse.json({ quote })
    return new Response(Buffer.from(pdf), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${filename}"`,
        'Cache-Control': 'no-store',
      },
    })
  }

  // Send: a public copy of the PDF for Meta to fetch (unguessable name).
  // Same bucket and path convention as the inbox's attachments (023).
  const path = `account-${ctx.accountId}/${Date.now()}-cotizacion-${quote.number}-${randomBytes(9).toString('hex')}.pdf`
  const { error: upErr } = await db.storage
    .from(CHAT_MEDIA_BUCKET)
    .upload(path, Buffer.from(pdf), { contentType: 'application/pdf', upsert: false })
  if (upErr) {
    console.error('[quote] upload failed:', upErr.message)
    return NextResponse.json({ sent: false, reason: 'upload_failed' })
  }
  const url = db.storage.from(CHAT_MEDIA_BUCKET).getPublicUrl(path).data.publicUrl
  const message = renderText(biz.quote.message, {
    cotizacion: quote.number,
    total: quoteMoney(totals.total),
    validez: localDate(quote.createdAt, biz.utcOffsetHours, quote.validDays),
  })
  const ids = quoteReplyIds(deal.id)
  try {
    await sendMessageToConversation(db, ctx.accountId, {
      conversationId: deal.conversation_id!,
      messageType: 'document',
      mediaUrl: url,
      filename,
      contentText: `Cotización ${quote.number}${biz.name ? ` · ${biz.name}` : ''}`,
    })
    await sendMessageToConversation(db, ctx.accountId, {
      conversationId: deal.conversation_id!,
      messageType: 'interactive',
      interactivePayload: {
        kind: 'buttons',
        body: message.slice(0, 1024),
        buttons: [
          { id: ids.ok, title: '✅ Acepto' },
          { id: ids.change, title: '✏️ Cambiar algo' },
        ],
      },
    })
  } catch (err) {
    console.error('[quote] send failed:', err instanceof SendMessageError ? err.message : err)
    return NextResponse.json({ sent: false, reason: 'send_failed' })
  }

  const sent: Quote = { ...quote, sentAt: new Date().toISOString(), status: 'sent' }
  const update: Record<string, unknown> = { quote: sent, value: totals.total }
  const quotedStage = await quotedStageFor(db, deal)
  if (quotedStage) update.stage_id = quotedStage
  const line = `💲 Cotización ${quote.number} enviada: ${quoteMoney(totals.total)} (válida hasta ${localDate(quote.createdAt, biz.utcOffsetHours, quote.validDays)})`
  update.notes = `${deal.notes ?? ''}\n${line}`.trim()
  await db.from('deals').update(update).eq('id', deal.id)
  return NextResponse.json({ sent: true, movedTo: quotedStage ? 'quoted' : null })
}

/** The board's "Cotizado" column, when the card is still in the first column. */
async function quotedStageFor(db: Db, deal: DealRow): Promise<string | null> {
  const { data } = await db
    .from('pipeline_stages')
    .select('id, name, position')
    .eq('pipeline_id', deal.pipeline_id)
    .order('position', { ascending: true })
  const stages = (data ?? []) as { id: string; name: string; position: number }[]
  if (!stages.length || stages[0].id !== deal.stage_id) return null
  return stages.find((s) => /cotiz/i.test(s.name))?.id ?? null
}
