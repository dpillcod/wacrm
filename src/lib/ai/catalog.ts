import type { SupabaseClient } from '@supabase/supabase-js'

// ============================================================
// Catalog product retrieval for the AI assistant. Mirrors
// `knowledge.ts`'s shape: best-effort, never throws into the
// draft/auto-reply path, degrades to `[]`/`null` on any failure.
//
// Unlike the knowledge base, this is plain lexical `ILIKE` search over
// the (typically small) synced catalog — no embeddings/semantic search
// for v1.
// ============================================================

export interface CatalogProductCandidate {
  retailerId: string
  name: string
  description: string | null
  price: number | null
  currency: string | null
  imageUrl: string | null
}

interface CatalogProductRow {
  retailer_id: string
  name: string
  description: string | null
  price: number | null
  currency: string | null
  image_url: string | null
}

function toCandidate(row: CatalogProductRow): CatalogProductCandidate {
  return {
    retailerId: row.retailer_id,
    name: row.name,
    description: row.description,
    price: row.price,
    currency: row.currency,
    imageUrl: row.image_url,
  }
}

/**
 * Retrieve up to `k` catalog products whose name/description match
 * `queryText`. Best-effort: any failure (no catalog synced, DB error)
 * degrades to `[]`, same philosophy as `retrieveKnowledge`.
 */
export async function retrieveCatalogProducts(
  db: SupabaseClient,
  accountId: string,
  queryText: string,
  k = 5,
): Promise<CatalogProductCandidate[]> {
  const query = queryText.trim()
  if (!query || k <= 0) return []

  try {
    // Strip characters PostgREST's `.or()` filter syntax treats as
    // structural (comma separates conditions, parens group them) so a
    // stray one in the customer's message can't malform the query —
    // this is best-effort lexical matching, not exact-phrase search, so
    // dropping them is harmless.
    const words = query
      .replace(/[(),]/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 8)
    if (words.length === 0) return []

    const orFilter = words
      .map((w) => {
        const escaped = w.replace(/[%_]/g, '\\$&')
        return `name.ilike.%${escaped}%,description.ilike.%${escaped}%`
      })
      .join(',')

    const { data, error } = await db
      .from('catalog_products')
      .select('retailer_id, name, description, price, currency, image_url')
      .eq('account_id', accountId)
      .eq('is_stale', false)
      .or(orFilter)
      .limit(k)

    if (error || !Array.isArray(data)) return []
    return (data as CatalogProductRow[]).map(toCandidate)
  } catch (err) {
    console.error('[ai catalog] retrieval failed:', err)
    return []
  }
}

/**
 * Validate a `retailer_id` the model recommended via the `[[PRODUCT:...]]`
 * sentinel against the account's synced catalog before trusting it — the
 * model can hallucinate an id or reference a since-removed product.
 * Returns null on any failure or when the product isn't found / is stale.
 */
export async function resolveCatalogProduct(
  db: SupabaseClient,
  accountId: string,
  retailerId: string,
): Promise<CatalogProductCandidate | null> {
  if (!retailerId.trim()) return null
  try {
    const { data, error } = await db
      .from('catalog_products')
      .select('retailer_id, name, description, price, currency, image_url')
      .eq('account_id', accountId)
      .eq('retailer_id', retailerId)
      .eq('is_stale', false)
      .maybeSingle()
    if (error || !data) return null
    return toCandidate(data as CatalogProductRow)
  } catch (err) {
    console.error('[ai catalog] resolve failed:', err)
    return null
  }
}
