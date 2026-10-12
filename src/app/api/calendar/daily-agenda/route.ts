import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { dailyAgenda } from '@/lib/calendar/appointments'
import { notifyAccountInApp } from '@/lib/pipelines/order-cards'
import { notifyStaffOfHandoff } from '@/lib/whatsapp/staff-notify'

// GET /api/calendar/daily-agenda  (X-Cron-Secret = AUTOMATION_CRON_SECRET)
//
// Each morning: today's service visits and bakery orders for the team —
// an in-app notification for everyone, and a WhatsApp message to staff
// on shift. Accounts with nothing scheduled get nothing.

function cronAuthorized(request: Request): boolean {
  const expected = process.env.AUTOMATION_CRON_SECRET
  const supplied = request.headers.get('x-cron-secret') ?? ''
  if (!expected || !supplied) return false
  const a = Buffer.from(supplied)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export async function GET(request: Request) {
  if (!cronAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const db = supabaseAdmin()
  const { data: accounts } = await db.from('accounts').select('id')
  const results: Record<string, unknown> = {}
  for (const { id } of (accounts ?? []) as { id: string }[]) {
    try {
      const agenda = await dailyAgenda(db, id)
      if (!agenda) continue
      const toCall = agenda.toCall ? `\n\n📞 ${agenda.toCall} sin confirmar: llámelos o espere su *OK*.` : ''
      await notifyAccountInApp(db, {
        accountId: id,
        conversationId: null,
        contactId: null,
        title: `📅 Agenda de hoy: ${agenda.count}`,
        body: agenda.text,
      })
      const staff = await notifyStaffOfHandoff(db, { accountId: id, contactName: '', summary: agenda.text + toCall })
      results[id] = { count: agenda.count, whatsapp: staff.sent.length }
    } catch (err) {
      console.error('[daily-agenda] failed for', id, err)
      results[id] = { error: true }
    }
  }
  return NextResponse.json({ results })
}
