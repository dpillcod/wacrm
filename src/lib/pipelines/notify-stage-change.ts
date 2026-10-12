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

export type AppointmentOutcome = {
  /** The customer was told the date / must be called / nothing to say. */
  customer: 'notified' | 'call_customer' | 'send_failed' | 'nothing'
  /** Google Calendar: copied, not set up, or failed. */
  calendar: 'synced' | 'off' | 'failed' | 'nothing'
}

/**
 * Save the card's appointment (ISO, or null to clear) through the server,
 * which copies it to Google Calendar and tells the customer the date when
 * that's free. Never throws.
 */
export async function saveAppointment(
  dealId: string,
  appointmentAt: string | null,
  notify = true,
): Promise<AppointmentOutcome | null> {
  try {
    const res = await fetch(`/api/pipelines/deals/${dealId}/appointment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appointment_at: appointmentAt, notify }),
    })
    if (!res.ok) return null
    const body = (await res.json()) as { calendar?: string; customer?: string }
    return {
      customer:
        body.customer === 'sent'
          ? 'notified'
          : body.customer === 'window_closed'
            ? 'call_customer'
            : body.customer === 'failed'
              ? 'send_failed'
              : 'nothing',
      calendar: body.calendar === 'synced' || body.calendar === 'removed' ? 'synced' : body.calendar === 'failed' ? 'failed' : body.calendar === 'off' ? 'off' : 'nothing',
    }
  } catch {
    return null
  }
}
