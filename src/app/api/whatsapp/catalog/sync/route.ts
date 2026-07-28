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

    const products: MetaCatalogProduct[] = []
    let nextUrl:
      | string
      | null = `${META_API_BASE}/${config.catalog_id}/products?limit=100&fields=id,retailer_id,name,description,price,currency,availability,image_url`
    const PAGE_CAP = 20
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
        return NextResponse.json({ error: metaErr }, { status: 502 })
      }

      const metaBody: {
        data?: MetaCatalogProduct[]
        paging?: { next?: string }
      } = await metaRes.json()
      if (metaBody.data) products.push(...metaBody.data)
      nextUrl = metaBody.paging?.next ?? null
    }

    let inserted = 0
    let updated = 0
    const errors: { retailer_id: string; message: string }[] = []
    const syncedRetailerIds: string[] = []

    for (const p of products) {
      const retailerId = p.retailer_id ?? p.id
      syncedRetailerIds.push(retailerId)

      const row = {
        account_id: accountId,
        retailer_id: retailerId,
        meta_product_id: p.id,
        name: p.name,
        description: p.description ?? null,
        price: parsePrice(p.price),
        currency: p.currency ?? null,
        availability: p.availability ?? null,
        image_url: p.image_url ?? null,
        is_stale: false,
        updated_at: new Date().toISOString(),
      }

      const { data: existing, error: lookupErr } = await supabase
        .from('catalog_products')
        .select('id')
        .eq('account_id', accountId)
        .eq('retailer_id', retailerId)
        .maybeSingle()

      if (lookupErr) {
        errors.push({ retailer_id: retailerId, message: lookupErr.message })
        continue
      }

      if (existing?.id) {
        const { error: updErr } = await supabase
          .from('catalog_products')
          .update(row)
          .eq('id', existing.id)
        if (updErr) {
          errors.push({ retailer_id: retailerId, message: updErr.message })
        } else {
          updated++
        }
      } else {
        const { error: insErr } = await supabase
          .from('catalog_products')
          .insert(row)
        if (insErr) {
          errors.push({ retailer_id: retailerId, message: insErr.message })
        } else {
          inserted++
        }
      }
    }

    // Mark anything not seen in this sync as stale, rather than
    // deleting it — a message already sent still references its id.
    // Diffed client-side (not a `.not(..., 'in', ...)` filter) so an
    // arbitrary retailer_id from Meta can never be mis-parsed as
    // PostgREST filter syntax.
    const { data: existingRows } = await supabase
      .from('catalog_products')
      .select('id, retailer_id')
      .eq('account_id', accountId)
    const syncedSet = new Set(syncedRetailerIds)
    const staleIds = (existingRows ?? [])
      .filter((row) => !syncedSet.has(row.retailer_id))
      .map((row) => row.id)
    if (staleIds.length > 0) {
      await supabase
        .from('catalog_products')
        .update({ is_stale: true })
        .in('id', staleIds)
    }

    return NextResponse.json({
      success: errors.length === 0,
      total: products.length,
      inserted,
      updated,
      errors,
      truncated: pageCount >= PAGE_CAP && nextUrl !== null,
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
