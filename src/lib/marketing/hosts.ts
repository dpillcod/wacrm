import type { SupabaseClient } from '@supabase/supabase-js'
import type { BusinessSettings } from '@/lib/business/settings'
import { renderText } from '@/lib/business/settings'
import { money } from '@/lib/catalog/order-lines'
import type { AdLink } from './ad-links'

// ============================================================
// Partner program for Airbnb hosts. Each host is an advertising link
// with `host` set: its QR (left in the apartment) opens /r/<account>/<code>,
// which counts the scan and opens WhatsApp with "#CODE". The guest who
// writes with it is remembered in ad_link_contacts (migration 051) and
// gets the program's discount while the stay lasts — the order card and
// the staff alert say so, the team applies it when charging.
// ============================================================

/** Path of a host's QR: counts the scan, then opens WhatsApp. */
export function hostScanPath(accountId: string, code: string): string {
  return `/r/${accountId}/${code}`
}

export function hostDefaultMessage(lodging: string): string {
  return `Hola 👋 me hospedo en ${lodging.trim()} 🏠`
}

const pct = (n: number) => `${Number.isInteger(n) ? n : n.toFixed(1).replace('.', ',')} %`

function programValues(biz: BusinessSettings, link: AdLink): Record<string, string> {
  const p = biz.hostProgram
  return {
    anfitrion: link.name,
    alojamiento: link.host?.lodging || link.name,
    descuento: pct(p.discountPct),
    envio: p.freeDeliveryFrom > 0 ? ` y *envío gratis* desde ${money(p.freeDeliveryFrom)}` : '',
    dias: String(p.validDays),
    negocio: biz.name || 'nuestra tienda',
  }
}

/** Sent to a guest the first time they write through the host's QR; null when the program offers nothing. */
export function hostWelcomeText(biz: BusinessSettings, link: AdLink): string | null {
  const p = biz.hostProgram
  if (!link.host || (p.discountPct <= 0 && p.freeDeliveryFrom <= 0) || !p.welcomeText.trim()) return null
  return renderText(p.welcomeText, programValues(biz, link)).trim()
}

/** The line added to the guest's order card and staff alert: what to apply when charging. */
export function hostGuestLine(biz: BusinessSettings, link: AdLink): string {
  const p = biz.hostProgram
  const lodging = link.host?.lodging && link.host.lodging !== link.name ? ` (${link.host.lodging})` : ''
  const parts = [`🏠 Huésped de ${link.name}${lodging}`]
  if (p.discountPct > 0) parts.push(`${pct(p.discountPct)} de descuento`)
  if (p.freeDeliveryFrom > 0) parts.push(`envío gratis desde ${money(p.freeDeliveryFrom)}`)
  return parts.join(' · ')
}

/** Monthly summary to copy and send to the host. */
export function hostSummaryText(
  link: AdLink,
  stats: { month: string; guests: number; orders: number; sales: number },
): string {
  const lines = [
    `Hola ${link.name} 👋`,
    `Resumen de ${stats.month}:`,
    `• ${stats.guests} huésped(es) nos escribieron desde su QR`,
    `• ${stats.orders} pedido(s) por ${money(stats.sales)}`,
  ]
  if (link.host?.reward) lines.push(`• Su premio: ${link.host.reward}`)
  lines.push('', '¡Gracias por recomendarnos! 🙌')
  return lines.join('\n')
}

// Longest prefix wins ("593" before "5…"). The usual visitors; the rest → "Otro".
const COUNTRY_PREFIXES: [string, string][] = [
  ['593', 'Ecuador'], ['591', 'Bolivia'], ['595', 'Paraguay'], ['598', 'Uruguay'],
  ['506', 'Costa Rica'], ['507', 'Panamá'], ['502', 'Guatemala'], ['503', 'El Salvador'],
  ['1', 'EE. UU. / Canadá'], ['57', 'Colombia'], ['51', 'Perú'], ['56', 'Chile'],
  ['54', 'Argentina'], ['52', 'México'], ['55', 'Brasil'], ['58', 'Venezuela'],
  ['34', 'España'], ['33', 'Francia'], ['49', 'Alemania'], ['44', 'Reino Unido'],
  ['39', 'Italia'], ['31', 'Países Bajos'], ['41', 'Suiza'], ['32', 'Bélgica'],
  ['43', 'Austria'], ['351', 'Portugal'], ['61', 'Australia'], ['64', 'Nueva Zelanda'],
  ['7', 'Rusia'], ['86', 'China'], ['81', 'Japón'], ['82', 'Corea del Sur'], ['972', 'Israel'],
]

/** Country of an international phone number (digits), by its calling code. */
export function countryOfPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '')
  let best: [string, string] | null = null
  for (const entry of COUNTRY_PREFIXES) {
    if (digits.startsWith(entry[0]) && (!best || entry[0].length > best[0].length)) best = entry
  }
  return best ? best[1] : 'Otro'
}

/** Link previews and crawlers fetch the QR's URL too; they aren't scans. */
export function isBotUserAgent(ua: string | null): boolean {
  if (!ua) return true
  return /bot|crawl|spider|preview|facebookexternalhit|whatsapp|slack|telegram|discord|curl|wget/i.test(ua)
}

// ------------------------------------------------------------
// Server side (service-role client). Best-effort: a hiccup here never
// blocks a customer's message.
// ------------------------------------------------------------

/** Remember the customer wrote through this link; true the first time. */
export async function rememberAdContact(
  db: SupabaseClient,
  args: { accountId: string; code: string; contactId: string },
): Promise<boolean> {
  const now = new Date().toISOString()
  const { data: existing } = await db
    .from('ad_link_contacts')
    .select('contact_id')
    .eq('account_id', args.accountId)
    .eq('code', args.code)
    .eq('contact_id', args.contactId)
    .maybeSingle()
  if (existing) {
    await db
      .from('ad_link_contacts')
      .update({ last_seen_at: now })
      .eq('account_id', args.accountId)
      .eq('code', args.code)
      .eq('contact_id', args.contactId)
    return false
  }
  const { error } = await db.from('ad_link_contacts').insert({
    account_id: args.accountId,
    code: args.code,
    contact_id: args.contactId,
    first_seen_at: now,
    last_seen_at: now,
  })
  if (error) {
    console.error('[hosts] remember contact failed:', error.message)
    return false
  }
  return true
}

/** The host whose guest this customer is, while the discount still applies. */
export async function activeHostFor(
  db: SupabaseClient,
  biz: BusinessSettings,
  args: { accountId: string; contactId: string },
): Promise<AdLink | null> {
  const hosts = biz.adLinks.filter((l) => l.host)
  if (hosts.length === 0) return null
  const since = new Date(Date.now() - biz.hostProgram.validDays * 86_400_000).toISOString()
  const { data } = await db
    .from('ad_link_contacts')
    .select('code')
    .eq('account_id', args.accountId)
    .eq('contact_id', args.contactId)
    .in('code', hosts.map((h) => h.code))
    .gte('last_seen_at', since)
    .order('last_seen_at', { ascending: false })
    .limit(1)
  const code = ((data ?? []) as { code: string }[])[0]?.code
  return code ? (hosts.find((h) => h.code === code) ?? null) : null
}
