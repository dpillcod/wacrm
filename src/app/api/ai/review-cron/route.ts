import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { reviewDueConversations } from '@/lib/ai/conversation-review'

// GET /api/ai/review-cron  (X-Cron-Secret = AUTOMATION_CRON_SECRET)
//
// Reviews customer conversations that ended recently (customer quiet
// for 30 min) for accounts with aiFeatures.reviewConversations on, and
// tells the account's owners/admins about the ones that went wrong.

function cronAuthorized(request: Request): boolean {
  const expected = process.env.AUTOMATION_CRON_SECRET
  const supplied = request.headers.get('x-cron-secret') ?? ''
  if (!expected || !supplied) return false
  const a = Buffer.from(supplied)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export async function GET(request: Request) {
  if (!cronAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const db = supabaseAdmin()
  const { data: accounts } = await db.from('business_settings').select('account_id')
  const results: Record<string, unknown> = {}
  for (const { account_id: accountId } of (accounts ?? []) as { account_id: string }[]) {
    try {
      const { data: admins } = await db
        .from('profiles')
        .select('user_id')
        .eq('account_id', accountId)
        .in('account_role', ['owner', 'admin'])
      const userIds = ((admins ?? []) as { user_id: string | null }[]).map((a) => a.user_id).filter((u): u is string => !!u)
      results[accountId] = await reviewDueConversations(db, accountId, async (n) => {
        if (!userIds.length) return
        const { error } = await db.from('notifications').insert(
          userIds.map((user_id) => ({
            account_id: accountId,
            user_id,
            type: 'conversation_assigned',
            conversation_id: n.conversationId,
            contact_id: n.contactId,
            title: n.title,
            body: n.body,
          })),
        )
        if (error) console.error('[review-cron] notify failed:', error.message)
      })
    } catch (err) {
      console.error('[review-cron] failed for', accountId, err)
      results[accountId] = { error: true }
    }
  }
  return NextResponse.json({ results })
}
