// ============================================================
// GET /api/v1/metrics?days=60 — aggregated WhatsApp and bot numbers
//                                (scope: metrics:read).
//
// Per local day: conversations, customer messages, WhatsApp and web
// orders, orders the bot confirmed on its own, handoffs to a person.
// Plus, over the last 30 days: most requested products, customer
// messages per hour and the median first response. Only numbers —
// never phones, names or message text.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context'
import { ok, toApiErrorResponse } from '@/lib/api/v1/respond'
import { loadFerrobotMetrics } from '@/lib/dashboard/ferrobot-metrics-data'

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'metrics:read')
    const asked = Math.round(Number(new URL(request.url).searchParams.get('days') ?? 60))
    const days = Number.isFinite(asked) ? Math.min(90, Math.max(1, asked)) : 60
    return ok(await loadFerrobotMetrics(ctx.supabase, ctx.accountId, days))
  } catch (err) {
    return toApiErrorResponse(err)
  }
}
