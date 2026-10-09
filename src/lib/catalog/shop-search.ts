// ============================================================
// Product picker search over shop_products: every typed word must
// appear (accent-free), best sellers first, 20 per page, plus the
// sections / categories (with counts) for the filters.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import { searchWords, thumbnailUrl } from "./feed";

export const PAGE_SIZE = 20;
export type ShopSort = "pop" | "low" | "high" | "az";

export interface ShopItem {
  sku: string;
  title: string;
  price: number;
  salePrice: number | null;
  thumb: string | null;
  image: string | null;
  department: string | null;
  category: string | null;
}

export interface ShopQuery {
  q?: string;
  department?: string | null;
  category?: string | null;
  sort?: ShopSort;
  page?: number;
  /** Only products with an offer price. */
  onlySale?: boolean;
}

/** The store's generic "no photo" image is shown as the picker's own placeholder. */
function realImage(url: string | null): string | null {
  return url && !/placeholder/i.test(url) ? url : null;
}

export async function searchShop(
  db: SupabaseClient,
  accountId: string,
  query: ShopQuery,
): Promise<{ items: ShopItem[]; total: number; page: number; pageSize: number }> {
  const page = Math.max(0, Math.min(200, Math.floor(query.page ?? 0)));
  let q = db
    .from("shop_products")
    .select("sku, title, price, sale_price, image_url, department, category", { count: "exact" })
    .eq("account_id", accountId)
    .eq("in_stock", true)
    .or("erp_stock.is.null,erp_stock.gt.0");
  for (const w of searchWords(query.q ?? "")) q = q.like("search_text", `%${w}%`);
  if (query.department) q = q.eq("department", query.department);
  if (query.category) q = q.eq("category", query.category);
  if (query.onlySale) q = q.not("sale_price", "is", null);
  switch (query.sort) {
    case "low":
      q = q.order("price", { ascending: true });
      break;
    case "high":
      q = q.order("price", { ascending: false });
      break;
    case "az":
      q = q.order("title", { ascending: true });
      break;
    default:
      // Best sellers first; among equals (or before any sales data),
      // products with a photo.
      q = q
        .order("sold_90d", { ascending: false })
        .order("image_url", { ascending: true, nullsFirst: false })
        .order("title", { ascending: true });
  }
  const { data, count, error } = await q.range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
  if (error) throw new Error(error.message);
  const items = ((data ?? []) as {
    sku: string;
    title: string;
    price: number | string;
    sale_price: number | string | null;
    image_url: string | null;
    department: string | null;
    category: string | null;
  }[]).map((r) => {
    const image = realImage(r.image_url);
    return {
      sku: r.sku,
      title: r.title,
      price: Number(r.price),
      salePrice: r.sale_price === null ? null : Number(r.sale_price),
      thumb: thumbnailUrl(image),
      image,
      department: r.department,
      category: r.category,
    };
  });
  return { items, total: count ?? items.length, page, pageSize: PAGE_SIZE };
}

export interface ShopFacets {
  departments: { name: string; n: number }[];
  categories: { name: string; n: number }[];
}

export async function shopFacets(
  db: SupabaseClient,
  accountId: string,
  q: string,
  department: string | null,
): Promise<ShopFacets> {
  const { data, error } = await db.rpc("shop_facets", {
    p_account: accountId,
    p_words: searchWords(q),
    p_department: department,
  });
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as { kind: string; name: string; n: number | string }[];
  const pick = (kind: string) =>
    rows
      .filter((r) => r.kind === kind)
      .map((r) => ({ name: r.name, n: Number(r.n) }))
      .sort((a, b) => b.n - a.n);
  return { departments: pick("department"), categories: pick("category") };
}
