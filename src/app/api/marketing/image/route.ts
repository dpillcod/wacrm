import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'

// GET /api/marketing/image?url=<a product photo of the web shop>
//   The photo served from our own origin, so the ad maker can draw it on
//   a canvas and export the PNG (the shop doesn't send CORS headers).
//   Only photos of the account's own products are fetched. Admins only.

const MAX_BYTES = 8 * 1024 * 1024

export async function GET(request: Request) {
  let ctx
  try {
    ctx = await requireRole('admin')
  } catch (err) {
    return toErrorResponse(err)
  }
  const url = new URL(request.url).searchParams.get('url') ?? ''
  if (!/^https:\/\//i.test(url)) return NextResponse.json({ error: 'bad_url' }, { status: 400 })
  const { data: product } = await supabaseAdmin()
    .from('shop_products')
    .select('sku')
    .eq('account_id', ctx.accountId)
    .eq('image_url', url)
    .limit(1)
    .maybeSingle()
  if (!product) return NextResponse.json({ error: 'not_a_product_photo' }, { status: 404 })
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
    const type = res.headers.get('content-type') ?? ''
    if (!res.ok || !type.startsWith('image/')) {
      return NextResponse.json({ error: 'fetch_failed' }, { status: 502 })
    }
    const body = await res.arrayBuffer()
    if (body.byteLength > MAX_BYTES) return NextResponse.json({ error: 'too_large' }, { status: 413 })
    return new NextResponse(body, {
      headers: { 'content-type': type, 'cache-control': 'private, max-age=3600' },
    })
  } catch (err) {
    console.error('[marketing] image fetch failed:', err)
    return NextResponse.json({ error: 'fetch_failed' }, { status: 502 })
  }
}
