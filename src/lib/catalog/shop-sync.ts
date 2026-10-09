// ============================================================
// Keeps shop_products in step with the web shop's product feed (the
// CSV in Settings → My business → "Web shop product feed").
//
// Runs from the maintenance cron, and lazily when the product picker
// finds the copy older than SHOP_MAX_AGE_MS (in the background — the
// customer is served the current copy meanwhile). One sync at a time
// per account (in-memory lock; the app runs in one container).
//
// Safety: a feed with suspiciously few products (a broken or empty
// file) changes nothing; products are only removed when the new feed
// is at least half the size of what's stored.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadBusinessSettings } from "../business/settings";
import { feedToProducts, parseCsv } from "./feed";

export const SHOP_MAX_AGE_MS = 3 * 3_600_000;
const MIN_PRODUCTS = 50;
const BATCH = 1000;
const running = new Map<string, Promise<ShopSyncResult>>();

export type ShopSyncResult =
  | { ok: true; products: number; removed: number; ms: number }
  | { ok: false; error: string };

export function syncShopProducts(db: SupabaseClient, accountId: string): Promise<ShopSyncResult> {
  const current = running.get(accountId);
  if (current) return current;
  const job = doSync(db, accountId).finally(() => running.delete(accountId));
  running.set(accountId, job);
  return job;
}

async function doSync(db: SupabaseClient, accountId: string): Promise<ShopSyncResult> {
  const started = Date.now();
  const url = (await loadBusinessSettings(db, accountId)).shopFeedUrl.trim();
  if (!/^https:\/\//.test(url)) return { ok: false, error: "no_feed_url" };
  let text: string;
  try {
    const res = await fetch(`${url}${url.includes("?") ? "&" : "?"}nc=${started}`, { signal: AbortSignal.timeout(90_000) });
    if (!res.ok) return { ok: false, error: `feed HTTP ${res.status}` };
    text = await res.text();
  } catch (err) {
    return { ok: false, error: `feed fetch: ${err instanceof Error ? err.message : String(err)}` };
  }
  const products = feedToProducts(parseCsv(text));
  if (products.length < MIN_PRODUCTS) return { ok: false, error: `feed has only ${products.length} products` };

  const stamp = new Date(started).toISOString();
  for (let i = 0; i < products.length; i += BATCH) {
    const { error } = await db.from("shop_products").upsert(
      products.slice(i, i + BATCH).map((p) => ({ ...p, account_id: accountId, synced_at: stamp })),
      { onConflict: "account_id,sku" },
    );
    if (error) return { ok: false, error: `upsert: ${error.message}` };
  }

  let removed = 0;
  const { count: stored } = await db
    .from("shop_products")
    .select("sku", { count: "exact", head: true })
    .eq("account_id", accountId);
  if ((stored ?? 0) > 0 && products.length >= (stored ?? 0) * 0.5) {
    const { count, error } = await db
      .from("shop_products")
      .delete({ count: "exact" })
      .eq("account_id", accountId)
      .lt("synced_at", stamp);
    if (error) console.error("[shop-sync] prune failed:", error.message);
    removed = count ?? 0;
  }
  const pop = await refreshShopPopularity(db, accountId);
  if (!pop.ok) console.error("[shop-sync] popularity refresh failed:", pop.error);
  return { ok: true, products: products.length, removed, ms: Date.now() - started };
}

/** Starts a background sync when the stored copy is older than SHOP_MAX_AGE_MS. Never throws. */
export async function refreshShopIfStale(db: SupabaseClient, accountId: string): Promise<void> {
  try {
    if (running.has(accountId)) return;
    const { data } = await db
      .from("shop_products")
      .select("synced_at")
      .eq("account_id", accountId)
      .order("synced_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const last = (data as { synced_at?: string } | null)?.synced_at;
    if (last && Date.now() - new Date(last).getTime() < SHOP_MAX_AGE_MS) return;
    void syncShopProducts(db, accountId).then((r) => {
      if (!r.ok) console.error("[shop-sync] background sync failed:", r.error);
    });
  } catch (err) {
    console.error("[shop-sync] staleness check failed:", err);
  }
}

/**
 * Copy the ERP's sales and stock onto the shop's products, a slice per
 * call (see migration 047) so no single statement hits the timeout.
 */
export async function refreshShopPopularity(
  db: SupabaseClient,
  accountId: string,
): Promise<{ ok: true; updated: number } | { ok: false; error: string; updated: number }> {
  let updated = 0;
  for (let i = 0; i < 200; i++) {
    const { data, error } = await db.rpc("refresh_shop_popularity_batch", { p_account: accountId, p_limit: 2000 });
    if (error) return { ok: false, error: error.message, updated };
    const n = Number(data) || 0;
    updated += n;
    if (n === 0) break;
  }
  return { ok: true, updated };
}
