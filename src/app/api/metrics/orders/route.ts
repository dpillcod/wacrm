import { NextResponse } from 'next/server'
import { loadBusinessSettings } from '@/lib/business/settings'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import {
  csatCounts,
  dailyOrderSeries,
  satisfactionPct,
  topProducts,
  webOrderLines,
  whatsappOrderLines,
  type OrdersMetrics,
} from '@/lib/dashboard/orders-metrics'

// GET /api/metrics/orders?days=7|30|90
//
// Numbers for the dashboard's orders panel: orders per day by channel
// (WhatsApp orders = handoffs at the flows' order-card nodes; web
// orders = WooCommerce orders received), the WhatsApp order funnel,
// orders that needed staff reminders, delivery-survey ratings, the
// most requested products and where contacts came from. Admin only.

const ALLOWED_DAYS = new Set([7, 30, 90])

type RunRow = { id: string; flow_id: string; started_at: string; vars: Record<string, unknown> }

export async function GET(request: Request) {
  let ctx
  try {
    ctx = await requireRole('admin')
  } catch (err) {
    return toErrorResponse(err)
  }
  const daysParam = Number(new URL(request.url).searchParams.get('days') ?? 30)
  const days = ALLOWED_DAYS.has(daysParam) ? daysParam : 30
  const since = new Date(Date.now() - days * 86_400_000).toISOString()
  const db = supabaseAdmin()
  const accountId = ctx.accountId

  const [{ data: config }, { data: flows }] = await Promise.all([
    db.from('whatsapp_config').select('woocommerce_order_flow_id').eq('account_id', accountId).maybeSingle(),
    db.from('flows').select('id, trigger_type').eq('account_id', accountId),
  ])
  const webFlowId = (config?.woocommerce_order_flow_id as string | null) ?? null
  const flowRows = (flows ?? []) as { id: string; trigger_type: string }[]
  const menuFlowIds = flowRows
    .filter((f) => f.id !== webFlowId && (f.trigger_type === 'keyword' || f.trigger_type === 'first_inbound_message'))
    .map((f) => f.id)

  // Nodes that put an order on the board: a handoff there = one order.
  // (A card on the service board is a home-service request, not an order.)
  const { data: orderNodes } = await db
    .from('flow_nodes')
    .select('flow_id, node_key, config')
    .in('flow_id', flowRows.map((f) => f.id))
    .eq('config->>create_order_card', 'true')
  const orderNodeKeys = new Set(
    ((orderNodes ?? []) as { flow_id: string; node_key: string; config: { card_board?: string } }[])
      .filter((n) => n.config?.card_board !== 'services')
      .map((n) => `${n.flow_id}|${n.node_key}`),
  )

  // WhatsApp orders: handoffs at order-card nodes outside the web flow.
  const { data: handoffs } = await db
    .from('flow_run_events')
    .select('created_at, node_key, flow_runs!inner(account_id, flow_id, vars)')
    .eq('event_type', 'handoff')
    .eq('flow_runs.account_id', accountId)
    .gte('created_at', since)
    .limit(5000)
  const whatsappDates: string[] = []
  const lines: string[] = []
  for (const h of (handoffs ?? []) as unknown as Array<{
    created_at: string
    node_key: string
    flow_runs: { flow_id: string; vars: Record<string, unknown> }
  }>) {
    if (h.flow_runs.flow_id === webFlowId) continue
    if (!orderNodeKeys.has(`${h.flow_runs.flow_id}|${h.node_key}`)) continue
    whatsappDates.push(h.created_at)
    lines.push(...whatsappOrderLines(h.flow_runs.vars.order_text))
  }

  // Web orders: every WooCommerce order starts one run of the web flow.
  const webRuns: RunRow[] = []
  if (webFlowId) {
    const { data } = await db
      .from('flow_runs')
      .select('id, flow_id, started_at, vars')
      .eq('flow_id', webFlowId)
      .gte('started_at', since)
      .limit(5000)
    webRuns.push(...((data ?? []) as RunRow[]))
  }
  for (const r of webRuns) lines.push(...webOrderLines(r.vars.order_items_summary))

  // Funnel over the menu flows' runs in the period.
  const { data: menuRunsData } = menuFlowIds.length
    ? await db
        .from('flow_runs')
        .select('id, flow_id, started_at, vars')
        .in('flow_id', menuFlowIds)
        .gte('started_at', since)
        .limit(5000)
    : { data: [] }
  const menuRuns = (menuRunsData ?? []) as RunRow[]
  const has = (v: unknown) => typeof v === 'string' && v.trim().length > 0

  // Orders whose customer had to be chased: staff reminders went out.
  const needingReminder = [...menuRuns, ...webRuns].filter(
    (r) => ((r.vars.__follow_up as { reminded?: number } | undefined)?.reminded ?? 0) > 0,
  ).length

  const [{ data: rated }, { data: originTags }] = await Promise.all([
    db
      .from('deals')
      .select('notes')
      .eq('account_id', accountId)
      .gte('updated_at', since)
      .ilike('notes', '%Calificación del cliente%')
      .limit(5000),
    db.from('tags').select('id, name').eq('account_id', accountId).ilike('name', 'Origen:%'),
  ])
  const csat = csatCounts(((rated ?? []) as { notes: string | null }[]).map((d) => d.notes))

  const origins: OrdersMetrics['origins'] = []
  for (const tag of (originTags ?? []) as { id: string; name: string }[]) {
    const { count } = await db
      .from('contact_tags')
      .select('contact_id', { count: 'exact', head: true })
      .eq('tag_id', tag.id)
    origins.push({ tag: tag.name.replace(/^Origen:\s*/, ''), contacts: count ?? 0 })
  }
  origins.sort((a, b) => b.contacts - a.contacts)

  const metrics: OrdersMetrics = {
    days,
    daily: dailyOrderSeries(
      days,
      whatsappDates,
      webRuns.map((r) => r.started_at),
      new Date(),
      (await loadBusinessSettings(db, accountId)).utcOffsetHours,
    ),
    totals: { whatsapp: whatsappDates.length, web: webRuns.length },
    funnel: [
      { key: 'wrote', count: menuRuns.length },
      { key: 'started', count: menuRuns.filter((r) => has(r.vars.order_text)).length },
      { key: 'confirmed', count: menuRuns.filter((r) => has(r.vars.ask_billing_type_choice)).length },
      { key: 'handedOff', count: whatsappDates.length },
    ],
    needingReminder,
    csat,
    satisfactionPct: satisfactionPct(csat),
    topProducts: topProducts(lines, 10),
    origins,
  }
  return NextResponse.json(metrics)
}
