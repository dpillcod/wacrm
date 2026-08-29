import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from './encryption'
import { sendTemplateMessage } from './meta-api'
import { sanitizePhoneForMeta } from './phone-utils'

/**
 * Internal ops notification sent to the business's own staff numbers
 * whenever a flow hands a conversation off to a human — the only
 * signal today is the conversation flipping to `status: 'pending'` in
 * the inbox, which nobody sees unless WACRM happens to be open. Staff
 * numbers are plain phone numbers, not `contacts` rows, so this can't
 * reuse the flows/automations senders (they all require an existing
 * contact + conversation to attach the outbound message to).
 *
 * Meta requires an approved template outside the 24h customer-service
 * window, and staff won't be in an active session with the bot number
 * — so this always sends via `aviso_pedido_nuevo` (or whichever
 * template name is configured), never a free-form text.
 *
 * Best-effort by design: a failed staff notification must never break
 * the handoff itself. Callers should fire this and swallow/log errors
 * — the return value exists so a caller CAN record per-phone failures
 * somewhere inspectable (e.g. flow_run_events) instead of only a
 * server console log nobody's watching; a newline-in-parameter bug
 * here once went unnoticed across several live tests for exactly that
 * reason.
 */
export interface NotifyStaffResult {
  sent: string[]
  failed: { phone: string; error: string }[]
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
  const phones = (process.env.ORDER_NOTIFICATION_PHONES ?? '')
    .split(',')
    .map((p) => sanitizePhoneForMeta(p.trim()))
    .filter(Boolean)
  if (phones.length === 0) return { sent: [], failed: [] }

  const templateName = process.env.ORDER_NOTIFICATION_TEMPLATE ?? 'aviso_pedido_nuevo'
  const templateLanguage = process.env.ORDER_NOTIFICATION_TEMPLATE_LANG ?? 'es'

  const { data: config, error: configError } = await db
    .from('whatsapp_config')
    .select('phone_number_id, access_token')
    .eq('account_id', args.accountId)
    .single()
  if (configError || !config) {
    console.error('[staff-notify] no whatsapp_config for account, skipping', args.accountId)
    return { sent: [], failed: phones.map((phone) => ({ phone, error: 'no whatsapp_config for account' })) }
  }

  const accessToken = decrypt(config.access_token)
  // Meta rejects a template parameter outright (error 132018) if it
  // contains a newline/tab or 4+ consecutive spaces — found live: every
  // real handoff note is multi-line (order items, one per line, plus
  // billing/location), so every notification was silently failing
  // until this was caught. " · " keeps the structure legible on one
  // line instead of just collapsing to spaces.
  const sanitizeForTemplateParam = (text: string): string =>
    text
      .replace(/[\n\t]+/g, ' · ')
      .replace(/ {4,}/g, '   ')
      .trim()
  // Meta also caps a template body variable's length; a very long
  // running order shouldn't blow past that and fail every send.
  const summary = sanitizeForTemplateParam(args.summary).slice(0, 900) || '(sin detalle)'

  const sent: string[] = []
  const failed: { phone: string; error: string }[] = []
  await Promise.all(
    phones.map(async (phone) => {
      try {
        await sendTemplateMessage({
          phoneNumberId: config.phone_number_id,
          accessToken,
          to: phone,
          templateName,
          language: templateLanguage,
          params: [sanitizeForTemplateParam(args.contactName) || 'Cliente', summary],
        })
        sent.push(phone)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error(`[staff-notify] failed to notify ${phone}:`, message)
        failed.push({ phone, error: message })
      }
    }),
  )
  return { sent, failed }
}
