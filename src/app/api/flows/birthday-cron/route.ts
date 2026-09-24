import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { startFlowRunForExternalEvent } from '@/lib/flows/engine'

// ============================================================
// GET /api/flows/birthday-cron
//
// Daily sweep: for every account that has configured a
// `birthday_flow_id`, find contacts whose "Fecha de nacimiento"
// custom field (format MM-DD — no year, we only ever compare the
// day-of-year) matches today, and start that account's birthday flow
// for each one. The flow itself (built in the visual editor, using a
// `send_template` node) is what actually sends the WhatsApp message —
// this route only decides WHO gets a run started today.
//
// Why a `send_template` node and not `send_message`: a birthday nudge
// is business-initiated, often days after the contact's last message
// to this number, so it needs an approved template (see
// SendTemplateNodeConfig) rather than a free-form session message.
//
// Auth: reuses `AUTOMATION_CRON_SECRET`, same header contract as
// `/api/flows/cron` and `/api/automations/cron` — one secret, three
// independent endpoints, so one failing sweep never blocks another.
//
// "Fecha de nacimiento" is looked up by exact field name rather than
// a configurable column — this account only needs the one field.
// A future multi-account rollout would want that name configurable
// per account instead of hardcoded here.
//
// Timezone note: "today" is computed from the server's UTC clock, not
// each contact's local time — for a once-a-day birthday message (not
// a time-sensitive transactional one) a few hours of slop across a
// date boundary is an acceptable trade-off against the complexity of
// per-account timezones.
// ============================================================

const BIRTHDAY_FIELD_NAME = 'Fecha de nacimiento'

function todayMonthDay(): string {
  const now = new Date()
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(now.getUTCDate()).padStart(2, '0')
  return `${mm}-${dd}`
}

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

  const db = supabaseAdmin()
  const monthDay = todayMonthDay()

  const { data: configs, error: configErr } = await db
    .from('whatsapp_config')
    .select('account_id, birthday_flow_id')
    .not('birthday_flow_id', 'is', null)
  if (configErr) {
    console.error('[birthday-cron] whatsapp_config scan failed:', configErr.message)
    return NextResponse.json({ error: configErr.message }, { status: 500 })
  }
  if (!configs?.length) return NextResponse.json({ started: 0, skipped: 0 })

  let started = 0
  let skipped = 0

  for (const config of configs as { account_id: string; birthday_flow_id: string }[]) {
    const { data: fieldRow, error: fieldErr } = await db
      .from('custom_fields')
      .select('id')
      .eq('account_id', config.account_id)
      .eq('field_name', BIRTHDAY_FIELD_NAME)
      .maybeSingle()
    if (fieldErr || !fieldRow) {
      // No birthday field configured for this account yet — nothing
      // to sweep, not an error.
      continue
    }

    // No account_id filter needed here beyond `custom_field_id`: each
    // custom_fields row belongs to exactly one account (NOT NULL
    // account_id), so a contact_custom_values row referencing this
    // field's id can only belong to a contact of that same account.
    const { data: matches, error: matchErr } = await db
      .from('contact_custom_values')
      .select('contact_id')
      .eq('custom_field_id', (fieldRow as { id: string }).id)
      .eq('value', monthDay)
    if (matchErr) {
      console.error(
        `[birthday-cron] custom-value scan failed for account ${config.account_id}:`,
        matchErr.message,
      )
      continue
    }

    for (const row of (matches ?? []) as { contact_id: string }[]) {
      const { data: conversation } = await db
        .from('conversations')
        .select('id')
        .eq('account_id', config.account_id)
        .eq('contact_id', row.contact_id)
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (!conversation) {
        // No conversation history for this contact — nothing to
        // attach the flow run to. Skip rather than fabricate one.
        skipped += 1
        continue
      }

      const result = await startFlowRunForExternalEvent(
        db,
        config.birthday_flow_id,
        {
          contactId: row.contact_id,
          conversationId: (conversation as { id: string }).id,
          vars: {},
        },
      )
      if (result.consumed) {
        started += 1
      } else {
        skipped += 1
      }
    }
  }

  return NextResponse.json({ started, skipped })
}
