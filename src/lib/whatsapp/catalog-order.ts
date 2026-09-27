import type { SupabaseClient } from '@supabase/supabase-js'
import type { OrderItem } from '@/lib/flows/types'

// ============================================================
// Inbound WhatsApp catalog carts (Meta message type "order").
//
// When a customer builds a cart in the in-chat catalog and sends it,
// Meta delivers the exact retailer ids, quantities and the prices it
// showed them — but no product names. Names are looked up in the
// locally-synced `catalog_products` so the inbox and the flow's order
// text read like the rest of the order ("2 x COCA COLA 2L"), falling
// back to the retailer id for anything not synced yet.
// ============================================================

export interface MetaOrderPayload {
  catalog_id?: string
  /** Optional note the customer typed alongside the cart. */
  text?: string
  product_items?: Array<{
    product_retailer_id: string
    quantity: number | string
    item_price?: number | string
    currency?: string
  }>
}

function toNumber(value: number | string | undefined): number | null {
  if (value === undefined || value === null || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

export function buildOrderItems(
  payload: MetaOrderPayload,
  namesByRetailerId: Map<string, string>,
): OrderItem[] {
  return (payload.product_items ?? [])
    .filter((p) => p.product_retailer_id)
    .map((p) => ({
      retailer_id: p.product_retailer_id,
      name: namesByRetailerId.get(p.product_retailer_id) ?? p.product_retailer_id,
      quantity: Math.max(1, Math.round(toNumber(p.quantity) ?? 1)),
      unit_price: toNumber(p.item_price),
      currency: p.currency ?? null,
    }))
}

export function formatMoney(amount: number, currency: string | null): string {
  const fixed = amount.toFixed(2)
  return !currency || currency === 'USD' ? `$${fixed}` : `${currency} ${fixed}`
}

/** One line per item — the same shape as typed order lines. */
export function formatOrderLines(items: OrderItem[]): string {
  return items
    .map((item) => {
      const price =
        item.unit_price != null ? ` (${formatMoney(item.unit_price, item.currency)} c/u)` : ''
      return `${item.quantity} x ${item.name}${price}`
    })
    .join('\n')
}

/** Inbox-facing summary: the lines plus a total when every item has a price. */
export function formatOrderSummary(items: OrderItem[], note?: string): string {
  const lines = formatOrderLines(items)
  const allPriced = items.length > 0 && items.every((i) => i.unit_price != null)
  const total = allPriced
    ? `\nTotal: ${formatMoney(
        items.reduce((sum, i) => sum + i.unit_price! * i.quantity, 0),
        items[0].currency,
      )}`
    : ''
  const noteLine = note?.trim() ? `\nNota del cliente: ${note.trim()}` : ''
  return `🛒 Pedido desde el catálogo:\n${lines}${total}${noteLine}`
}

export async function resolveOrderItems(
  db: SupabaseClient,
  accountId: string,
  payload: MetaOrderPayload,
): Promise<OrderItem[]> {
  const ids = (payload.product_items ?? []).map((p) => p.product_retailer_id).filter(Boolean)
  const names = new Map<string, string>()
  if (ids.length > 0) {
    const { data, error } = await db
      .from('catalog_products')
      .select('retailer_id, name')
      .eq('account_id', accountId)
      .in('retailer_id', ids)
    if (error) {
      // Names are cosmetic — ids still identify every item exactly.
      console.error('[catalog-order] name lookup failed:', error.message)
    }
    for (const row of (data ?? []) as { retailer_id: string; name: string }[]) {
      names.set(row.retailer_id, row.name)
    }
  }
  return buildOrderItems(payload, names)
}
