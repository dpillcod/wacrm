import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { decrypt } from '@/lib/whatsapp/encryption'

/**
 * Sync product catalog from Meta Commerce Manager → local
 * catalog_products table. Mirrors templates/sync/route.ts's shape.
 *
 * Products removed from the catalog are NOT deleted locally — they're
 * marked `is_stale` so an in-flight message still referencing one
 * doesn't break, and so the picker/AI can exclude them going forward.
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

/** Meta returns price as a formatted string (e.g. "12.99 USD" or "1299"). */
function parsePrice(raw: string | undefined): number | null {
  if (!raw) return null
  const match = raw.match(/[\d.]+/)
  if (!match) return null
  const value = Number.parseFloat(match[0])
  return Number.isFinite(value) ? value : null
}

export async function POST() {
  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('account_id')
      .eq('user_id', user.id)
      .maybeSingle()
    const accountId = profile?.account_id as string | undefined
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
    }

    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)
      .single()

    if (configError || !config) {
      return NextResponse.json(
        {
          error:
            'WhatsApp not configured. Connect your WhatsApp Business account in Settings first.',
        },
        { status: 400 },
      )
    }

    if (!config.catalog_id) {
      return NextResponse.json(
        {
          error:
            'No catalog connected. Add your Meta Commerce Manager Catalog ID in Settings first.',
        },
        { status: 400 },
      )
    }

    const accessToken = decrypt(config.access_token)

    // Resume a prior run's pagination instead of restarting at page 1
    // every time — large catalogs need many calls to fully walk, since
    // PAGE_CAP bounds how much one request does.
    const isResuming = Boolean(config.catalog_sync_cursor)
    const syncStartedAt = isResuming
      ? (config.catalog_sync_started_at as string)
      : new Date().toISOString()

    const products: MetaCatalogProduct[] = []
    let nextUrl: string | null =
      (config.catalog_sync_cursor as string | null) ??
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
        return NextResponse.json({ error: metaErr }, { status: 400 })
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
    const { data: preExistingRows } = await supabase
      .from('catalog_products')
      .select('retailer_id')
      .eq('account_id', accountId)
    const preExistingSet = new Set(
      (preExistingRows ?? []).map((row) => row.retailer_id),
    )
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
      const { error: upsertErr } = await supabase
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
      await supabase
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
      const { data: staleRows } = await supabase
        .from('catalog_products')
        .select('id')
        .eq('account_id', accountId)
        .lt('updated_at', syncStartedAt)
      const staleIds = (staleRows ?? []).map((row) => row.id)
      if (staleIds.length > 0) {
        await supabase
          .from('catalog_products')
          .update({ is_stale: true })
          .in('id', staleIds)
      }

      await supabase
        .from('whatsapp_config')
        .update({ catalog_sync_cursor: null, catalog_sync_started_at: null })
        .eq('account_id', accountId)
    }

    return NextResponse.json({
      success: errors.length === 0,
      total: products.length,
      inserted,
      updated,
      errors,
      truncated,
    })
  } catch (error) {
    console.error('Error syncing WhatsApp catalog products:', error)
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : 'Failed to sync catalog',
      },
      { status: 500 },
    )
  }
}
