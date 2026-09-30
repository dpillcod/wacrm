import type { SupabaseClient } from '@supabase/supabase-js'

// ============================================================
// Where a contact came from — so the store can see which channel
// actually brings customers (ads, its Facebook/Instagram posts, the
// web shop). Recorded as a tag (filterable in Contacts, visible in
// the inbox) plus, for ads, a contact note with the ad's headline and
// link.
//
// Meta attaches a `referral` object to the first message a person
// sends after tapping a Click-to-WhatsApp ad or post. Those chats also
// open Meta's 72h Free Entry Point window, where every message the
// store sends is free.
// ============================================================

export interface MetaReferral {
  source_url?: string
  source_id?: string
  /** "ad" | "post" (Meta may add more). */
  source_type?: string
  headline?: string
  body?: string
  ctwa_clid?: string
}

export const WEB_ORIGIN_TAG = 'Origen: Página web'

/** "Origen: Anuncio Facebook", "Origen: Publicación Instagram", … */
export function originTagName(referral: MetaReferral): string {
  const kind = referral.source_type === 'post' ? 'Publicación' : 'Anuncio'
  const url = referral.source_url ?? ''
  const network = /instagram\.com/i.test(url)
    ? 'Instagram'
    : /facebook\.com|fb\.me|fb\.watch/i.test(url)
      ? 'Facebook'
      : 'Meta'
  return `Origen: ${kind} ${network}`
}

export function originNote(referral: MetaReferral): string {
  const kind = referral.source_type === 'post' ? 'una publicación' : 'un anuncio'
  const headline = referral.headline?.trim() ? ` «${referral.headline.trim()}»` : ''
  const link = referral.source_url ? `\n${referral.source_url}` : ''
  return `📣 Escribió desde ${kind}${headline}.${link}`
}

/** Find or create the account's tag by name and put it on the contact. */
export async function tagContact(
  db: SupabaseClient,
  args: { accountId: string; userId: string; contactId: string; tagName: string; color?: string },
): Promise<void> {
  const { data: existing } = await db
    .from('tags')
    .select('id')
    .eq('account_id', args.accountId)
    .eq('name', args.tagName)
    .limit(1)
    .maybeSingle()
  let tagId = (existing as { id: string } | null)?.id
  if (!tagId) {
    const { data: created, error } = await db
      .from('tags')
      .insert({
        account_id: args.accountId,
        user_id: args.userId,
        name: args.tagName,
        color: args.color ?? '#8b5cf6',
      })
      .select('id')
      .single()
    if (error || !created) {
      console.error('[origin] tag create failed:', error?.message)
      return
    }
    tagId = (created as { id: string }).id
  }
  const { error: linkErr } = await db
    .from('contact_tags')
    .upsert({ contact_id: args.contactId, tag_id: tagId }, { onConflict: 'contact_id,tag_id' })
  if (linkErr) console.error('[origin] tag link failed:', linkErr.message)
}

/** Best-effort: tag + note for a message that came from an ad/post. */
export async function recordReferralOrigin(
  db: SupabaseClient,
  args: { accountId: string; userId: string; contactId: string; referral: MetaReferral },
): Promise<void> {
  try {
    await tagContact(db, {
      accountId: args.accountId,
      userId: args.userId,
      contactId: args.contactId,
      tagName: originTagName(args.referral),
      color: '#1877f2',
    })
    const { error } = await db.from('contact_notes').insert({
      account_id: args.accountId,
      user_id: args.userId,
      contact_id: args.contactId,
      note_text: originNote(args.referral),
    })
    if (error) console.error('[origin] note insert failed:', error.message)
  } catch (err) {
    console.error('[origin] recordReferralOrigin threw:', err)
  }
}
