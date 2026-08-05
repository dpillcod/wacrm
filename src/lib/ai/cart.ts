import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveCatalogProduct } from './catalog'

// ============================================================
// Per-conversation order cart (migration 040).
//
// The model never computes a price or a total itself — it only
// signals INTENT via sentinels ([[CART_ADD:id:qty]] / [[CART_TOTAL]],
// parsed in generate.ts). Every price here is copied from
// `catalog_products` at write time (via `resolveCatalogProduct`,
// same trust boundary as the existing product-recommendation
// sentinel), and totals are summed here in plain arithmetic — never
// asserted by the LLM. Best-effort like the rest of the ai/ layer:
// failures degrade to null/[]/unchanged state, never throw into the
// auto-reply path.
// ============================================================

export interface CartItem {
  retailerId: string
  name: string
  price: number | null
  currency: string | null
  quantity: number
}

interface CartItemRow {
  retailer_id: string
  name: string
  price: number | null
  currency: string | null
  quantity: number
}

function toCartItem(row: CartItemRow): CartItem {
  return {
    retailerId: row.retailer_id,
    name: row.name,
    price: row.price,
    currency: row.currency,
    quantity: row.quantity,
  }
}

/**
 * Add or update a cart line item. `quantity` is the customer's TOTAL
 * desired quantity of this item (not a delta) — re-adding the same
 * retailer_id overwrites the line rather than incrementing it, since
 * the model re-derives intent from the whole conversation each turn
 * and asking it to track running deltas reliably is a much easier way
 * to double- or under-count than just having it restate the total.
 *
 * Validates the id against the synced catalog first (the model can
 * hallucinate or misquote a retailer_id) — silently no-ops if it
 * doesn't resolve, same "never throw" philosophy as the rest of this
 * module.
 */
export async function addCartItem(
  db: SupabaseClient,
  accountId: string,
  conversationId: string,
  retailerId: string,
  quantity: number,
): Promise<CartItem | null> {
  const product = await resolveCatalogProduct(db, accountId, retailerId)
  if (!product) return null

  const qty = Number.isFinite(quantity) && quantity > 0 ? Math.floor(quantity) : 1

  try {
    const { data, error } = await db
      .from('conversation_cart_items')
      .upsert(
        {
          account_id: accountId,
          conversation_id: conversationId,
          retailer_id: product.retailerId,
          name: product.name,
          price: product.price,
          currency: product.currency,
          quantity: qty,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'conversation_id,retailer_id' },
      )
      .select('retailer_id, name, price, currency, quantity')
      .maybeSingle()
    if (error || !data) return null
    return toCartItem(data as CartItemRow)
  } catch (err) {
    console.error('[ai cart] addCartItem failed:', err)
    return null
  }
}

/** All line items currently in a conversation's cart, oldest first. */
export async function getCartItems(
  db: SupabaseClient,
  conversationId: string,
): Promise<CartItem[]> {
  try {
    const { data, error } = await db
      .from('conversation_cart_items')
      .select('retailer_id, name, price, currency, quantity')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true })
    if (error || !Array.isArray(data)) return []
    return (data as CartItemRow[]).map(toCartItem)
  } catch (err) {
    console.error('[ai cart] getCartItems failed:', err)
    return []
  }
}

/**
 * Sum of price × quantity across items that have a known price.
 * Items missing a price (stale catalog data) are excluded from the
 * sum but the caller should still disclose them — see
 * `formatCartSummary`.
 */
export function computeCartTotal(items: CartItem[]): {
  total: number
  currency: string | null
  hasUnpriced: boolean
} {
  let total = 0
  let currency: string | null = null
  let hasUnpriced = false
  for (const item of items) {
    if (item.price != null) {
      total += item.price * item.quantity
      currency = currency ?? item.currency
    } else {
      hasUnpriced = true
    }
  }
  return { total, currency, hasUnpriced }
}

/** Plain-text itemized summary, ready to send as a WhatsApp message. */
export function formatCartSummary(items: CartItem[]): string {
  if (items.length === 0) {
    return 'Todavía no tienes productos agregados a tu pedido.'
  }
  const { total, currency, hasUnpriced } = computeCartTotal(items)
  const lines = items.map((item) => {
    const priceText =
      item.price != null
        ? ` — ${(item.price * item.quantity).toFixed(2)} ${currency ?? 'USD'}`
        : ' — precio no disponible en este momento'
    return `• ${item.quantity} x ${item.name}${priceText}`
  })
  const totalLabel = hasUnpriced ? 'Subtotal (productos con precio disponible)' : 'Total'
  return (
    `🛒 Tu pedido hasta ahora:\n\n${lines.join('\n')}\n\n` +
    `${totalLabel}: ${total.toFixed(2)} ${currency ?? 'USD'}`
  )
}
