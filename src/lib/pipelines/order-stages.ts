import { renderText, type BusinessSettings } from '../business/settings'

// ============================================================
// The store's order board: a pipeline named "Pedidos" whose cards are
// orders (from WhatsApp or the web shop). Moving a card to some stages
// messages the customer — free only while their 24h WhatsApp window is
// open (they wrote in the last 24h); otherwise staff are told to call.
// Stage names are matched loosely (accents/case ignored), so renaming a
// column in the UI keeps working as long as the words stay. The board's
// name and every customer message come from the business settings.
// ============================================================

/** Columns for a new order board. */
export const ORDER_STAGES: { name: string; color: string }[] = [
  { name: 'Nuevo', color: '#3b82f6' },
  { name: 'Cotizado', color: '#8b5cf6' },
  { name: 'Pagado', color: '#10b981' },
  { name: 'Listo / En camino', color: '#f59e0b' },
  { name: 'Entregado', color: '#16a34a' },
  { name: 'Cancelado', color: '#ef4444' },
]

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export type OrderStageKind = 'new' | 'quoted' | 'paid' | 'ready' | 'delivered' | 'cancelled'

export function orderStageKind(stageName: string): OrderStageKind | null {
  const n = normalize(stageName)
  if (n.startsWith('nuevo')) return 'new'
  if (n.startsWith('cotiz')) return 'quoted'
  if (n.startsWith('pagad')) return 'paid'
  if (n.includes('listo') || n.includes('camino')) return 'ready'
  if (n.startsWith('entregad')) return 'delivered'
  if (n.startsWith('cancel')) return 'cancelled'
  return null
}

/** "Pedido N° 0015 — Juan" → "N° 0015"; "" when the title has none. */
export function orderRefFromTitle(title: string): string {
  const m = title.match(/N[°º]\s*\S+/)
  return m ? m[0] : ''
}

/** What the customer is told when their card reaches this stage, if anything. */
export function stageMessage(
  kind: OrderStageKind | null,
  orderRef: string,
  biz: BusinessSettings,
): string | null {
  const m = biz.orderBoard.messages
  const template =
    kind === 'paid' ? m.paid
      : kind === 'ready' ? m.ready
        : kind === 'delivered' ? m.delivered
          : kind === 'cancelled' ? m.cancelled
            // New and quoted: staff talk to the customer themselves (/total).
            : ''
  return template.trim() ? renderText(template, { pedido: orderRef }) : null
}

/** Reply to "¿dónde está mi pedido?" for an order in this column. */
export function statusReply(kind: OrderStageKind | null, orderRef: string, biz: BusinessSettings): string {
  const r = biz.orderBoard.statusReplies
  const template = kind ? r[kind] : r.new
  return renderText(template, { pedido: orderRef })
}

/**
 * Whether a customer's message asks where their order is ("¿dónde está
 * mi pedido?", "¿cuándo llega mi compra?", "estado de mi orden"). Needs
 * an order word AND a status word, and stays short — "quiero hacer un
 * pedido" or a whole shopping list is not a status question.
 */
export function isOrderStatusQuestion(text: string): boolean {
  const t = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!t || t.length > 90) return false
  if (!/\b(pedido|pedidos|orden|compra|encargo)\b/.test(t)) return false
  return /\b(donde|estado|cuando llega|a que hora llega|ya llega|llego|ya viene|ya sale|salio|como va|en que va|que paso con|ya esta|esta listo|demora|tarda|seguimiento|rastrear|no llega|no ha llegado)\b/.test(
    t,
  )
}

// ---- Home services board ("Servicios") ---------------------------------

/** Columns for a new service board. */
export const SERVICE_STAGES: { name: string; color: string }[] = [
  { name: 'Solicitud', color: '#3b82f6' },
  { name: 'Visita agendada', color: '#06b6d4' },
  { name: 'Cotizado', color: '#8b5cf6' },
  { name: 'Aprobado', color: '#10b981' },
  { name: 'En camino / En trabajo', color: '#f59e0b' },
  { name: 'Terminado', color: '#16a34a' },
  { name: 'Cancelado', color: '#ef4444' },
]

export type ServiceStageKind =
  | 'new'
  | 'scheduled'
  | 'quoted'
  | 'approved'
  | 'working'
  | 'done'
  | 'cancelled'

export function serviceStageKind(stageName: string): ServiceStageKind | null {
  const n = normalize(stageName)
  if (n.startsWith('solicitud') || n.startsWith('nuevo')) return 'new'
  if (n.includes('agend') || n.startsWith('visita')) return 'scheduled'
  if (n.startsWith('cotiz')) return 'quoted'
  if (n.startsWith('aprob')) return 'approved'
  if (n.includes('camino') || n.includes('trabajo')) return 'working'
  if (n.startsWith('termin') || n.startsWith('finaliz') || n.startsWith('entregad')) return 'done'
  if (n.startsWith('cancel')) return 'cancelled'
  return null
}

/** What the customer is told when their service card reaches this column, if anything. */
export function serviceStageMessage(
  kind: ServiceStageKind | null,
  serviceRef: string,
  biz: BusinessSettings,
): string | null {
  const m = biz.serviceBoard.messages
  const template =
    kind === 'scheduled' ? m.scheduled
      : kind === 'working' ? m.working
        : kind === 'done' ? m.done
          : kind === 'cancelled' ? m.cancelled
            // New, quoted, approved: the technician talks to the customer.
            : ''
  return template.trim() ? renderText(template, { servicio: serviceRef }) : null
}

// ---- Satisfaction survey, sent with the "delivered" message ----------

export const CSAT_OPTIONS = [
  { key: 'excelente', title: '⭐ Excelente' },
  { key: 'bien', title: '👍 Bien' },
  { key: 'mal', title: '👎 Mal' },
] as const

export type CsatKey = (typeof CSAT_OPTIONS)[number]['key']

const CSAT_PREFIX = 'csat_'

export function csatReplyId(key: CsatKey, dealId: string): string {
  return `${CSAT_PREFIX}${key}:${dealId}`
}

export function parseCsatReplyId(replyId: string): { key: CsatKey; dealId: string } | null {
  const m = replyId.match(/^csat_(excelente|bien|mal):(.+)$/)
  return m ? { key: m[1] as CsatKey, dealId: m[2] } : null
}

export function csatThanks(key: CsatKey, biz: BusinessSettings): string {
  const b = biz.orderBoard
  if (key === 'mal') return b.csatBad
  // Happy customers are the ones worth asking for a public review — only
  // when the business has set its review link.
  if (key === 'excelente' && biz.googleReviewUrl) {
    return renderText(b.csatExcellent, { resena: biz.googleReviewUrl })
  }
  return b.csatGood
}
