// ============================================================
// Advertising links: a wa.me link per ad (a WhatsApp Status, a Facebook
// post, a printed flyer…) whose pre-written message ends in "#CODE".
// When a customer writes with that code, the contact gets the tag
// "Origen: <channel> · <name>" and a note, so the store sees which ad
// brings conversations and orders. The code is taken out of the text
// the bot reads, so the conversation flows as if typed by hand.
//
// Pure helpers — the links live in the business settings (adLinks).
// ============================================================

export interface AdLink {
  /** 2–20 letters/digits, upper case: "TORTAS". */
  code: string
  /** What the ad is about: "Tortas de cumpleaños". */
  name: string
  /** Where it's published: "Estado de WhatsApp", "Facebook"… */
  channel: string
  /** The message the customer's WhatsApp opens with (without the code). */
  message: string
  createdAt: string
}

export const AD_CHANNELS = [
  'Estado de WhatsApp',
  'Facebook',
  'Instagram',
  'TikTok',
  'Volante impreso',
  'Otro',
] as const

const MAX_LINKS = 100

/** "tortas 2025!" → "TORTAS2025"; '' when too short. */
export function normalizeAdCode(raw: string): string {
  const code = raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 20)
  return code.length >= 2 ? code : ''
}

/** The link to publish: opens WhatsApp with the message and the code. */
export function adLinkUrl(whatsappNumber: string, link: Pick<AdLink, 'code' | 'message'>): string {
  const text = `${link.message.trim()} #${link.code}`.trim()
  return `https://wa.me/${whatsappNumber.replace(/\D/g, '')}?text=${encodeURIComponent(text)}`
}

const CODE_RE = /#([A-Za-z0-9]{2,20})\b/g

/** The ad a customer's message came from, by its "#CODE". */
export function findAdLink(text: string, links: AdLink[]): AdLink | null {
  if (!text || links.length === 0) return null
  for (const m of text.matchAll(CODE_RE)) {
    const code = m[1].toUpperCase()
    const link = links.find((l) => l.code === code)
    if (link) return link
  }
  return null
}

/** The message without the ad's code, as the bot should read it. */
export function stripAdCode(text: string, link: AdLink): string {
  return text
    .replace(new RegExp(`\\s*#${link.code}\\b`, 'gi'), '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

export function adOriginTag(link: Pick<AdLink, 'channel' | 'name'>): string {
  return `Origen: ${link.channel} · ${link.name}`
}

export function adOriginNote(link: AdLink): string {
  return `📣 Escribió desde la publicidad «${link.name}» (${link.channel}, código #${link.code}).`
}

/** Links as the app can trust them: well-formed, unique codes, newest kept. */
export function sanitizeAdLinks(value: unknown): AdLink[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: AdLink[] = []
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue
    const r = raw as Record<string, unknown>
    const code = normalizeAdCode(typeof r.code === 'string' ? r.code : '')
    const name = typeof r.name === 'string' ? r.name.trim().slice(0, 80) : ''
    if (!code || !name || seen.has(code)) continue
    seen.add(code)
    out.push({
      code,
      name,
      channel: typeof r.channel === 'string' && r.channel.trim() ? r.channel.trim().slice(0, 40) : 'Otro',
      message: typeof r.message === 'string' ? r.message.trim().slice(0, 300) : '',
      createdAt: typeof r.createdAt === 'string' ? r.createdAt : new Date(0).toISOString(),
    })
    if (out.length >= MAX_LINKS) break
  }
  return out
}
