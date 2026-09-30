// ============================================================
// Minimal WooCommerce REST client — just what the bot needs to act on
// a web order from WhatsApp (confirm / cancel a cash-on-delivery
// order and leave an order note staff see in WooCommerce).
//
// Config (server env, e.g. EasyPanel):
//   WOOCOMMERCE_URL     https://ferrotiendaec.com
//   WOOCOMMERCE_KEY     ck_…   (REST API key, read/write)
//   WOOCOMMERCE_SECRET  cs_…
// Without them every call is a no-op that reports `not_configured`,
// so the WhatsApp side keeps working unchanged.
// ============================================================

export interface WooResult {
  ok: boolean
  error?: string
}

export function wooConfigured(): boolean {
  return Boolean(process.env.WOOCOMMERCE_URL && process.env.WOOCOMMERCE_KEY && process.env.WOOCOMMERCE_SECRET)
}

export function wooOrderUrl(baseUrl: string, orderId: string, suffix = ''): string {
  return `${baseUrl.replace(/\/+$/, '')}/wp-json/wc/v3/orders/${encodeURIComponent(orderId)}${suffix}`
}

async function wooRequest(url: string, method: 'PUT' | 'POST', body: unknown): Promise<WooResult> {
  const auth = Buffer.from(`${process.env.WOOCOMMERCE_KEY}:${process.env.WOOCOMMERCE_SECRET}`).toString('base64')
  try {
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return { ok: false, error: `HTTP ${res.status} ${text.slice(0, 200)}` }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Set a web order's status (e.g. "processing", "cancelled") and/or add a note. */
export async function updateWooOrder(
  orderId: string,
  change: { status?: string; note?: string },
): Promise<WooResult> {
  if (!wooConfigured()) return { ok: false, error: 'not_configured' }
  const base = process.env.WOOCOMMERCE_URL!
  if (change.status) {
    const r = await wooRequest(wooOrderUrl(base, orderId), 'PUT', { status: change.status })
    if (!r.ok) return r
  }
  if (change.note) {
    // Private note: shown to staff in WooCommerce, not emailed to the buyer.
    const r = await wooRequest(wooOrderUrl(base, orderId, '/notes'), 'POST', {
      note: change.note,
      customer_note: false,
    })
    if (!r.ok) return r
  }
  return { ok: true }
}
