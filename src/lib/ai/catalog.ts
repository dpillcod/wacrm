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
    // Trigram similarity (migration 039's `search_catalog_products`)
    // instead of whole-word ILIKE: compares overlapping 3-character
    // chunks rather than requiring an exact substring, so mismatched
    // tokenization ("Nutrileche" vs "NUTRI LECHE") and Spanish
    // singular/plural variants ("camarones" vs "CAMARON") both still
    // match without hand-rolled word-splitting heuristics.
    const { data, error } = await db.rpc('search_catalog_products', {
      p_account_id: accountId,
      p_query: query,
      p_limit: k,
    })

    if (error || !Array.isArray(data)) return []
    return (data as CatalogProductRow[]).map(toCandidate)
  } catch (err) {
    console.error('[ai catalog] retrieval failed:', err)
    return []
  }
}

/**
 * Validate several `retailer_id`s the model recommended via the
 * `[[PRODUCTS:...]]` sentinel — same trust model as
 * `resolveCatalogProduct`, batched into one query. Silently drops any
 * id that doesn't resolve (hallucinated or since-removed) rather than
 * failing the whole list.
 */
export async function resolveCatalogProducts(
  db: SupabaseClient,
  accountId: string,
  retailerIds: string[],
): Promise<CatalogProductCandidate[]> {
  const ids = retailerIds.map((id) => id.trim()).filter(Boolean)
  if (ids.length === 0) return []
  try {
    const { data, error } = await db
      .from('catalog_products')
      .select('retailer_id, name, description, price, currency, image_url')
      .eq('account_id', accountId)
      .eq('is_stale', false)
      .in('retailer_id', ids)
    if (error || !Array.isArray(data)) return []
    return (data as CatalogProductRow[]).map(toCandidate)
  } catch (err) {
    console.error('[ai catalog] batch resolve failed:', err)
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
