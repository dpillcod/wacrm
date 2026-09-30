// ============================================================
// The store's order board: a pipeline named "Pedidos" whose cards are
// orders (from WhatsApp or the web shop). Moving a card to some stages
// messages the customer — free only while their 24h WhatsApp window is
// open (they wrote in the last 24h); otherwise staff are told to call.
// Stage names are matched loosely (accents/case ignored), so renaming a
// column in the UI keeps working as long as the words stay.
// ============================================================

export const ORDER_PIPELINE_NAME = 'Pedidos'

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
export function stageMessage(kind: OrderStageKind | null, orderRef: string): string | null {
  const pedido = orderRef ? `su pedido ${orderRef}` : 'su pedido'
  const Pedido = orderRef ? `Su pedido ${orderRef}` : 'Su pedido'
  switch (kind) {
    case 'paid':
      return `🙌 Recibimos el pago de ${pedido}, ¡gracias! Enseguida lo preparamos.`
    case 'ready':
      return `✅ ${Pedido} ya está listo. Si lo retira, ya puede pasar por la tienda; si pidió entrega a domicilio, ya va en camino 🛵`
    case 'delivered':
      return '¡Gracias por su compra en Ferrotienda! 🙂'
    case 'cancelled':
      return `${Pedido} fue cancelado. Si fue un error o necesita algo, escríbanos por aquí 🙂`
    default:
      // New and quoted: staff talk to the customer themselves (/total).
      return null
  }
}

// ---- Satisfaction survey, sent with the "delivered" message ----------

export const CSAT_QUESTION = '¿Cómo le atendimos? Su opinión nos ayuda a mejorar 🙏'

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

/** The store's Google Business Profile review form. */
export const GOOGLE_REVIEW_URL = 'https://g.page/r/CRa1Vf7odqVJEBM/review'

export function csatThanks(key: CsatKey): string {
  if (key === 'mal') {
    return 'Lamentamos que no haya sido una buena experiencia 🙏 Una persona de nuestro equipo le escribirá para saber qué pasó.'
  }
  if (key === 'excelente') {
    // Happy customers are the ones worth asking for a public review.
    return `¡Muchas gracias! 🙂 Si tiene un minuto, nos ayudaría mucho su reseña en Google ⭐\n${GOOGLE_REVIEW_URL}`
  }
  return '¡Muchas gracias por su calificación! 🙂'
}
