// Loads the rows behind GET /api/v1/metrics and aggregates them (see
// ferrobot-metrics.ts). Same order rules as the dashboard's orders panel.

import type { SupabaseClient } from '@supabase/supabase-js'

import { loadBusinessSettings } from '@/lib/business/settings'
import { ferrobotMetrics, type FerrobotMetrics, type MessageRow } from './ferrobot-metrics'
import { webOrderLines, whatsappOrderLines } from './orders-metrics'

const PAGE = 1000

// Engine events that mean "a person was called in" (see engine.ts).
const PERSON_ALERT_REASONS = [
  'trouble_alert',
  'price_request_alerted',
  'human_request_alerted',
  'photo_request_alerted',
  'availability_alerted',
]
const MAX_ROWS = 200_000

async function loadMessages(db: SupabaseClient, accountId: string, since: string): Promise<MessageRow[]> {
  const out: MessageRow[] = []
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    const { data, error } = await db
      .from('messages')
      .select('conversation_id, sender_type, created_at, conversations!inner(account_id)')
      .eq('conversations.account_id', accountId)
      .gte('created_at', since)
      .order('created_at', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw error
    const rows = (data ?? []) as unknown as MessageRow[]
    for (const r of rows) out.push({ conversation_id: r.conversation_id, sender_type: r.sender_type, created_at: r.created_at })
    if (rows.length < PAGE) break
  }
  return out
}

type HandoffRow = {
  event_type: string
  created_at: string
  node_key: string
  flow_runs: { flow_id: string; conversation_id: string | null; vars: Record<string, unknown> }
}

async function loadHandoffs(db: SupabaseClient, accountId: string, since: string): Promise<HandoffRow[]> {
  const out: HandoffRow[] = []
  for (let from = 0; from < 50_000; from += PAGE) {
    const { data, error } = await db
      .from('flow_run_events')
      .select('event_type, created_at, node_key, flow_runs!inner(account_id, flow_id, conversation_id, vars)')
      // A handoff node, or the bot calling a person in (price, "asesor",
      // a photo to check, a troubled conversation…).
      .or(`event_type.eq.handoff,payload->>reason.in.(${PERSON_ALERT_REASONS.join(',')})`)
      .eq('flow_runs.account_id', accountId)
      .gte('created_at', since)
      .order('created_at', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw error
    const rows = (data ?? []) as unknown as HandoffRow[]
    out.push(...rows)
    if (rows.length < PAGE) break
  }
  return out
}

export async function loadFerrobotMetrics(
  db: SupabaseClient,
  accountId: string,
  days: number,
  now: Date = new Date(),
): Promise<FerrobotMetrics> {
  const since = new Date(now.getTime() - days * 86_400_000).toISOString()
  const biz = await loadBusinessSettings(db, accountId)

  const [{ data: config }, { data: flows }] = await Promise.all([
    db.from('whatsapp_config').select('woocommerce_order_flow_id').eq('account_id', accountId).maybeSingle(),
    db.from('flows').select('id').eq('account_id', accountId),
  ])
  const webFlowId = (config?.woocommerce_order_flow_id as string | null) ?? null
  const flowIds = ((flows ?? []) as { id: string }[]).map((f) => f.id)

  // Nodes that put an order on the board (same rule as the dashboard).
  const { data: orderNodes } = flowIds.length
    ? await db
        .from('flow_nodes')
        .select('flow_id, node_key, config')
        .in('flow_id', flowIds)
        .eq('config->>create_order_card', 'true')
    : { data: [] }
  const orderNodeKeys = new Set(
    ((orderNodes ?? []) as { flow_id: string; node_key: string; config: { card_board?: string } }[])
      .filter((n) => n.config?.card_board !== 'services')
      .map((n) => `${n.flow_id}|${n.node_key}`),
  )

  const [messages, handoffRows, webRunsRes] = await Promise.all([
    loadMessages(db, accountId, since),
    loadHandoffs(db, accountId, since),
    webFlowId
      ? db.from('flow_runs').select('started_at, vars').eq('flow_id', webFlowId).gte('started_at', since).limit(10_000)
      : Promise.resolve({ data: [] }),
  ])

  const has = (v: unknown) => typeof v === 'string' && v.trim().length > 0
  const whatsappOrders: { at: string; botConfirmed: boolean; lines: string[] }[] = []
  const handoffs: { at: string; conversationId: string | null }[] = []
  for (const h of handoffRows) {
    if (h.flow_runs.flow_id === webFlowId) continue
    if (h.event_type === 'handoff' && orderNodeKeys.has(`${h.flow_runs.flow_id}|${h.node_key}`)) {
      const v = h.flow_runs.vars ?? {}
      whatsappOrders.push({
        at: h.created_at,
        botConfirmed: has(v.confirm_list_choice) || has(v.ask_billing_type_choice),
        lines: whatsappOrderLines(v.order_text),
      })
    } else {
      handoffs.push({ at: h.created_at, conversationId: h.flow_runs.conversation_id })
    }
  }
  const webOrders = ((webRunsRes.data ?? []) as { started_at: string; vars: Record<string, unknown> }[]).map((r) => ({
    at: r.started_at,
    lines: webOrderLines(r.vars?.order_items_summary),
  }))

  return ferrobotMetrics({ messages, whatsappOrders, webOrders, handoffs }, days, now, biz.utcOffsetHours)
}
