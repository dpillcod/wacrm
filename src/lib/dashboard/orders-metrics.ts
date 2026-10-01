// ============================================================
// Pure aggregation for the dashboard's orders panel (Ferrobot).
// The API route (/api/metrics/orders) does the queries; everything
// that turns rows into numbers lives here so it's unit-testable.
// Days are bucketed in the business's local time (UTC offset from
// its settings, no DST).
// ============================================================

export function localDayKey(iso: string | Date, utcOffsetHours: number): string {
  const t = (typeof iso === 'string' ? new Date(iso) : iso).getTime()
  return new Date(t + utcOffsetHours * 3_600_000).toISOString().slice(0, 10)
}

export interface DailyOrdersPoint {
  /** YYYY-MM-DD (local). */
  day: string
  whatsapp: number
  web: number
}

/** One point per day for the last `days` days (today included), zero-filled. */
export function dailyOrderSeries(
  days: number,
  whatsappDates: string[],
  webDates: string[],
  now: Date = new Date(),
  utcOffsetHours = -5,
): DailyOrdersPoint[] {
  const points: DailyOrdersPoint[] = []
  const index = new Map<string, DailyOrdersPoint>()
  for (let i = days - 1; i >= 0; i -= 1) {
    const day = localDayKey(new Date(now.getTime() - i * 86_400_000), utcOffsetHours)
    const p = { day, whatsapp: 0, web: 0 }
    points.push(p)
    index.set(day, p)
  }
  for (const d of whatsappDates) {
    const p = index.get(localDayKey(d, utcOffsetHours))
    if (p) p.whatsapp += 1
  }
  for (const d of webDates) {
    const p = index.get(localDayKey(d, utcOffsetHours))
    if (p) p.web += 1
  }
  return points
}

/**
 * "2 Coca-Cola de 3 litros" / "2x COCA COLA 3 LT" → a counting key with
 * the quantity stripped; accents, case and punctuation folded.
 */
export function productKey(line: string): string {
  return line
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/^\s*\d+([.,]\d+)?\s*(x|u|und|unds|unidades?)?\s*[x×-]?\s*/, '')
    .replace(/[^a-z0-9ñ\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export interface TopProduct {
  /** As first written by a customer, quantity removed. */
  label: string
  count: number
}

/** Most-requested products across order lines, by number of orders naming them. */
export function topProducts(lines: string[], limit = 10): TopProduct[] {
  const counts = new Map<string, TopProduct>()
  for (const raw of lines) {
    const key = productKey(raw)
    if (!key || key.length < 2) continue
    const existing = counts.get(key)
    if (existing) existing.count += 1
    else {
      const label = raw.replace(/^\s*\d+([.,]\d+)?\s*(x|u|und|unds|unidades?)?\s*[x×-]?\s*/i, '').trim()
      counts.set(key, { label: label || raw.trim(), count: 1 })
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)).slice(0, limit)
}

export interface CsatCounts {
  excelente: number
  bien: number
  mal: number
}

/** Ratings written into order-card notes by the delivery survey. */
export function csatCounts(notes: (string | null)[]): CsatCounts {
  const out = { excelente: 0, bien: 0, mal: 0 }
  for (const n of notes) {
    for (const m of (n ?? '').matchAll(/Calificación del cliente: \S+ (Excelente|Bien|Mal)/g)) {
      const k = m[1].toLowerCase() as keyof CsatCounts
      out[k] += 1
    }
  }
  return out
}

/** Share of ratings that were good (Excelente + Bien), 0–100; null with none. */
export function satisfactionPct(c: CsatCounts): number | null {
  const total = c.excelente + c.bien + c.mal
  return total === 0 ? null : Math.round(((c.excelente + c.bien) / total) * 100)
}

/** Order lines from a WhatsApp order's text (one item per line). */
export function whatsappOrderLines(orderText: unknown): string[] {
  return typeof orderText === 'string'
    ? orderText.split('\n').map((l) => l.trim()).filter(Boolean)
    : []
}

/** Order lines from a web order's summary ("2x A, 1x B"). */
export function webOrderLines(summary: unknown): string[] {
  return typeof summary === 'string' && !summary.startsWith('(sin detalle')
    ? summary.split(', ').map((l) => l.trim()).filter(Boolean)
    : []
}

export interface OrdersMetrics {
  days: number
  daily: DailyOrdersPoint[]
  totals: { whatsapp: number; web: number }
  /** WhatsApp order funnel, counts of runs of the main (menu) flows. */
  funnel: { key: 'wrote' | 'started' | 'confirmed' | 'handedOff'; count: number }[]
  /** Orders whose customer had to be chased (staff reminders went out). */
  needingReminder: number
  csat: CsatCounts
  satisfactionPct: number | null
  topProducts: TopProduct[]
  /** Contacts per "Origen: …" tag (all time). */
  origins: { tag: string; contacts: number }[]
}
