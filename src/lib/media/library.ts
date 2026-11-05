// ============================================================
// Media library — finished pieces (images) a design app leaves in the
// CRM (POST /api/v1/media) so agents send them from the inbox and the
// broadcast wizard without downloading and re-uploading them.
//
// The CRM keeps its own copy (bucket `media-library`, migration 053):
// Meta fetches the image from our URL at send time, and the piece
// still works after the design app moves or deletes its file.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

export const MEDIA_LIBRARY_BUCKET = 'media-library'
/** Meta's cap for images. */
export const LIBRARY_MAX_BYTES = 5 * 1024 * 1024
const DOWNLOAD_TIMEOUT_MS = 20_000

export interface MediaInput {
  imageUrl: string
  name: string
  ref: string | null
  caption: string | null
  tags: string[]
  validUntil: string | null
}

export interface LibraryItem {
  id: string
  source: string
  ref: string | null
  name: string
  caption: string | null
  tags: string[]
  url: string
  mime_type: string
  size_bytes: number
  valid_until: string | null
  created_at: string
  updated_at: string
}

export const LIBRARY_COLUMNS =
  'id, source, ref, name, caption, tags, url, mime_type, size_bytes, valid_until, created_at, updated_at'

const str = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null
  const s = v.trim().slice(0, max)
  return s || null
}

/** An https URL on a public host — never localhost or a bare IP (the server fetches it). */
export function isFetchableUrl(raw: string): boolean {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  if (u.protocol !== 'https:' || u.username || u.password) return false
  const host = u.hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false
  if (/^\d+(\.\d+){3}$/.test(host) || host.includes(':') || host.startsWith('[')) return false
  return host.includes('.')
}

/** Validate the request body; `error` names the first bad field. */
export function parseMediaInput(body: unknown): { input: MediaInput } | { error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Request body must be a JSON object' }
  const b = body as Record<string, unknown>
  const imageUrl = str(b.image_url, 2000)
  if (!imageUrl || !isFetchableUrl(imageUrl)) return { error: '`image_url` must be a public https URL' }
  const name = str(b.name, 120)
  if (!name) return { error: '`name` is required' }
  const ref = str(b.ref, 60)
  if (ref && !/^[\w.-]+$/.test(ref)) return { error: '`ref` may only use letters, digits, ".", "-" and "_"' }

  const tags: string[] = []
  if (b.tags !== undefined) {
    if (!Array.isArray(b.tags) || b.tags.length > 10) return { error: '`tags` must be a list of up to 10 words' }
    for (const t of b.tags) {
      const tag = str(t, 40)?.toLowerCase()
      if (tag && !tags.includes(tag)) tags.push(tag)
    }
  }

  let validUntil: string | null = null
  if (b.valid_until !== undefined && b.valid_until !== null) {
    validUntil = str(b.valid_until, 10)
    if (!validUntil || !/^\d{4}-\d{2}-\d{2}$/.test(validUntil)) return { error: '`valid_until` must be a date (YYYY-MM-DD)' }
  }

  return { input: { imageUrl, name, ref, caption: str(b.caption, 1024), tags, validUntil } }
}

/** The image type from its first bytes (what it really is, not what the server says). */
export function sniffImageType(bytes: Uint8Array): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  ) {
    return 'image/webp'
  }
  return null
}

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' } as const

export class MediaFetchError extends Error {}

/** Download the piece: at most 5 MB, and it must really be a PNG, JPEG or WebP. */
export async function downloadImage(url: string): Promise<{ bytes: Uint8Array; mime: keyof typeof EXT }> {
  let res: Response
  try {
    res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
  } catch {
    throw new MediaFetchError('Could not download `image_url`')
  }
  if (!res.ok || !res.body) throw new MediaFetchError(`Downloading \`image_url\` answered HTTP ${res.status}`)
  const declared = Number(res.headers.get('content-length') ?? 0)
  if (declared > LIBRARY_MAX_BYTES) throw new MediaFetchError('The image is larger than 5 MB')

  const chunks: Uint8Array[] = []
  let total = 0
  const reader = res.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > LIBRARY_MAX_BYTES) {
      await reader.cancel().catch(() => {})
      throw new MediaFetchError('The image is larger than 5 MB')
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    bytes.set(c, at)
    at += c.length
  }
  const mime = sniffImageType(bytes)
  if (!mime) throw new MediaFetchError('`image_url` is not a PNG, JPEG or WebP image')
  return { bytes, mime }
}

/**
 * Store a piece: upload the copy and insert the row — or, when the same
 * source already left this `ref`, replace its image and details (the
 * old file is removed). Returns the stored item and whether it was new.
 */
export async function saveLibraryImage(
  db: SupabaseClient,
  accountId: string,
  source: string,
  input: MediaInput,
  image: { bytes: Uint8Array; mime: keyof typeof EXT },
): Promise<{ item: LibraryItem; created: boolean }> {
  const slug = (input.ref ?? input.name).replace(/[^\w-]+/g, '_').slice(0, 40) || 'pieza'
  const path = `account-${accountId}/${Date.now()}-${slug}.${EXT[image.mime]}`
  const { error: upErr } = await db.storage
    .from(MEDIA_LIBRARY_BUCKET)
    .upload(path, image.bytes, { contentType: image.mime, upsert: false })
  if (upErr) throw new Error(`upload failed: ${upErr.message}`)
  const url = db.storage.from(MEDIA_LIBRARY_BUCKET).getPublicUrl(path).data.publicUrl

  const fields = {
    name: input.name,
    caption: input.caption,
    tags: input.tags,
    url,
    storage_path: path,
    mime_type: image.mime,
    size_bytes: image.bytes.length,
    valid_until: input.validUntil,
    archived_at: null,
    updated_at: new Date().toISOString(),
  }

  const existing = input.ref
    ? (
        await db
          .from('media_library')
          .select('id, storage_path')
          .eq('account_id', accountId)
          .eq('source', source)
          .eq('ref', input.ref)
          .maybeSingle()
      ).data as { id: string; storage_path: string } | null
    : null

  const query = existing
    ? db.from('media_library').update(fields).eq('id', existing.id)
    : db.from('media_library').insert({ ...fields, account_id: accountId, source, ref: input.ref })
  const { data, error } = await query.select(LIBRARY_COLUMNS).single()
  if (error || !data) {
    await db.storage.from(MEDIA_LIBRARY_BUCKET).remove([path])
    throw new Error(`save failed: ${error?.message ?? 'no row'}`)
  }
  if (existing) await db.storage.from(MEDIA_LIBRARY_BUCKET).remove([existing.storage_path])
  return { item: data as LibraryItem, created: !existing }
}

/** Pieces still worth sending: not archived and not past their last day. */
export async function listLibrary(
  db: SupabaseClient,
  accountId: string,
  today: string,
  limit = 60,
): Promise<LibraryItem[]> {
  const { data, error } = await db
    .from('media_library')
    .select(LIBRARY_COLUMNS)
    .eq('account_id', accountId)
    .is('archived_at', null)
    .or(`valid_until.is.null,valid_until.gte.${today}`)
    .order('updated_at', { ascending: false })
    .limit(limit)
  if (error) throw new Error(error.message)
  return (data ?? []) as LibraryItem[]
}
