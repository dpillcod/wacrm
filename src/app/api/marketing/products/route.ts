import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { searchShop } from '@/lib/catalog/shop-search'

// GET /api/marketing/products?q= → { items }
//   The web shop's products (photo, price) to put on an ad image. Admins only.

export async function GET(request: Request) {
  let ctx
  try {
    ctx = await requireRole('admin')
  } catch (err) {
    return toErrorResponse(err)
  }
  const q = (new URL(request.url).searchParams.get('q') ?? '').slice(0, 80)
  try {
    const { items } = await searchShop(supabaseAdmin(), ctx.accountId, { q, sort: 'pop' })
    return NextResponse.json({ items })
  } catch (err) {
    console.error('[marketing] product search failed:', err)
    return NextResponse.json({ error: 'search_failed' }, { status: 500 })
  }
}
