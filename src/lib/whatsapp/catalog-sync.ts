import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'

/**
 * Shared core of the Meta Commerce Manager → `catalog_products` sync,
 * used by both the authenticated "Sync now" button
 * (`/api/whatsapp/catalog/sync`, one account — the caller's own) and
 * the unattended cron sweep (`/api/whatsapp/catalog/cron-sync`, all
 * accounts with a catalog connected). Kept here rather than duplicated
 * so a fix to pagination/stale-marking/price-parsing only needs to
 * happen once.
 */

const META_API_VERSION = 'v21.0'
const META_API_BASE = `https://graph.facebook.com/${META_API_VERSION}`

interface MetaCatalogProduct {
  id: string
  retailer_id?: string
  name: string
  description?: string
  price?: string
  currency?: string
  availability?: string
  image_url?: string
}

export interface CatalogSyncResult {
  success: boolean
  total: number
  inserted: number
  updated: number
  errors: { retailer_id: string; message: string }[]
  truncated: boolean
}

export interface CatalogSyncError {
  error: string
  status: number
}

/**
 * Meta returns price as a locale-formatted string — e.g. "12.99 USD"
 * for an English-locale catalog, but "$6,20" (comma decimal
 * separator) for a Spanish-locale one. A naive `[\d.]+` match on the
 * latter silently truncated at the comma, dropping the cents
 * entirely (6,20 -> 6). Handles both single-separator cases and the
 * "thousands + decimal" case by treating whichever of , or . appears
 * LAST as the decimal separator.
 */
function parsePrice(raw: string | undefined): number | null {
  if (!raw) return null
  const match = raw.match(/[\d.,]+/)
  if (!match) return null
  let numStr = match[0]
  const hasComma = numStr.includes(',')
  const hasDot = numStr.includes('.')
  if (hasComma && hasDot) {
    numStr =
      numStr.lastIndexOf(',') > numStr.lastIndexOf('.')
        ? numStr.replace(/\./g, '').replace(',', '.')
        : numStr.replace(/,/g, '')
  } else if (hasComma) {
    numStr = numStr.replace(',', '.')
  }
  const value = Number.parseFloat(numStr)
  return Number.isFinite(value) ? value : null
}

/**
 * Runs one sync "leg" for a single account. A leg walks up to
 * PAGE_CAP pages of the Meta catalog starting from wherever the
 * account's `catalog_sync_cursor` left off; a catalog bigger than
 * that resumes on the next call instead of restarting at page 1.
 * `config` is the account's already-fetched `whatsapp_config` row —
 * callers differ in how they get to it (session lookup vs an
 * admin-client scan of every connected account), not in what happens
 * once they have it.
 */
export async function syncCatalogForAccount(
  db: SupabaseClient,
  accountId: string,
  config: {
    catalog_id: string | null
    access_token: string
    catalog_sync_cursor: string | null
    catalog_sync_started_at: string | null
  },
): Promise<CatalogSyncResult | CatalogSyncError> {
  if (!config.catalog_id) {
    return {
      error:
        'No catalog connected. Add your Meta Commerce Manager Catalog ID in Settings first.',
      status: 400,
    }
  }

  const accessToken = decrypt(config.access_token)

  const isResuming = Boolean(config.catalog_sync_cursor)
  const syncStartedAt = isResuming
    ? config.catalog_sync_started_at!
    : new Date().toISOString()

  const products: MetaCatalogProduct[] = []
  let nextUrl: string | null =
    config.catalog_sync_cursor ??
    `${META_API_BASE}/${config.catalog_id}/products?limit=100&fields=id,retailer_id,name,description,price,currency,availability,image_url`
  const PAGE_CAP = 100
  let pageCount = 0

  while (nextUrl && pageCount < PAGE_CAP) {
    pageCount++
    const metaRes: Response = await fetch(nextUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })

    if (!metaRes.ok) {
      let metaErr = `Meta API error: ${metaRes.status}`
      try {
        const body = await metaRes.json()
        if (body?.error?.message) metaErr = body.error.message
      } catch {
        // response wasn't JSON — keep the fallback
      }
      // Not 502: that status code gets intercepted by some reverse
      // proxies (e.g. Traefik/EasyPanel) and replaced with a generic
      // HTML "Bad Gateway" page, hiding the real Meta error message
      // from the client.
      return { error: metaErr, status: 400 }
    }

    const metaBody: {
      data?: MetaCatalogProduct[]
      paging?: { next?: string }
    } = await metaRes.json()
    if (metaBody.data) products.push(...metaBody.data)
    nextUrl = metaBody.paging?.next ?? null
  }

  const errors: { retailer_id: string; message: string }[] = []
  const syncedRetailerIds = products.map((p) => p.retailer_id ?? p.id)

  // Know insert-vs-update counts up front with a single query, since
  // a bulk upsert doesn't report per-row outcome.
  const { data: preExistingRows } = await db
    .from('catalog_products')
    .select('retailer_id')
    .eq('account_id', accountId)
  const preExistingSet = new Set((preExistingRows ?? []).map((row) => row.retailer_id))
  let inserted = 0
  let updated = 0
  for (const id of syncedRetailerIds) {
    if (preExistingSet.has(id)) updated++
    else inserted++
  }

  const rows = products.map((p) => ({
    account_id: accountId,
    retailer_id: p.retailer_id ?? p.id,
    meta_product_id: p.id,
    name: p.name,
    description: p.description ?? null,
    price: parsePrice(p.price),
    currency: p.currency ?? null,
    availability: p.availability ?? null,
    image_url: p.image_url ?? null,
    is_stale: false,
    updated_at: new Date().toISOString(),
  }))

  // Batched (not one giant upsert) to keep each request body/latency
  // reasonable for large catalogs.
  const BATCH_SIZE = 500
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE)
    const { error: upsertErr } = await db
      .from('catalog_products')
      .upsert(batch, { onConflict: 'account_id,retailer_id' })
    if (upsertErr) {
      for (const row of batch) {
        errors.push({ retailer_id: row.retailer_id, message: upsertErr.message })
        if (preExistingSet.has(row.retailer_id)) updated--
        else inserted--
      }
    }
  }

  const truncated = nextUrl !== null

  if (truncated) {
    // More pages remain — save where we left off so the next call
    // resumes instead of restarting at page 1. Stale-marking waits
    // until the whole catalog has been walked (see below), since a
    // product merely queued in a not-yet-fetched page isn't gone.
    await db
      .from('whatsapp_config')
      .update({
        catalog_sync_cursor: nextUrl,
        catalog_sync_started_at: syncStartedAt,
      })
      .eq('account_id', accountId)
  } else {
    // Reached the end of pagination — this was the last leg of the
    // (possibly multi-request) sync. Anything not touched since
    // syncStartedAt wasn't seen in any page this run, so it's gone
    // from the catalog. Marked stale, never hard-deleted — a message
    // already sent still references its id.
    const { data: staleRows } = await db
      .from('catalog_products')
      .select('id')
      .eq('account_id', accountId)
      .lt('updated_at', syncStartedAt)
    const staleIds = (staleRows ?? []).map((row) => row.id)
    if (staleIds.length > 0) {
      await db.from('catalog_products').update({ is_stale: true }).in('id', staleIds)
    }

    await db
      .from('whatsapp_config')
      .update({ catalog_sync_cursor: null, catalog_sync_started_at: null })
      .eq('account_id', accountId)
  }

  return {
    success: errors.length === 0,
    total: products.length,
    inserted,
    updated,
    errors,
    truncated,
  }
}
