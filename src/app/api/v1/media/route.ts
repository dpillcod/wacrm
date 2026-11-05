// ============================================================
// /api/v1/media — the media library, for a design app (scope: media:write).
//
// POST   leave a finished piece (an image) ready to send:
//   {
//     "image_url": "https://…/pieza.jpg",  // required — public https, ≤5 MB, PNG/JPEG/WebP
//     "name": "Canastas navideñas — post",  // required
//     "ref": "NAV26-01",                    // optional — the piece's code; the same ref
//                                           //   again replaces the image (no duplicates)
//     "caption": "🎄 …",                    // optional — suggested text to send with it
//     "tags": ["navidad"],                  // optional — up to 10 words
//     "valid_until": "2026-12-24"           // optional — hidden after that day
//   }
//   → 201 (new) / 200 (replaced) { "data": { "media_id", "url", "replaced" } }
//   The CRM keeps its own copy; agents pick it in the inbox (📚 Piezas)
//   and in the broadcast wizard. Nothing is sent to anyone.
// GET    the pieces still available, newest first.
// DELETE ?ref=NAV26-01 — take a piece out of the library (archived).
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context'
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond'
import { loadBusinessSettings } from '@/lib/business/settings'
import { localDate } from '@/lib/business/seasonal-replies'
import { downloadImage, listLibrary, MediaFetchError, parseMediaInput, saveLibraryImage } from '@/lib/media/library'

async function sourceName(ctx: Awaited<ReturnType<typeof requireApiKey>>): Promise<string> {
  const { data } = await ctx.supabase.from('api_keys').select('name').eq('id', ctx.keyId).maybeSingle()
  return ((data as { name?: string } | null)?.name || 'API').slice(0, 80)
}

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'media:write')
    const parsed = parseMediaInput(await request.json().catch(() => null))
    if ('error' in parsed) return fail('bad_request', parsed.error, 400)
    let image
    try {
      image = await downloadImage(parsed.input.imageUrl)
    } catch (err) {
      if (err instanceof MediaFetchError) return fail('bad_request', err.message, 400)
      throw err
    }
    const { item, created } = await saveLibraryImage(ctx.supabase, ctx.accountId, await sourceName(ctx), parsed.input, image)
    return ok({ media_id: item.id, url: item.url, replaced: !created }, created ? 201 : 200)
  } catch (err) {
    return toApiErrorResponse(err)
  }
}

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'media:write')
    const biz = await loadBusinessSettings(ctx.supabase, ctx.accountId)
    const items = await listLibrary(ctx.supabase, ctx.accountId, localDate(biz.utcOffsetHours), 200)
    return ok(items)
  } catch (err) {
    return toApiErrorResponse(err)
  }
}

export async function DELETE(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'media:write')
    const ref = new URL(request.url).searchParams.get('ref')?.trim()
    if (!ref) return fail('bad_request', '`ref` is required', 400)
    const { data, error } = await ctx.supabase
      .from('media_library')
      .update({ archived_at: new Date().toISOString() })
      .eq('account_id', ctx.accountId)
      .eq('source', await sourceName(ctx))
      .eq('ref', ref)
      .is('archived_at', null)
      .select('id')
    if (error) return fail('internal', 'Failed to remove the piece', 500)
    if (!data?.length) return fail('not_found', 'No piece with that ref', 404)
    return ok({ removed: data.length })
  } catch (err) {
    return toApiErrorResponse(err)
  }
}
