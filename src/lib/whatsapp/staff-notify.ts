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
 * the handoff itself. Callers should fire this and swallow errors.
 */
export async function notifyStaffOfHandoff(
  db: SupabaseClient,
  args: {
    accountId: string
    contactName: string
    /** Resolved (vars already interpolated) summary of what the
     *  customer asked for — shown as the template's second variable. */
    summary: string
  },
): Promise<void> {
  const phones = (process.env.ORDER_NOTIFICATION_PHONES ?? '')
    .split(',')
    .map((p) => sanitizePhoneForMeta(p.trim()))
    .filter(Boolean)
  if (phones.length === 0) return

  const templateName = process.env.ORDER_NOTIFICATION_TEMPLATE ?? 'aviso_pedido_nuevo'
  const templateLanguage = process.env.ORDER_NOTIFICATION_TEMPLATE_LANG ?? 'es'

  const { data: config, error: configError } = await db
    .from('whatsapp_config')
    .select('phone_number_id, access_token')
    .eq('account_id', args.accountId)
    .single()
  if (configError || !config) {
    console.error('[staff-notify] no whatsapp_config for account, skipping', args.accountId)
    return
  }

  const accessToken = decrypt(config.access_token)
  // Meta caps a template body variable's length; a very long running
  // order shouldn't blow past that and fail every send.
  const summary = args.summary.slice(0, 900) || '(sin detalle)'

  await Promise.all(
    phones.map(async (phone) => {
      try {
        await sendTemplateMessage({
          phoneNumberId: config.phone_number_id,
          accessToken,
          to: phone,
          templateName,
          language: templateLanguage,
          params: [args.contactName || 'Cliente', summary],
        })
      } catch (err) {
        console.error(`[staff-notify] failed to notify ${phone}:`, err)
      }
    }),
  )
}
