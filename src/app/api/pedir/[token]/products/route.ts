import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { readOrderLinkToken } from "@/lib/catalog/order-link";
import { searchShop, shopFacets, type ShopSort } from "@/lib/catalog/shop-search";
import { refreshShopIfStale } from "@/lib/catalog/shop-sync";
import { checkRateLimit } from "@/lib/rate-limit";

// GET /api/pedir/<token>/products?q=&dep=&cat=&sort=&page=
//   Public (the signed link is the key). Products for the picker, best
//   sellers first; on the first page also the sections / categories.

const SORTS = new Set<ShopSort>(["pop", "low", "high", "az"]);

export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const check = readOrderLinkToken(token);
  if (!check.ok) return NextResponse.json({ error: check.reason }, { status: check.reason === "expired" ? 410 : 401 });
  const limit = checkRateLimit(`pedir:${token.slice(0, 32)}`, { limit: 240, windowMs: 60_000 });
  if (!limit.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").slice(0, 80);
  const dep = url.searchParams.get("dep") || null;
  const cat = url.searchParams.get("cat") || null;
  const sortParam = url.searchParams.get("sort") as ShopSort | null;
  const sort: ShopSort = sortParam && SORTS.has(sortParam) ? sortParam : "pop";
  const page = Number(url.searchParams.get("page") ?? 0) || 0;

  const db = supabaseAdmin();
  const accountId = check.link.accountId;
  void refreshShopIfStale(db, accountId);
  try {
    const [result, facets] = await Promise.all([
      searchShop(db, accountId, { q, department: dep, category: cat, sort, page, onlySale: url.searchParams.get("sale") === "1" }),
      page === 0 ? shopFacets(db, accountId, q, dep) : Promise.resolve(null),
    ]);
    return NextResponse.json({ ...result, facets });
  } catch (err) {
    console.error("[pedir] search failed:", err);
    return NextResponse.json({ error: "search_failed" }, { status: 500 });
  }
}
