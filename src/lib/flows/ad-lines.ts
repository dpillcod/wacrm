// ============================================================
// Campaign lines (Mi negocio → adLines): a customer who comes from a
// "click to WhatsApp" ad, or whose first message names the line ("hola,
// quiero ver juguetes"), gets that line's answer — a question that helps
// choose, the line's pictures from the media library, the catalog button —
// and a person is asked to help. The contact is tagged "Línea: <key>" so
// the metrics can count chats per line.
// Also: the request a web store form sends ("Hola, pedí un técnico en la
// web (SW-0007)" + a summary), parsed here.
// Pure — no I/O.
// ============================================================

// Same folding as store-policy's normalizeForMatch (kept here: settings
// imports this file, and store-policy imports settings).
function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9ñ\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export interface AdLine {
  /** Short key, also the tag: "juguetes" → "Línea: juguetes". */
  key: string
  /** Words that mark the line in the ad's text or the first message. */
  words: string[]
  /** Words that rule the line out ("torta de cumpleaños" is the bakery, not the party line). */
  notWords: string[]
  /** Answer; {nombre} = " Juan" or "". */
  reply: string
  /** Media library tag of the pictures to send (up to 3). '' = none. */
  photoTag: string
  /** Ask a person to help choose (alert + the chat waits for them). */
  toPerson: boolean
}

export const LINE_TAG_PREFIX = 'Línea: '

export function lineTag(key: string): string {
  return `${LINE_TAG_PREFIX}${key}`
}

export function sanitizeAdLines(input: unknown): AdLine[] {
  if (!Array.isArray(input)) return []
  const out: AdLine[] = []
  for (const raw of input.slice(0, 20)) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const key = normalizeForMatch(String(r.key ?? '')).replace(/\s+/g, '-').slice(0, 30)
    const words = (Array.isArray(r.words) ? r.words : [])
      .map((w) => normalizeForMatch(String(w)).trim())
      .filter((w) => w.length >= 3)
      .slice(0, 40)
    const notWords = (Array.isArray(r.notWords) ? r.notWords : [])
      .map((w) => normalizeForMatch(String(w)).trim())
      .filter((w) => w.length >= 3)
      .slice(0, 40)
    const reply = typeof r.reply === 'string' ? r.reply.slice(0, 900) : ''
    if (!key || words.length === 0 || !reply.trim() || out.some((l) => l.key === key)) continue
    out.push({
      key,
      words,
      notWords,
      reply,
      photoTag: typeof r.photoTag === 'string' ? r.photoTag.trim().toLowerCase().slice(0, 40) : '',
      toPerson: r.toPerson !== false,
    })
  }
  return out
}

/**
 * The line a first message (and the ad it came from, if any) belongs to.
 * A long message that lists products is an order, not a campaign hello.
 */
export function adLineOf(
  lines: AdLine[],
  text: string,
  referral?: { headline?: string; body?: string } | null,
): AdLine | null {
  if (lines.length === 0) return null
  const own = normalizeForMatch(text)
  const fromAd = referral ? normalizeForMatch(`${referral.headline ?? ''} ${referral.body ?? ''}`) : ''
  if (!fromAd && own.split(' ').length > 14) return null
  const has = (hay: string, w: string) => ` ${hay} `.includes(` ${w} `)
  for (const hay of [fromAd, own]) {
    if (!hay.trim()) continue
    const hit = lines.find((l) => l.words.some((w) => has(hay, w)) && !l.notWords.some((w) => has(own, w)))
    if (hit) return hit
  }
  return null
}

export interface WebServiceRequest {
  code: string
  service: string
  job: string
  name: string
  sector: string
  when: string
  detail: string
}

/**
 * "Hola, pedí un técnico en la web (SW-0007)\nServicio: Plomería — Fuga\n
 * Nombre: …\nSector: …\nDía: 20/11/2026, mañana\nDetalle: …".
 */
export function parseWebServiceRequest(text: string): WebServiceRequest | null {
  const head = /ped[ií] un t[eé]cnico en la web\s*\(([A-Za-z]{1,3}-?\d{1,6})\)/i.exec(text)
  if (!head) return null
  const field = (label: string) => {
    const m = new RegExp(`^\\s*${label}\\s*:\\s*(.+)$`, 'im').exec(text)
    return m ? m[1].trim() : ''
  }
  const servicio = field('Servicio')
  const [service, ...jobParts] = servicio.split(/\s+[—–-]\s+/)
  return {
    code: head[1].toUpperCase(),
    service: (service ?? '').trim(),
    job: jobParts.join(' — ').trim(),
    name: field('Nombre'),
    sector: field('Sector'),
    when: field('D[ií]a') || field('Hora'),
    detail: field('Detalle'),
  }
}
