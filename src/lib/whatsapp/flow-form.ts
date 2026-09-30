// ============================================================
// Replies to WhatsApp Flows (in-chat forms). When a customer submits
// a form, Meta sends an interactive message of type "nfm_reply" whose
// `response_json` holds the fields the form's "complete" action put
// in its payload (plus the `flow_token` we sent). These helpers turn
// that into plain field values and a readable summary.
// ============================================================

/** Form fields from an nfm_reply's response_json; null if unreadable. */
export function parseFormReply(responseJson: string | undefined | null): Record<string, string> | null {
  if (!responseJson) return null
  try {
    const raw = JSON.parse(responseJson) as Record<string, unknown>
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(raw)) {
      if (key === 'flow_token' || value === null || value === undefined) continue
      const text = String(value).trim()
      if (text) out[key] = text
    }
    return Object.keys(out).length > 0 ? out : null
  } catch {
    return null
  }
}

/** "Nombre: Ana\nCédula o RUC: 0105…" — labels map field → display name. */
export function formatFormReply(data: Record<string, string>, labels: Record<string, string> = {}): string {
  return Object.entries(data)
    .map(([key, value]) => `${labels[key] ?? key}: ${value}`)
    .join('\n')
}
