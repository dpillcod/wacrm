/**
 * Seasonal replies (Settings → My business): when a customer mentions a
 * campaign word ("canasta", "pavo"), the bot answers with the campaign's
 * text — until the date it stops applying. Written in the settings as
 * blocks separated by a "---" line, the first line being the words and,
 * after a "|", the last day (YYYY-MM-DD) it applies:
 *
 *   canasta, canastas | 2026-11-09
 *   🎄 Tenemos 4 canastas navideñas…
 *   ---
 *   pavo, pavos, asado | 2026-12-24
 *   🦃 …
 */

export interface SeasonalReply {
  keywords: string[]
  reply: string
  /** Last day it applies (YYYY-MM-DD, the business's local date); '' = no end. */
  until: string
}

const MAX_RULES = 30

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9ñ\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

export function sanitizeSeasonalReplies(value: unknown): SeasonalReply[] {
  if (!Array.isArray(value)) return []
  return value
    .filter(isPlainObject)
    .map((r) => ({
      keywords: (Array.isArray(r.keywords) ? r.keywords : [])
        .filter((k): k is string => typeof k === 'string')
        .map((k) => k.trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 30),
      reply: typeof r.reply === 'string' ? r.reply.trim().slice(0, 1500) : '',
      until: typeof r.until === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.until.trim()) ? r.until.trim() : '',
    }))
    .filter((r) => r.keywords.length > 0 && r.reply)
    .slice(0, MAX_RULES)
}

export function seasonalRepliesToText(rules: SeasonalReply[]): string {
  return rules
    .map((r) => `${r.keywords.join(', ')}${r.until ? ` | ${r.until}` : ''}\n${r.reply}`)
    .join('\n---\n')
}

export function seasonalRepliesFromText(text: string): SeasonalReply[] {
  const blocks = text.replace(/\r\n/g, '\n').split(/\n\s*-{3,}\s*\n/)
  return sanitizeSeasonalReplies(
    blocks.map((block) => {
      const [head = '', ...rest] = block.trim().split('\n')
      const [words = '', until = ''] = head.split('|')
      return {
        keywords: words.split(',').map((w) => w.trim()),
        reply: rest.join('\n'),
        until: until.trim(),
      }
    }),
  )
}

/** The business's local date (YYYY-MM-DD) for a UTC offset in hours. */
export function localDate(utcOffsetHours: number, now = Date.now()): string {
  return new Date(now + utcOffsetHours * 3_600_000).toISOString().slice(0, 10)
}

/** The first rule still in date whose word appears (whole words, no accents) in the text. */
export function findSeasonalReply(
  rules: SeasonalReply[],
  text: string,
  today: string,
): { index: number; rule: SeasonalReply } | null {
  const said = ` ${normalize(text)} `
  for (const [index, rule] of rules.entries()) {
    if (rule.until && rule.until < today) continue
    if (rule.keywords.some((k) => normalize(k) && said.includes(` ${normalize(k)} `))) return { index, rule }
  }
  return null
}
