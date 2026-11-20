// ============================================================
// Aggregated WhatsApp / bot numbers for GET /api/v1/metrics (a partner
// app's results screen). Pure: the route loads rows, these functions turn
// them into per-day counts, hours and a median. Only numbers — no
// phones, names or message text ever leave through here.
// Days and hours are in the business's local time (UTC offset, no DST).
// ============================================================

import { localDayKey, topProducts, type TopProduct } from './orders-metrics'

export interface MetricsDay {
  day: string
  /** Conversations with at least one customer message that day. */
  conversations: number
  inbound_messages: number
  orders_whatsapp: number
  orders_web: number
  /** WhatsApp orders the bot took to a confirmed list on its own. */
  bot_orders: number
  /** Conversations passed to a person outside an order (asesor, call, complaint…). */
  handoffs: number
}

export interface FerrobotMetrics {
  days: MetricsDay[]
  /** Chats per campaign line ("Línea: juguetes" → "juguetes") and service kind ("servicio-pintura"), in the period. */
  lines: { line: string; chats: number }[]
  top_products: TopProduct[]
  hours: { hour: number; inbound: number }[]
  first_response_minutes: number | null
}

export interface MessageRow {
  conversation_id: string
  sender_type: 'customer' | 'agent' | 'bot'
  created_at: string
}

export interface MetricsInput {
  /** Every message of the period (any sender), oldest first or not. */
  messages: MessageRow[]
  whatsappOrders: { at: string; botConfirmed: boolean; lines: string[] }[]
  webOrders: { at: string; lines: string[] }[]
  /** Handoffs to a person that weren't an order. */
  handoffs: { at: string; conversationId: string | null }[]
  /** Contacts tagged with a campaign line or a service kind in the period (tag name). */
  lineTags?: string[]
}

/** "Línea: juguetes" → "juguetes", "servicio-pintura" stays; other tags → null. */
export function lineOfTag(name: string): string | null {
  if (name.startsWith('Línea: ')) return name.slice('Línea: '.length).trim() || null
  if (/^servicio-[a-z0-9-]+$/.test(name)) return name
  return null
}

export function emptyDays(days: number, now: Date, utcOffsetHours: number): MetricsDay[] {
  const out: MetricsDay[] = []
  for (let i = days - 1; i >= 0; i -= 1) {
    out.push({
      day: localDayKey(new Date(now.getTime() - i * 86_400_000), utcOffsetHours),
      conversations: 0,
      inbound_messages: 0,
      orders_whatsapp: 0,
      orders_web: 0,
      bot_orders: 0,
      handoffs: 0,
    })
  }
  return out
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  const m = s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
  return Math.round(m * 10) / 10
}

/**
 * Minutes from a customer's first message of the day in a conversation
 * to the first answer after it (bot or person). Unanswered ones don't
 * count (they show up as handoffs and alerts elsewhere).
 */
export function firstResponseMinutes(messages: MessageRow[], utcOffsetHours: number): number | null {
  const sorted = [...messages].sort((a, b) => a.created_at.localeCompare(b.created_at))
  const waiting = new Map<string, number>() // conversation|day → first inbound time
  const answered = new Set<string>()
  const gaps: number[] = []
  for (const m of sorted) {
    const key = `${m.conversation_id}|${localDayKey(m.created_at, utcOffsetHours)}`
    const t = new Date(m.created_at).getTime()
    if (m.sender_type === 'customer') {
      if (!waiting.has(key) && !answered.has(key)) waiting.set(key, t)
    } else if (waiting.has(key) && !answered.has(key)) {
      gaps.push((t - waiting.get(key)!) / 60_000)
      answered.add(key)
    }
  }
  return median(gaps)
}

export function ferrobotMetrics(
  input: MetricsInput,
  days: number,
  now: Date,
  utcOffsetHours: number,
  /** top products and hours look at this many recent days */
  recentDays = 30,
): FerrobotMetrics {
  const series = emptyDays(days, now, utcOffsetHours)
  const byDay = new Map(series.map((d) => [d.day, d]))
  const recentSince = now.getTime() - recentDays * 86_400_000
  const isRecent = (iso: string) => new Date(iso).getTime() >= recentSince

  const convDays = new Set<string>()
  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, inbound: 0 }))
  for (const m of input.messages) {
    if (m.sender_type !== 'customer') continue
    const day = byDay.get(localDayKey(m.created_at, utcOffsetHours))
    if (!day) continue
    day.inbound_messages += 1
    const key = `${m.conversation_id}|${day.day}`
    if (!convDays.has(key)) {
      convDays.add(key)
      day.conversations += 1
    }
    if (isRecent(m.created_at)) {
      const local = new Date(new Date(m.created_at).getTime() + utcOffsetHours * 3_600_000)
      hours[local.getUTCHours()].inbound += 1
    }
  }

  const lines: string[] = []
  for (const o of input.whatsappOrders) {
    const day = byDay.get(localDayKey(o.at, utcOffsetHours))
    if (!day) continue
    day.orders_whatsapp += 1
    if (o.botConfirmed) day.bot_orders += 1
    if (isRecent(o.at)) lines.push(...o.lines)
  }
  for (const o of input.webOrders) {
    const day = byDay.get(localDayKey(o.at, utcOffsetHours))
    if (!day) continue
    day.orders_web += 1
    if (isRecent(o.at)) lines.push(...o.lines)
  }
  const handedOff = new Set<string>()
  for (const h of input.handoffs) {
    const day = byDay.get(localDayKey(h.at, utcOffsetHours))
    if (!day) continue
    // One per conversation and day: "asesor" twice is still one handoff.
    const key = `${h.conversationId ?? h.at}|${day.day}`
    if (handedOff.has(key)) continue
    handedOff.add(key)
    day.handoffs += 1
  }

  const recentMessages = input.messages.filter((m) => isRecent(m.created_at))
  const lineCounts = new Map<string, number>()
  for (const t of input.lineTags ?? []) {
    const line = lineOfTag(t)
    if (line) lineCounts.set(line, (lineCounts.get(line) ?? 0) + 1)
  }
  return {
    days: series,
    lines: [...lineCounts].map(([line, chats]) => ({ line, chats })).sort((a, b) => b.chats - a.chats),
    top_products: topProducts(lines, 20),
    hours,
    first_response_minutes: firstResponseMinutes(recentMessages, utcOffsetHours),
  }
}
