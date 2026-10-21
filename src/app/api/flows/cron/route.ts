import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { resolveFallbackPolicy } from '@/lib/flows/fallback'
import { sweepCartReminders } from '@/lib/flows/engine'
import { sweepStaffShifts } from '@/lib/whatsapp/staff-notify'
import { localPhone } from '@/lib/whatsapp/phone-utils'
import { loadBusinessSettings } from '@/lib/business/settings'

/**
 * Sweep abandoned active flow runs.
 *
 * Reads each active run's parent-flow `fallback_policy.on_timeout_hours`
 * to compute the staleness cutoff (default 24h), then marks any run
 * past its cutoff as `timed_out`. Writes a matching `flow_run_events`
 * row for the audit trail.
 *
 * Without this sweep, a customer who abandons a flow mid-conversation
 * keeps a row in `idx_one_active_run_per_contact` (the partial unique
 * index on `flow_runs WHERE status='active'`) forever — blocking any
 * new triggers for them. The cron is therefore not optional.
 *
 * Auth: re-uses `AUTOMATION_CRON_SECRET` so operators only have one
 * secret to provision. The two endpoints (`/api/automations/cron`
 * and this one) are independent operations; we keep them on separate
 * URLs so one failing doesn't block the other.
 *
 * Hosting: hit on a schedule (Vercel Cron / GitHub Actions / external
 * pinger). A 5-minute interval is more than enough for a 24h timeout
 * default; once per hour would also be acceptable for low-volume
 * tenants.
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  // Constant-time compare so an attacker who can hit the endpoint
  // can't recover the secret byte-by-byte from response-time deltas.
  // Length pre-check is required by timingSafeEqual (throws otherwise)
  // and leaks only the length itself, which isn't sensitive.
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
  const now = new Date()

  // Carts left in the product picker whose reminder timer was lost
  // (restart) or fell outside opening hours.
  const cartReminders = await sweepCartReminders(admin).catch((err) => {
    console.error('[flows/cron] cart reminders failed:', err)
    return 0
  })

  // Staff alerts only reach numbers that wrote to the bot in the last
  // 24 h: remind each one before their window closes (free while open)
  // and tell the admins when one has closed.
  const staffShifts = await sweepAllStaffShifts(admin).catch((err) => {
    console.error('[flows/cron] staff shifts failed:', err)
    return null
  })

  // Pull all currently-active runs along with their parent flow's
  // fallback_policy. Joined in one query — the small set of active
  // runs per tenant keeps this cheap.
  const { data: runs, error } = await admin
    .from('flow_runs')
    .select(
      'id, flow_id, user_id, contact_id, last_advanced_at, flows ( fallback_policy )',
    )
    .eq('status', 'active')

  if (error) {
    console.error('[flows-cron] active-run scan failed:', error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (!runs?.length) return NextResponse.json({ swept: 0, cartReminders, staffShifts })

  type Row = {
    id: string
    flow_id: string
    user_id: string
    contact_id: string | null
    last_advanced_at: string
    flows: { fallback_policy: unknown } | { fallback_policy: unknown }[] | null
  }

  let swept = 0
  for (const r of runs as Row[]) {
    const flowsField = Array.isArray(r.flows) ? r.flows[0] : r.flows
    const policy = resolveFallbackPolicy(flowsField?.fallback_policy ?? null)
    const lastAdvanced = new Date(r.last_advanced_at)
    const ageHours = (now.getTime() - lastAdvanced.getTime()) / (1000 * 60 * 60)
    if (ageHours < policy.on_timeout_hours) continue

    // Mark timed_out — guarded by the precondition `status='active'`
    // so concurrent advance from a late inbound doesn't overwrite a
    // legitimate update.
    const { data: updated } = await admin
      .from('flow_runs')
      .update({
        status: 'timed_out',
        ended_at: now.toISOString(),
        end_reason: 'stale_sweep',
      })
      .eq('id', r.id)
      .eq('status', 'active')
      .select('id')

    if (Array.isArray(updated) && updated.length > 0) {
      await admin.from('flow_run_events').insert({
        flow_run_id: r.id,
        event_type: 'timeout',
        payload: {
          age_hours: Math.round(ageHours * 10) / 10,
          policy_hours: policy.on_timeout_hours,
        },
      })
      swept += 1
    }
  }

  return NextResponse.json({ swept, cartReminders, staffShifts })
}

async function sweepAllStaffShifts(admin: ReturnType<typeof supabaseAdmin>) {
  const { data: accounts } = await admin.from('business_settings').select('account_id')
  const out: Record<string, unknown> = {}
  for (const { account_id: accountId } of (accounts ?? []) as { account_id: string }[]) {
    const biz = await loadBusinessSettings(admin, accountId)
    const { data: admins } = await admin
      .from('profiles')
      .select('user_id')
      .eq('account_id', accountId)
      .in('account_role', ['owner', 'admin'])
    const userIds = ((admins ?? []) as { user_id: string | null }[]).map((a) => a.user_id).filter((u): u is string => !!u)
    out[accountId] = await sweepStaffShifts(admin, accountId, async (member) => {
      if (!userIds.length) return
      const who = `${member.name || 'Personal'} (${localPhone(member.phone, biz.phoneCountryCode)})`
      await admin.from('notifications').insert(
        userIds.map((user_id) => ({
          account_id: accountId,
          user_id,
          type: 'conversation_assigned',
          title: `⚠️ Turno vencido: ${who}`,
          body: 'Ya no recibe los avisos de pedidos por WhatsApp hasta que escriba *turno* al bot (o toque Recibido en un aviso).',
        })),
      )
    })
  }
  return out
}
