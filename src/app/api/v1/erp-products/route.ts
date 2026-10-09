// ============================================================
// POST /api/v1/erp-products  — upload the store system's product list
//                              (scope: catalog:write)
//
// Sent by the store PC in batches:
//   { started_at, products: [{ code, barcode?, name?, brand?, class?,
//     stock?, price?, sold_90d?, last_sale?, by_weight? }, ...] }
// and a last call `{ started_at, done: true }` that drops the codes the
// system no longer has and copies sales / stock onto the web shop's
// products (best sellers first in the product picker).
//
// Only these fields are kept — anything else in a row (costs,
// suppliers…) is ignored, never stored.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, badRequest, toApiErrorResponse } from '@/lib/api/v1/respond';

const MAX_BATCH = 2000;

type Row = {
  account_id: string;
  code: string;
  barcode: string | null;
  name: string | null;
  brand: string | null;
  class: string | null;
  stock: number | null;
  price: number | null;
  sold_90d: number;
  last_sale: string | null;
  by_weight: boolean;
  synced_at: string;
};

function str(v: unknown, max: number): string | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v).trim().slice(0, max);
  return s || null;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function day(v: unknown): string | null {
  const s = str(v, 30);
  return s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'catalog:write');
    let body: { started_at?: unknown; products?: unknown; done?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      throw badRequest('Body must be JSON');
    }
    const startedAt =
      typeof body.started_at === 'string' && !Number.isNaN(Date.parse(body.started_at))
        ? new Date(body.started_at).toISOString()
        : null;
    if (!startedAt) throw badRequest('started_at (ISO date) is required');

    const raw = Array.isArray(body.products) ? body.products : [];
    if (raw.length > MAX_BATCH) throw badRequest(`At most ${MAX_BATCH} products per call`);
    const byCode = new Map<string, Row>();
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const p = item as Record<string, unknown>;
      const code = str(p.code, 64);
      if (!code) continue;
      byCode.set(code, {
        account_id: ctx.accountId,
        code,
        barcode: str(p.barcode, 64),
        name: str(p.name, 200),
        brand: str(p.brand, 120),
        class: str(p.class, 120),
        stock: num(p.stock),
        price: num(p.price),
        sold_90d: Math.max(0, num(p.sold_90d) ?? 0),
        last_sale: day(p.last_sale),
        by_weight: p.by_weight === true || code.startsWith('-'),
        synced_at: startedAt,
      });
    }
    const rows = [...byCode.values()];
    if (rows.length) {
      const { error } = await ctx.supabase.from('erp_products').upsert(rows, { onConflict: 'account_id,code' });
      if (error) throw new Error(`erp_products upsert: ${error.message}`);
    }

    let removed = 0;
    if (body.done === true) {
      // Drop codes this upload didn't include — only when the upload
      // looks complete (a cut-off run must not empty the table).
      const [{ count: fresh }, { count: all }] = await Promise.all([
        ctx.supabase.from('erp_products').select('code', { count: 'exact', head: true })
          .eq('account_id', ctx.accountId).gte('synced_at', startedAt),
        ctx.supabase.from('erp_products').select('code', { count: 'exact', head: true })
          .eq('account_id', ctx.accountId),
      ]);
      if ((fresh ?? 0) > 0 && (fresh ?? 0) >= (all ?? 0) * 0.5) {
        const { count, error } = await ctx.supabase.from('erp_products')
          .delete({ count: 'exact' })
          .eq('account_id', ctx.accountId)
          .lt('synced_at', startedAt);
        if (error) throw new Error(`erp_products prune: ${error.message}`);
        removed = count ?? 0;
      }
      const { error } = await ctx.supabase.rpc('refresh_shop_popularity', { p_account: ctx.accountId });
      if (error) throw new Error(`refresh_shop_popularity: ${error.message}`);
    }

    return ok({ saved: rows.length, removed, done: body.done === true });
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
