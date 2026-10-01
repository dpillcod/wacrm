import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from './encryption'
import { sendTemplateMessage } from './meta-api'
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
 * It goes out as a template (`aviso_pedido_nuevo` by default). A
 * template is free only inside a staff member's 24h customer-service
 * window — i.e. if they wrote to the bot in the last 24h. The store
 * runs without a Meta payment method, so outside that window Meta
 * rejects it (131042). Staff therefore "clock in" by writing *turno*
 * to the bot each day (see the flows engine's staff check-in), and
 * only numbers with an open window are messaged at all.
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

/**
 * Staff numbers as international digits: the business settings' list,
 * or (older deployments) ORDER_NOTIFICATION_PHONES. Local numbers
 * ("0981…") are accepted — staff lists get typed the way people say them.
 */
export function getStaffPhones(biz: BusinessSettings): string[] {
  const configured = biz.staffPhones.length
    ? biz.staffPhones
    : (process.env.ORDER_NOTIFICATION_PHONES ?? '').split(',')
  return configured
    .map((p) => toInternational(p.trim(), biz.phoneCountryCode))
    .filter(Boolean)
}

const WINDOW_MS = 24 * 3_600_000

/**
 * When this phone last wrote to the bot, if within the last 24h (its
 * WhatsApp customer-service window is open); null otherwise.
 */
export async function lastInboundWithinWindow(
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
    .gte('created_at', new Date(Date.now() - WINDOW_MS).toISOString())
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  const createdAt = (msg as { created_at?: string } | null)?.created_at
  return createdAt ? new Date(createdAt) : null
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
  },
): Promise<NotifyStaffResult> {
  const phones = getStaffPhones(await loadBusinessSettings(db, args.accountId))
  if (phones.length === 0) return { sent: [], failed: [], skipped: [] }

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

  const sent: { phone: string; messageId: string }[] = []
  const failed: { phone: string; error: string }[] = []
  await Promise.all(
    onShift.map(async (phone) => {
      try {
        const { messageId } = await sendTemplateMessage({
          phoneNumberId: config.phone_number_id,
          accessToken,
          to: phone,
          templateName,
          language: templateLanguage,
          params: [sanitizeForTemplateParam(args.contactName) || 'Cliente', summary],
        })
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
