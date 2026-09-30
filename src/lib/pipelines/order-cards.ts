import type { SupabaseClient } from '@supabase/supabase-js'
import { ORDER_PIPELINE_NAME } from './order-stages'

// ============================================================
// Server-side helpers for the order board (see order-stages.ts):
// creating/updating an order's card, checking whether a customer can
// still be messaged for free, and in-app notifications for the team.
// All take the service-role client and are best-effort — a board or
// notification hiccup must never break an order.
// ============================================================

export async function findOrderPipeline(
  db: SupabaseClient,
  accountId: string,
): Promise<{ pipelineId: string; firstStageId: string } | null> {
  const { data: pipeline } = await db
    .from('pipelines')
    .select('id')
    .eq('account_id', accountId)
    .eq('name', ORDER_PIPELINE_NAME)
    .limit(1)
    .maybeSingle()
  if (!pipeline) return null
  const { data: stage } = await db
    .from('pipeline_stages')
    .select('id')
    .eq('pipeline_id', (pipeline as { id: string }).id)
    .order('position', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (!stage) return null
  return { pipelineId: (pipeline as { id: string }).id, firstStageId: (stage as { id: string }).id }
}

/**
 * Create the order's card in the first column of "Pedidos", or — when
 * `dealId` is given (a web order's card made when the order arrived) —
 * refresh its notes with what the flow learned since. Returns the card
 * id, or null when there's no order board or the write failed.
 */
export async function upsertOrderCard(
  db: SupabaseClient,
  args: {
    accountId: string
    userId: string
    contactId: string
    conversationId: string | null
    dealId?: string | null
    title: string
    notes: string
    value?: number
  },
): Promise<string | null> {
  try {
    if (args.dealId) {
      const { error } = await db
        .from('deals')
        .update({ notes: args.notes, updated_at: new Date().toISOString() })
        .eq('id', args.dealId)
        .eq('account_id', args.accountId)
      if (!error) return args.dealId
      console.error('[order-cards] update failed:', error.message)
      return null
    }
    const board = await findOrderPipeline(db, args.accountId)
    if (!board) return null
    const { data, error } = await db
      .from('deals')
      .insert({
        account_id: args.accountId,
        user_id: args.userId,
        pipeline_id: board.pipelineId,
        stage_id: board.firstStageId,
        contact_id: args.contactId,
        conversation_id: args.conversationId,
        title: args.title.slice(0, 200),
        notes: args.notes,
        value: args.value && Number.isFinite(args.value) ? args.value : 0,
        currency: 'USD',
        status: 'open',
      })
      .select('id')
      .single()
    if (error || !data) {
      console.error('[order-cards] insert failed:', error?.message)
      return null
    }
    return (data as { id: string }).id
  } catch (err) {
    console.error('[order-cards] upsert threw:', err)
    return null
  }
}

const WINDOW_MS = 24 * 3_600_000

/**
 * Whether the customer wrote in this conversation within 24h — inside
 * that window a normal WhatsApp message is free (and, with no Meta
 * payment method, the only kind that's delivered at all).
 */
export async function customerWindowOpen(
  db: SupabaseClient,
  conversationId: string,
): Promise<boolean> {
  const { count } = await db
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'customer')
    .gte('created_at', new Date(Date.now() - WINDOW_MS).toISOString())
  return (count ?? 0) > 0
}

/** One in-app notification per account member (plus any extra users). */
export async function notifyAccountInApp(
  db: SupabaseClient,
  args: {
    accountId: string
    conversationId: string | null
    contactId: string | null
    title: string
    body: string
    extraUserIds?: string[]
  },
): Promise<string | null> {
  const { data: members } = await db
    .from('profiles')
    .select('user_id')
    .eq('account_id', args.accountId)
  const userIds = new Set<string>(args.extraUserIds ?? [])
  for (const m of (members ?? []) as { user_id: string | null }[]) {
    if (m.user_id) userIds.add(m.user_id)
  }
  if (userIds.size === 0) return null
  const { error } = await db.from('notifications').insert(
    [...userIds].map((userId) => ({
      account_id: args.accountId,
      user_id: userId,
      type: 'conversation_assigned',
      conversation_id: args.conversationId,
      contact_id: args.contactId,
      title: args.title,
      body: args.body.slice(0, 1000),
    })),
  )
  return error ? error.message : null
}
