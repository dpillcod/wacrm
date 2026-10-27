import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from './encryption'
import { sendInteractiveButtons, sendTemplateMessage, sendTextMessage } from './meta-api'
import { toInternational } from './phone-utils'
import { loadBusinessSettings, type BusinessSettings } from '../business/settings'

/**
 * Internal ops notification sent to the business's own staff numbers
 * whenever a flow hands a conversation off to a human — the only
 * signal today is the conversation flipping to `status: 'pending'` in
 * the inbox, which nobody sees unless WACRM happens to be open. Staff
 * numbers are plain phone numbers, not `contacts` rows, so this can't
 * reuse the flows/automations senders (they all require an existing
 * contact + conversation to attach the outbound message to).
 *
 * Only staff with an open 24h customer-service window are messaged —
 * they "clock in" by writing *turno* to the bot each day (see the flows
 * engine's staff check-in). Inside that window a plain text message is
 * free and needs no Meta payment method, so that's what goes out by
 * default (found live: Meta rejects EVERY template with 131042 when the
 * account has no payment method, even inside the window). Set
 * ORDER_NOTIFICATION_MODE=template to send the `aviso_pedido_nuevo`
 * template instead (needs a payment method on the WhatsApp account).
 *
 * Best-effort by design: a failed staff notification must never break
 * the handoff itself. Callers should fire this and swallow/log errors
 * — the return value exists so a caller CAN record per-phone outcomes
 * somewhere inspectable (e.g. flow_run_events) instead of only a
 * server console log nobody's watching; a newline-in-parameter bug
 * here once went unnoticed across several live tests for exactly that
 * reason.
 */

/**
 * Meta rejects a template parameter outright (error 132018) if it
 * contains a newline/tab or 4+ consecutive spaces — found live: every
 * real handoff note is multi-line (order items, one per line, plus
 * billing/location), so every notification was silently failing until
 * this was caught. " · " keeps the structure legible on one line
 * instead of just collapsing to spaces.
 */
export function sanitizeForTemplateParam(text: string): string {
  return text
    .replace(/[\n\t]+/g, ' · ')
    .replace(/ {4,}/g, '   ')
    .trim()
}

export interface StaffMember {
  /** What's written next to the number ("Diego", "Caja 2"), or "". */
  name: string
  /** International digits. */
  phone: string
}

/**
 * One line of the staff list: "Diego 0981414182", "0981414182 - Caja",
 * or just the number. Local numbers ("0981…") are accepted — staff
 * lists get typed the way people say them.
 */
export function parseStaffLine(line: string, countryCode: string): StaffMember | null {
  const m = line.match(/\+?\d[\d\s-]{5,}\d/)
  if (!m) return null
  // "Caja 2 0998999384": the number is the shortest run of groups, from
  // the right, with at least 9 digits — the "2" belongs to the name.
  const groups = m[0].split(/[\s-]+/)
  let number = m[0]
  for (let i = groups.length - 1; i >= 0; i--) {
    const candidate = groups.slice(i).join(' ')
    if (candidate.replace(/\D/g, '').length >= 9) {
      number = candidate
      break
    }
  }
  const phone = toInternational(number, countryCode)
  if (!phone) return null
  const name = line
    .replace(number, ' ')
    // A country code left in front of the number ("+593 96 949 6301").
    .replace(new RegExp(`\\+${countryCode}\\b|\\b${countryCode}(?=\\s*$)`), ' ')
    .replace(/[-–:·|,()+]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return { name, phone }
}

/**
 * The staff list: the business settings' lines, or (older deployments)
 * ORDER_NOTIFICATION_PHONES. One entry per number.
 */
export function getStaffList(biz: BusinessSettings): StaffMember[] {
  const configured = biz.staffPhones.length
    ? biz.staffPhones
    : (process.env.ORDER_NOTIFICATION_PHONES ?? '').split(',')
  const seen = new Set<string>()
  const out: StaffMember[] = []
  for (const line of configured) {
    const member = parseStaffLine(line.trim(), biz.phoneCountryCode)
    if (member && !seen.has(member.phone)) {
      seen.add(member.phone)
      out.push(member)
    }
  }
  return out
}

/** Staff numbers as international digits (see getStaffList). */
export function getStaffPhones(biz: BusinessSettings): string[] {
  return getStaffList(biz).map((s) => s.phone)
}

const WINDOW_MS = 24 * 3_600_000

/** When this phone last wrote to the bot (any time), or null if never. */
export async function lastInboundAt(
  db: SupabaseClient,
  accountId: string,
  phone: string,
): Promise<Date | null> {
  const { data: contacts } = await db
    .from('contacts')
    .select('id')
    .eq('account_id', accountId)
    .in('phone', [phone, `+${phone}`])
  const contactIds = ((contacts ?? []) as { id: string }[]).map((c) => c.id)
  if (contactIds.length === 0) return null
  const { data: convs } = await db
    .from('conversations')
    .select('id')
    .in('contact_id', contactIds)
  const convIds = ((convs ?? []) as { id: string }[]).map((c) => c.id)
  if (convIds.length === 0) return null
  const { data: msg } = await db
    .from('messages')
    .select('created_at')
    .in('conversation_id', convIds)
    .eq('sender_type', 'customer')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  const createdAt = (msg as { created_at?: string } | null)?.created_at
  return createdAt ? new Date(createdAt) : null
}

/**
 * When this phone last wrote to the bot, if within the last 24h (its
 * WhatsApp customer-service window is open); null otherwise.
 */
export async function lastInboundWithinWindow(
  db: SupabaseClient,
  accountId: string,
  phone: string,
): Promise<Date | null> {
  const last = await lastInboundAt(db, accountId, phone)
  return last && Date.now() - last.getTime() < WINDOW_MS ? last : null
}

export interface StaffShift extends StaffMember {
  /** Last message to the bot, ISO, or null (never wrote). */
  lastInbound: string | null
  /** When the free 24h window closes, ISO, or null when it's closed. */
  activeUntil: string | null
}

/** Each staff member and whether their alerts window is open (see lastInboundWithinWindow). */
export async function staffShifts(db: SupabaseClient, accountId: string): Promise<StaffShift[]> {
  const biz = await loadBusinessSettings(db, accountId)
  return Promise.all(
    getStaffList(biz).map(async (member) => {
      const last = await lastInboundAt(db, accountId, member.phone).catch(() => null)
      const until = last ? last.getTime() + WINDOW_MS : 0
      return {
        ...member,
        lastInbound: last ? last.toISOString() : null,
        activeUntil: until > Date.now() ? new Date(until).toISOString() : null,
      }
    }),
  )
}

/** Reminded / reported windows, by phone → the last message that opened it. In-memory. */
const shiftReminded = new Map<string, string>()
const shiftExpiredReported = new Map<string, string>()
/** How long before the window closes the staff member is reminded (free while it's open). */
const SHIFT_REMINDER_MS = 45 * 60_000

/**
 * For the cron: remind each staff member whose window closes within 45
 * minutes (a WhatsApp message they can renew with one tap — free, the
 * window is still open), and report to the admins the ones whose window
 * just closed (they won't get order alerts until they write *turno*).
 */
export async function sweepStaffShifts(
  db: SupabaseClient,
  accountId: string,
  reportExpired: (member: StaffShift) => Promise<void>,
): Promise<{ reminded: number; expired: number }> {
  const shifts = await staffShifts(db, accountId)
  if (!shifts.length) return { reminded: 0, expired: 0 }
  let reminded = 0
  let expired = 0
  const now = Date.now()
  const due = shifts.filter(
    (s) => s.activeUntil && new Date(s.activeUntil).getTime() - now < SHIFT_REMINDER_MS && shiftReminded.get(s.phone) !== s.lastInbound,
  )
  if (due.length) {
    const { data: config } = await db
      .from('whatsapp_config')
      .select('phone_number_id, access_token')
      .eq('account_id', accountId)
      .maybeSingle()
    if (config) {
      const accessToken = decrypt((config as { access_token: string }).access_token)
      const biz = await loadBusinessSettings(db, accountId)
      for (const s of due) {
        const at = new Date(s.activeUntil!).getTime() + biz.utcOffsetHours * 3_600_000
        const hhmm = new Date(at).toISOString().slice(11, 16)
        try {
          await sendInteractiveButtons({
            phoneNumberId: (config as { phone_number_id: string }).phone_number_id,
            accessToken,
            to: s.phone,
            bodyText: `⏰ ${s.name ? `${s.name}, s` : 'S'}u turno de avisos de pedidos vence a las ${hhmm}. Toque *Recibido* (o escriba *turno*) para seguir recibiéndolos 24 h más 🙂`,
            buttons: ACK_BUTTON,
          })
          shiftReminded.set(s.phone, s.lastInbound!)
          reminded++
        } catch (err) {
          console.error('[staff-notify] shift reminder failed for', s.phone, err instanceof Error ? err.message : err)
        }
      }
    }
  }
  for (const s of shifts) {
    if (s.activeUntil || !s.lastInbound) continue
    // Closed within the last 2 hours, not reported yet.
    const closedAt = new Date(s.lastInbound).getTime() + WINDOW_MS
    if (now - closedAt > 2 * 3_600_000 || shiftExpiredReported.get(s.phone) === s.lastInbound) continue
    shiftExpiredReported.set(s.phone, s.lastInbound)
    await reportExpired(s).catch(() => null)
    expired++
  }
  return { reminded, expired }
}

/** Reply id of the "✅ Recibido" button on staff alerts — tapping it renews that person's 24h window. */
export const STAFF_ACK_ID = 'staff_ack'
const ACK_BUTTON = [{ id: STAFF_ACK_ID, title: '✅ Recibido' }]
// Meta's limit for an interactive message's body.
const BUTTON_BODY_MAX = 1024

/** The plain-text staff alert: who, what (multi-line is fine here), and a link to the chat. */
export function staffAlertText(args: { contactName: string; summary: string; link?: string | null }): string {
  const lines = [
    `🔔 *Aviso para el personal*${args.contactName.trim() ? ` — ${args.contactName.trim()}` : ''}`,
    '',
    args.summary.trim() || '(sin detalle)',
  ]
  if (args.link) lines.push('', `👉 Abrir en el CRM: ${args.link}`)
  // WhatsApp's text limit is 4096 characters.
  return lines.join('\n').slice(0, 4000)
}

export interface NotifyStaffResult {
  sent: { phone: string; messageId: string }[]
  failed: { phone: string; error: string }[]
  /** Configured numbers not messaged: no *turno* in the last 24h. */
  skipped: string[]
}

export async function notifyStaffOfHandoff(
  db: SupabaseClient,
  args: {
    accountId: string
    contactName: string
    /** Resolved (vars already interpolated) summary of what the
     *  customer asked for — shown as the template's second variable. */
    summary: string
    /** The conversation, for an "open in the CRM" link in the text alert. */
    conversationId?: string | null
  },
): Promise<NotifyStaffResult> {
  const biz = await loadBusinessSettings(db, args.accountId)
  const phones = getStaffPhones(biz)
  if (phones.length === 0) return { sent: [], failed: [], skipped: [] }
  const asTemplate = process.env.ORDER_NOTIFICATION_MODE === 'template' && biz.allowPaidTemplates

  const templateName = process.env.ORDER_NOTIFICATION_TEMPLATE ?? 'aviso_pedido_nuevo'
  const templateLanguage = process.env.ORDER_NOTIFICATION_TEMPLATE_LANG ?? 'es'

  const { data: config, error: configError } = await db
    .from('whatsapp_config')
    .select('phone_number_id, access_token')
    .eq('account_id', args.accountId)
    .single()
  if (configError || !config) {
    console.error('[staff-notify] no whatsapp_config for account, skipping', args.accountId)
    return {
      sent: [],
      failed: phones.map((phone) => ({ phone, error: 'no whatsapp_config for account' })),
      skipped: [],
    }
  }

  // Outside the 24h window Meta would reject (and, with a payment
  // method, charge for) the template — only message staff on shift.
  const onShift: string[] = []
  const skipped: string[] = []
  await Promise.all(
    phones.map(async (phone) => {
      const last = await lastInboundWithinWindow(db, args.accountId, phone).catch(() => null)
      if (last) onShift.push(phone)
      else skipped.push(phone)
    }),
  )

  const accessToken = decrypt(config.access_token)
  // Meta also caps a template body variable's length; a very long
  // running order shouldn't blow past that and fail every send.
  const summary = sanitizeForTemplateParam(args.summary).slice(0, 900) || '(sin detalle)'

  const text = staffAlertText({
    contactName: args.contactName,
    summary: args.summary,
    link: args.conversationId && biz.publicAppUrl ? `${biz.publicAppUrl}/inbox?c=${args.conversationId}` : null,
  })

  const sent: { phone: string; messageId: string }[] = []
  const failed: { phone: string; error: string }[] = []
  await Promise.all(
    onShift.map(async (phone) => {
      try {
        const { messageId } = asTemplate
          ? await sendTemplateMessage({
              phoneNumberId: config.phone_number_id,
              accessToken,
              to: phone,
              templateName,
              language: templateLanguage,
              params: [sanitizeForTemplateParam(args.contactName) || 'Cliente', summary],
            })
          : await sendAlertWithAck(config.phone_number_id, accessToken, phone, text)
        sent.push({ phone, messageId })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error(`[staff-notify] failed to notify ${phone}:`, message)
        failed.push({ phone, error: message })
      }
    }),
  )
  return { sent, failed, skipped }
}

/**
 * The alert with a "✅ Recibido" button (one message when it fits the
 * button body limit, otherwise the text and then a short button message).
 * A tap counts as the staff member writing to the bot, so it renews
 * their free 24h window without typing *turno* again.
 */
async function sendAlertWithAck(
  phoneNumberId: string,
  accessToken: string,
  to: string,
  text: string,
): Promise<{ messageId: string }> {
  if (text.length <= BUTTON_BODY_MAX) {
    return sendInteractiveButtons({ phoneNumberId, accessToken, to, bodyText: text, buttons: ACK_BUTTON })
  }
  const first = await sendTextMessage({ phoneNumberId, accessToken, to, text })
  await sendInteractiveButtons({
    phoneNumberId,
    accessToken,
    to,
    bodyText: 'Toque *Recibido* cuando lo vea 🙂 (así sus avisos siguen activos).',
    buttons: ACK_BUTTON,
  }).catch((err) => console.error('[staff-notify] ack button failed:', err instanceof Error ? err.message : err))
  return first
}
