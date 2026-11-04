/**
 * Menu promotions (Settings → My business): one line each, shown at the
 * top of the bot's menu ({{vars.promo}}) and handed to the AI so it can
 * mention the campaign — until the last day it applies. Written one per
 * line, the last day first when there is one:
 *
 *   2026-11-09 | 🎄 *Canastas navideñas*: preventa 5 % hasta el 9/11 👉 …
 *   2026-12-24 | 🎄 *Canastas navideñas y pavos* 👉 …
 *
 * The first line still in date wins, so a campaign can change its text
 * on a given day without anyone editing the menu.
 */

import type { SeasonalReply } from './seasonal-replies'

export interface MenuPromo {
  text: string
  /** Last day it applies (YYYY-MM-DD, the business's local date); '' = no end. */
  until: string
}

const MAX_PROMOS = 10

export function sanitizeMenuPromos(value: unknown): MenuPromo[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object' && !Array.isArray(p))
    .map((p) => ({
      text: typeof p.text === 'string' ? p.text.trim().slice(0, 300) : '',
      until: typeof p.until === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.until.trim()) ? p.until.trim() : '',
    }))
    .filter((p) => p.text)
    .slice(0, MAX_PROMOS)
}

export function menuPromosToText(promos: MenuPromo[]): string {
  return promos.map((p) => (p.until ? `${p.until} | ${p.text}` : p.text)).join('\n')
}

export function menuPromosFromText(text: string): MenuPromo[] {
  return sanitizeMenuPromos(
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const m = /^(\d{4}-\d{2}-\d{2})\s*\|\s*(.*)$/.exec(line)
        return m ? { until: m[1], text: m[2] } : { until: '', text: line }
      }),
  )
}

/** The promotion for today ('' when none applies). */
export function activeMenuPromo(promos: MenuPromo[], today: string): string {
  return promos.find((p) => !p.until || p.until >= today)?.text ?? ''
}

/**
 * The campaigns running today, for an AI prompt: the menu promotion and
 * the seasonal replies still in date ('' when there are none).
 */
export function campaignsForAi(promos: MenuPromo[] = [], seasonal: SeasonalReply[] = [], today: string): string {
  const promo = activeMenuPromo(promos, today)
  const seen = new Set<string>()
  const replies = seasonal
    .filter((r) => !r.until || r.until >= today)
    // Two rules on the same words (preventa → general): only the first counts.
    .filter((r) => {
      const key = r.keywords[0]
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .map((r) => `- Si preguntan por ${r.keywords.slice(0, 3).join(', ')}: ${r.reply.replace(/\s*\n+\s*/g, ' ')}`)
  if (!promo && replies.length === 0) return ''
  return [
    'Campañas vigentes. Si es el primer mensaje del cliente o pregunta algo general, al final menciona en UNA frase corta la promoción con su enlace (una sola vez por conversación). No inventes otras promociones ni descuentos:',
    promo ? `- Promoción: ${promo}` : '',
    ...replies,
  ]
    .filter(Boolean)
    .join('\n')
}
