import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { engineSendInteractiveButtons, engineSendText } from '@/lib/flows/meta-send'
import { customerWindowOpen } from '@/lib/pipelines/order-cards'
import { loadBusinessSettings } from '@/lib/business/settings'
import {
  CSAT_OPTIONS,
  csatReplyId,
  orderRefFromTitle,
  orderStageKind,
  stageMessage,
} from '@/lib/pipelines/order-stages'

// POST /api/pipelines/deals/:id/stage-changed
//
// Called by the board right after a card was moved (the move itself is
// a direct RLS-scoped update from the browser). On the order board
// ("Pedidos"), some columns message the customer — "✅ su pedido está
// listo", the delivered thanks + satisfaction survey, … — but only when
// that's free: the customer wrote within 24h. Otherwise the response
// says so, and the board tells staff to call instead. Any human moving
// the card also means someone is on it, so pending "¿ya le respondió
// nuestro asesor?" follow-ups for that order stop.
//
// Response: { sent: boolean, reason?: 'not_orders' | 'no_message' |
//             'no_conversation' | 'window_closed' | 'send_failed' }

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  let ctx
  try {
    ctx = await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }
  const db = supabaseAdmin()

  const { data: deal } = await db
    .from('deals')
    .select('id, title, stage_id, pipeline_id, contact_id, conversation_id, account_id')
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .maybeSingle()
  if (!deal) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const [{ data: pipeline }, { data: stage }] = await Promise.all([
    db.from('pipelines').select('name').eq('id', deal.pipeline_id).maybeSingle(),
    db.from('pipeline_stages').select('name').eq('id', deal.stage_id).maybeSingle(),
  ])
  const biz = await loadBusinessSettings(db, ctx.accountId)
  if (pipeline?.name !== biz.orderBoard.pipelineName) {
    return NextResponse.json({ sent: false, reason: 'not_orders' })
  }

  await stopFollowUpsForCard(db, deal.id)

  const kind = orderStageKind(stage?.name ?? '')
  const text = stageMessage(kind, orderRefFromTitle(deal.title), biz)
  if (!text) return NextResponse.json({ sent: false, reason: 'no_message' })
  if (!deal.conversation_id || !deal.contact_id) {
    return NextResponse.json({ sent: false, reason: 'no_conversation' })
  }
  if (!(await customerWindowOpen(db, deal.conversation_id))) {
    return NextResponse.json({ sent: false, reason: 'window_closed' })
  }

  const { data: config } = await db
    .from('whatsapp_config')
    .select('user_id')
    .eq('account_id', ctx.accountId)
    .maybeSingle()
  const sendArgs = {
    accountId: ctx.accountId,
    userId: (config?.user_id as string | undefined) ?? ctx.userId,
    conversationId: deal.conversation_id,
    contactId: deal.contact_id,
  }
  try {
    await engineSendText({ ...sendArgs, text })
    if (kind === 'delivered') {
      await engineSendInteractiveButtons({
        ...sendArgs,
        bodyText: biz.orderBoard.csatQuestion,
        buttons: CSAT_OPTIONS.map((o) => ({ id: csatReplyId(o.key, deal.id), title: o.title })),
      })
    }
  } catch (err) {
    console.error('[stage-changed] send failed:', err)
    return NextResponse.json({ sent: false, reason: 'send_failed' })
  }
  return NextResponse.json({ sent: true })
}

/** Mark the order's post-handoff follow-ups as done (someone is on it). */
async function stopFollowUpsForCard(db: ReturnType<typeof supabaseAdmin>, dealId: string) {
  const { data: runs } = await db
    .from('flow_runs')
    .select('id, vars')
    .filter('vars->>__deal_id', 'eq', dealId)
  for (const run of (runs ?? []) as { id: string; vars: Record<string, unknown> }[]) {
    const followUp = run.vars.__follow_up as { done?: boolean } | undefined
    if (followUp && !followUp.done) {
      await db
        .from('flow_runs')
        .update({ vars: { ...run.vars, __follow_up: { ...followUp, done: true } } })
        .eq('id', run.id)
    }
  }
}
