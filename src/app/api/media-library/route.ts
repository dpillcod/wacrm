import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { loadBusinessSettings } from '@/lib/business/settings'
import { localDate } from '@/lib/business/seasonal-replies'
import { listLibrary } from '@/lib/media/library'

// GET    /api/media-library → { items } — pieces ready to send (newest
//        first), for the inbox's 📚 Piezas and the broadcast wizard.
//        Agents and up (they're the ones sending).
// DELETE /api/media-library?id=… → { ok } — take a piece out (archived;
//        a design app can leave it again). Admins only.

export async function GET() {
  let ctx
  try {
    ctx = await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }
  const db = supabaseAdmin()
  const biz = await loadBusinessSettings(db, ctx.accountId)
  try {
    return NextResponse.json({ items: await listLibrary(db, ctx.accountId, localDate(biz.utcOffsetHours)) })
  } catch (err) {
    console.error('[media-library] list failed:', err)
    return NextResponse.json({ error: 'list_failed' }, { status: 500 })
  }
}

export async function DELETE(request: Request) {
  let ctx
  try {
    ctx = await requireRole('admin')
  } catch (err) {
    return toErrorResponse(err)
  }
  const id = new URL(request.url).searchParams.get('id') ?? ''
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'bad_id' }, { status: 400 })
  const { error } = await supabaseAdmin()
    .from('media_library')
    .update({ archived_at: new Date().toISOString() })
    .eq('id', id)
    .eq('account_id', ctx.accountId)
  if (error) return NextResponse.json({ error: 'archive_failed' }, { status: 500 })
  return NextResponse.json({ ok: true })
}
