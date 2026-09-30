/**
 * Browser side of an order card changing column: asks the server to
 * message the customer if that column does (see
 * /api/pipelines/deals/[id]/stage-changed). Returns what happened so
 * the caller can tell staff — above all when the customer couldn't be
 * messaged for free and needs a call instead. Never throws.
 */
export type StageChangeOutcome = 'notified' | 'call_customer' | 'send_failed' | 'nothing'

export async function notifyStageChange(dealId: string): Promise<StageChangeOutcome> {
  try {
    const res = await fetch(`/api/pipelines/deals/${dealId}/stage-changed`, { method: 'POST' })
    if (!res.ok) return 'nothing'
    const body = (await res.json()) as { sent?: boolean; reason?: string }
    if (body.sent) return 'notified'
    if (body.reason === 'window_closed') return 'call_customer'
    if (body.reason === 'send_failed') return 'send_failed'
    return 'nothing'
  } catch {
    return 'nothing'
  }
}
