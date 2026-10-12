import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { confirmAppointment, syncDealCalendar } from '@/lib/calendar/appointments'

// POST /api/pipelines/deals/:id/appointment   { appointment_at: ISO | null, notify?: boolean }
//
// Sets (or clears) the card's appointment — a service visit, or when a
// bakery order is ready — copies it to Google Calendar, and (notify,
// default true) tells the customer the date when that's free.
//
// Response: { calendar: 'synced' | 'removed' | 'none' | 'off' | 'failed',
//             customer: 'sent' | 'window_closed' | 'no_conversation' | 'none' | 'failed' | 'skipped' }

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  let ctx
  try {
    ctx = await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }
  let body: { appointment_at?: unknown; notify?: unknown }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return NextResponse.json({ error: 'bad_json' }, { status: 400 })
  }
  const raw = body.appointment_at
  const when = typeof raw === 'string' && raw ? new Date(raw) : null
  if (raw !== null && raw !== undefined && raw !== '' && (!when || Number.isNaN(when.getTime()))) {
    return NextResponse.json({ error: 'bad_date' }, { status: 400 })
  }

  const db = supabaseAdmin()
  const { data: deal } = await db
    .from('deals')
    .select('id, appointment_at')
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .maybeSingle()
  if (!deal) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const next = when ? when.toISOString() : null
  const changed = (deal.appointment_at ? new Date(deal.appointment_at).toISOString() : null) !== next
  if (changed) {
    const { error } = await db
      .from('deals')
      .update({ appointment_at: next, appointment_reminded_at: null, updated_at: new Date().toISOString() })
      .eq('id', id)
    if (error) return NextResponse.json({ error: 'save_failed' }, { status: 500 })
  }
  const calendar = await syncDealCalendar(db, id)
  const customer = next && changed && body.notify !== false ? await confirmAppointment(db, id) : 'skipped'
  return NextResponse.json({ calendar, customer })
}
