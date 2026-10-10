// ============================================================
// The product picker's cart on the server (shop_carts, migration 048),
// the order lines built from picked products, and the customer's
// "usual" products (from their past orders).
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import { catalogOrderLines, MAX_LINES, MAX_QTY, type PickedProduct } from "./order-lines";

export interface CartItem {
  sku: string;
  qty: number;
}

export interface StoredCart {
  accountId: string;
  contactId: string;
  conversationId: string | null;
  items: CartItem[];
  note: string;
  updatedAt: string;
  remindedAt: string | null;
}

/** Valid, de-duplicated items (unknown shapes dropped). */
export function cleanItems(raw: unknown): CartItem[] {
  if (!Array.isArray(raw)) return [];
  const out = new Map<string, number>();
  for (const it of raw) {
    if (!it || typeof it !== "object") continue;
    const sku = (it as { sku?: unknown }).sku;
    const qty = Math.floor(Number((it as { qty?: unknown }).qty));
    if (typeof sku !== "string" || !sku || sku.length > 64 || !Number.isFinite(qty) || qty < 1) continue;
    out.set(sku, Math.min(MAX_QTY, qty));
    if (out.size >= MAX_LINES) break;
  }
  return [...out].map(([sku, qty]) => ({ sku, qty }));
}

function rowToCart(r: Record<string, unknown>): StoredCart {
  return {
    accountId: r.account_id as string,
    contactId: r.contact_id as string,
    conversationId: (r.conversation_id as string | null) ?? null,
    items: cleanItems(r.items),
    note: typeof r.note === "string" ? r.note : "",
    updatedAt: r.updated_at as string,
    remindedAt: (r.reminded_at as string | null) ?? null,
  };
}

export async function loadCart(db: SupabaseClient, accountId: string, contactId: string): Promise<StoredCart | null> {
  const { data, error } = await db
    .from("shop_carts")
    .select("*")
    .eq("account_id", accountId)
    .eq("contact_id", contactId)
    .maybeSingle();
  if (error || !data) return null;
  return rowToCart(data as Record<string, unknown>);
}

/** Save what's in the picker now (an empty cart is removed). A change re-arms the reminder. */
export async function saveCart(
  db: SupabaseClient,
  args: { accountId: string; contactId: string; conversationId: string; items: CartItem[]; note: string },
): Promise<void> {
  if (!args.items.length && !args.note.trim()) {
    await clearCart(db, args.accountId, args.contactId);
    return;
  }
  const { error } = await db.from("shop_carts").upsert(
    {
      account_id: args.accountId,
      contact_id: args.contactId,
      conversation_id: args.conversationId,
      items: args.items,
      note: args.note.slice(0, 1000),
      updated_at: new Date().toISOString(),
      reminded_at: null,
    },
    { onConflict: "account_id,contact_id" },
  );
  if (error) throw new Error(`shop_carts: ${error.message}`);
}

export async function clearCart(db: SupabaseClient, accountId: string, contactId: string): Promise<void> {
  await db.from("shop_carts").delete().eq("account_id", accountId).eq("contact_id", contactId);
}

/** Carts left alone for `idleMs` with no reminder yet (oldest first). */
export async function cartsDueForReminder(db: SupabaseClient, idleMs: number, limit = 50): Promise<StoredCart[]> {
  const { data, error } = await db
    .from("shop_carts")
    .select("*")
    .is("reminded_at", null)
    .lte("updated_at", new Date(Date.now() - idleMs).toISOString())
    // Older than a day: the free 24 h window has closed anyway.
    .gte("updated_at", new Date(Date.now() - 20 * 3_600_000).toISOString())
    .order("updated_at", { ascending: true })
    .limit(limit);
  if (error || !data) return [];
  return (data as Record<string, unknown>[]).map(rowToCart);
}

export async function markCartReminded(db: SupabaseClient, cart: StoredCart): Promise<boolean> {
  // Only if untouched since we read it (a change re-arms the reminder).
  const { data } = await db
    .from("shop_carts")
    .update({ reminded_at: new Date().toISOString() })
    .eq("account_id", cart.accountId)
    .eq("contact_id", cart.contactId)
    .eq("updated_at", cart.updatedAt)
    .is("reminded_at", null)
    .select("contact_id");
  return (data ?? []).length > 0;
}

export interface ShopProductRow {
  sku: string;
  title: string;
  price: number;
  salePrice: number | null;
  image: string | null;
  inStock: boolean;
}

/** Shop products by SKU (what the picker and the order lines need). */
export async function productsBySku(db: SupabaseClient, accountId: string, skus: string[]): Promise<Map<string, ShopProductRow>> {
  const out = new Map<string, ShopProductRow>();
  const unique = [...new Set(skus)].slice(0, 300);
  if (!unique.length) return out;
  const { data, error } = await db
    .from("shop_products")
    .select("sku, title, price, sale_price, image_url, in_stock, erp_stock")
    .eq("account_id", accountId)
    .in("sku", unique);
  if (error) throw new Error(`shop_products: ${error.message}`);
  for (const r of (data ?? []) as {
    sku: string;
    title: string;
    price: number | string;
    sale_price: number | string | null;
    image_url: string | null;
    in_stock: boolean;
    erp_stock: number | string | null;
  }[]) {
    out.set(r.sku, {
      sku: r.sku,
      title: r.title,
      price: Number(r.price),
      salePrice: r.sale_price === null ? null : Number(r.sale_price),
      image: r.image_url,
      inStock: r.in_stock && (r.erp_stock === null || Number(r.erp_stock) > 0),
    });
  }
  return out;
}

/** Order lines for picked items, with the server's prices. */
export async function cartOrderLines(
  db: SupabaseClient,
  accountId: string,
  items: CartItem[],
): Promise<{ lines: string[]; total: number; units: number }> {
  const products = await productsBySku(db, accountId, items.map((i) => i.sku));
  const picked = new Map<string, PickedProduct>([...products].map(([sku, p]) => [sku, p]));
  const { lines, total } = catalogOrderLines(items, picked);
  const units = items.filter((i) => picked.has(i.sku)).reduce((a, i) => a + i.qty, 0);
  return { lines, total, units };
}

// ---------------------------------------------------------------- usual products

const CODE = /\(cód\.\s*([^)]+)\)/;
const QTY = /^(\d+)\s*[×x]\s/;

/**
 * From the order lists of past orders: each catalog product (lines carry
 * "(cód. SKU)") with how many orders it was in and the last quantity.
 * Most frequent first, then most recent.
 */
export function usualFromLists(lists: string[]): { sku: string; orders: number; lastQty: number }[] {
  const seen = new Map<string, { sku: string; orders: number; lastQty: number; rank: number }>();
  lists.forEach((list, rank) => {
    const inThis = new Set<string>();
    for (const raw of list.split("\n")) {
      const code = raw.match(CODE)?.[1]?.trim();
      if (!code || inThis.has(code)) continue;
      inThis.add(code);
      const qty = Number(raw.trim().match(QTY)?.[1] ?? 1) || 1;
      const prev = seen.get(code);
      if (prev) prev.orders += 1;
      else seen.set(code, { sku: code, orders: 1, lastQty: qty, rank });
    }
  });
  return [...seen.values()]
    .sort((a, b) => b.orders - a.orders || a.rank - b.rank)
    .map(({ sku, orders, lastQty }) => ({ sku, orders, lastQty }));
}

/** The customer's usual catalog products (newest orders first in `lists`). */
export async function loadUsualProducts(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  listVar = "order_text",
): Promise<{ sku: string; orders: number; lastQty: number }[]> {
  const { data } = await db
    .from("flow_runs")
    .select("vars, started_at")
    .eq("account_id", accountId)
    .eq("contact_id", contactId)
    .order("started_at", { ascending: false })
    .limit(60);
  const lists = ((data ?? []) as { vars: Record<string, unknown> | null }[])
    .filter((r) => r.vars?.order_number && typeof r.vars[listVar] === "string")
    .map((r) => r.vars![listVar] as string);
  return usualFromLists(lists).slice(0, 12);
}
