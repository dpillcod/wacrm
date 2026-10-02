import type { SupabaseClient } from '@supabase/supabase-js'

// ============================================================
// Per-account business settings — everything about the business the
// bot works for (hours, contacts, texts, rules, board messages…), set
// in Settings → My business instead of being written into the code.
//
// Stored as one JSON document per account in `business_settings`
// (migration 045). What's missing there falls back to the neutral
// defaults below, key by key, so a new account works out of the box
// and a settings document from an older version never breaks the bot.
//
// Texts may carry {placeholders}; see renderText.
// ============================================================

export interface CrossSellRule {
  keyword: string
  suggestion: string
}

export interface BusinessSettings {
  /** Shown in texts and given to the AI ("Ferrotienda"). */
  name: string
  city: string
  country: string
  /** Offset from UTC in hours, e.g. -5 for Ecuador (no DST handling). */
  utcOffsetHours: number
  /** Country calling code used to turn local numbers into international ("593"). */
  phoneCountryCode: string
  websiteUrl: string
  shopUrl: string
  googleReviewUrl: string
  callCenterPhone: string
  /**
   * Opening hours by weekday, index 0 = Sunday: [open hour, close hour)
   * in local time, or null = closed. An empty list = always open.
   */
  openingHours: ([number, number] | null)[]
  /** Staff numbers that get WhatsApp order alerts (local or international). */
  staffPhones: string[]
  /** What staff write to the bot to turn their alerts on for 24h. */
  checkInWords: string[]
  /** Products that can't be ordered over WhatsApp (e.g. alcohol, Meta policy). */
  blockedProducts: { terms: string[]; reply: string }
  /** Who the business is, for the AI that tidies order lines. */
  aiBusinessDescription: string
  /** "If they order X, suggest Y" — one aside per conversation. */
  crossSell: CrossSellRule[]
  /** Contact custom field holding the birthday (MM-DD) for the birthday flow. */
  birthdayFieldName: string
  /** WooCommerce store URL (keys stay in the server environment). */
  woocommerceUrl: string
  /** AI help with what customers send (uses the account's AI key). */
  aiFeatures: {
    /** Photo of a written list or of a product → order lines. */
    readImages: boolean
    /** Voice notes → text (needs TRANSCRIBE_API_KEY or an OpenAI key). */
    transcribeAudio: boolean
    /** A whole order typed as the first message starts the order flow. */
    entryRouter: boolean
  }
  texts: {
    idleNudge: string
    captureFailed: string
    fallbackHandoff: string
    nonTextReply: string
    disambiguationPrompt: string
    editFailed: string
    followUpYes: string
    followUpNo: string
    /** {cuando} = "hoy a partir de las 7am" / "mañana a partir de las 8am"; {horario} = the hours in words. */
    outOfHours: string
    /** {hasta} = the time alerts stay on until. */
    checkIn: string
    /** A typed option number that doesn't exist; {max} = the last number. */
    invalidOption: string
    /** "sí" / "ok" / "gracias" while an order list is being written. */
    orderAck: string
    /** "Quiero hablar con un asesor" while an order list is being written. */
    humanRequest: string
    /** A plain "hola" in the middle of an order (the list is kept). */
    resumeOrder: string
    /** A photo sent while ordering that has no products in it. */
    photoNotUnderstood: string
    /** A payment receipt photo (the team is notified). */
    receiptReceived: string
  }
  /** Home services (plumbing, electricity, painting, locks…): their own board. */
  serviceBoard: {
    /** The pipeline whose cards are service requests. */
    pipelineName: string
    /**
     * Node of the main flow where a service request starts, used when a
     * customer's first message asks for one ("necesito un plomero");
     * '' = that shortcut is off.
     */
    entryNode: string
    /** Sent when a card reaches that column; {servicio} = "N° S-0003" (may be empty). */
    messages: { scheduled: string; working: string; done: string; cancelled: string }
  }
  orderBoard: {
    /** The pipeline whose cards are orders. */
    pipelineName: string
    /** Sent when a card reaches that column; {pedido} = "N° 0015" (may be empty). */
    messages: { paid: string; ready: string; delivered: string; cancelled: string }
    csatQuestion: string
    /** {resena} = googleReviewUrl. */
    csatExcellent: string
    csatGood: string
    csatBad: string
    /** Replies to "¿dónde está mi pedido?" by the order's column. */
    statusReplies: {
      new: string
      quoted: string
      paid: string
      ready: string
      delivered: string
      cancelled: string
      none: string
    }
  }
}

/** Neutral defaults: a new business works before anything is set. */
export const DEFAULT_BUSINESS_SETTINGS: BusinessSettings = {
  name: '',
  city: '',
  country: '',
  utcOffsetHours: -5,
  phoneCountryCode: '',
  websiteUrl: '',
  shopUrl: '',
  googleReviewUrl: '',
  callCenterPhone: '',
  openingHours: [],
  staffPhones: [],
  checkInWords: ['turno', 'avisos', 'activar avisos', 'activar turno'],
  blockedProducts: {
    // Meta's Commerce Policy forbids selling alcohol over WhatsApp, for
    // every business — so the default already blocks it.
    terms: [
      'licor', 'licores', 'trago', 'tragos', 'cerveza', 'cervezas', 'chela', 'chelas',
      'whisky', 'whiskey', 'wisky', 'ron', 'vodka', 'tequila', 'aguardiente', 'vino',
      'vinos', 'champagne', 'champan', 'espumante', 'gin', 'ginebra', 'brandy', 'cognac',
      'coñac', 'mezcal', 'pisco', 'sangria',
    ],
    reply: 'Por este medio no podemos tomar pedidos de licores 🙏\n\nSi necesita algo más, con gusto lo anoto.',
  },
  aiBusinessDescription: 'una tienda',
  crossSell: [],
  birthdayFieldName: 'Fecha de nacimiento',
  woocommerceUrl: '',
  aiFeatures: { readImages: true, transcribeAudio: true, entryRouter: true },
  texts: {
    idleNudge: '¿Sigue ahí? Si tiene alguna duda, dígame y seguimos con su pedido 🙂',
    captureFailed: 'Disculpe, no logré registrar eso último 🙁 ¿Me lo puede escribir de nuevo?',
    fallbackHandoff:
      'Disculpe, no logré entenderle bien 🙏 Le comunico con uno de nuestros asesores para que le ayude.',
    nonTextReply:
      'Por ahora no puedo escuchar audios ni ver ese tipo de mensajes 🙏 ¿Me lo puede escribir, por favor?',
    disambiguationPrompt: '¿Cuál de estas opciones es la que busca?',
    editFailed: 'Disculpe, no logré aplicar ese cambio 🙏 Escríbame el *número* del producto que desea cambiar.',
    followUpYes: '¡Qué bueno! Gracias por confirmarnos 🙂 Si necesita algo más, escriba *menú*.',
    followUpNo: 'Ya le recordamos a nuestro equipo, en breve le escriben 🙏',
    outOfHours:
      'En este momento estamos fuera de nuestro horario de atención ({horario}). Su mensaje quedó registrado y le atenderemos {cuando} 🙂',
    checkIn: '✅ Listo, sus avisos de pedidos por WhatsApp están activos hasta mañana a las {hasta}. Escriba *turno* cada día al empezar 🙂',
    invalidOption: 'Por favor escriba el número de una de las opciones (del 1 al {max}) 🙂',
    orderAck: '👍 Escríbame el siguiente producto, o *listo* si ya terminó 🙂',
    humanRequest:
      'Con gusto le atiende una persona de nuestro equipo 🙂 Escriba *menú* y elija *Hablar con un asesor*. Si prefiere, primero terminamos su lista: escríbame *listo*.',
    resumeOrder:
      '¡Hola de nuevo! 👋 Seguimos con su pedido 🙂 Escríbame lo que le falta, o *listo* si ya terminó. Si prefiere empezar de cero, escriba *menú*.',
    photoNotUnderstood:
      'Recibí su foto 🙂 pero no logré leer productos en ella. ¿Me escribe qué necesita, o me envía una foto más clara de su lista?',
    receiptReceived: '🧾 Recibimos su comprobante, ¡gracias! Nuestro equipo lo revisará y le confirmará por aquí 🙂',
  },
  serviceBoard: {
    pipelineName: 'Servicios',
    entryNode: '',
    messages: {
      scheduled: '📅 Su visita técnica {servicio} quedó agendada. El técnico le escribirá por aquí antes de llegar 🙂',
      working: '🔧 Nuestro técnico ya va en camino o trabajando en su servicio {servicio}.',
      done: '✅ Terminamos su servicio {servicio}. ¡Gracias por confiar en nosotros! 🙂',
      cancelled: 'Su servicio {servicio} fue cancelado. Si necesita algo, escríbanos por aquí 🙂',
    },
  },
  orderBoard: {
    pipelineName: 'Pedidos',
    messages: {
      paid: '🙌 Recibimos el pago de su pedido {pedido}, ¡gracias! Enseguida lo preparamos.',
      ready:
        '✅ Su pedido {pedido} ya está listo. Si lo retira, ya puede pasar por la tienda; si pidió entrega a domicilio, ya va en camino 🛵',
      delivered: '¡Gracias por su compra! 🙂',
      cancelled: 'Su pedido {pedido} fue cancelado. Si fue un error o necesita algo, escríbanos por aquí 🙂',
    },
    csatQuestion: '¿Cómo le atendimos? Su opinión nos ayuda a mejorar 🙏',
    csatExcellent: '¡Muchas gracias! 🙂 Si tiene un minuto, nos ayudaría mucho su reseña en Google ⭐\n{resena}',
    csatGood: '¡Muchas gracias por su calificación! 🙂',
    csatBad:
      'Lamentamos que no haya sido una buena experiencia 🙏 Una persona de nuestro equipo le escribirá para saber qué pasó.',
    statusReplies: {
      new: 'Recibimos su pedido {pedido} y nuestro equipo lo está revisando 🙂 En breve le confirmamos el total.',
      quoted: 'Ya le enviamos el total de su pedido {pedido}. Cuando nos confirme el pago, lo preparamos 🙂',
      paid: 'Su pedido {pedido} ya está pagado y lo estamos preparando 🙂',
      ready: '✅ Su pedido {pedido} ya está listo (o en camino si pidió entrega a domicilio) 🛵',
      delivered: 'Su pedido {pedido} figura como entregado. Si algo no llegó bien, cuéntenos por aquí 🙏',
      cancelled: 'Su pedido {pedido} figura como cancelado. Si fue un error, escriba *menú* y lo armamos de nuevo 🙂',
      none: 'No encuentro un pedido reciente a su nombre 🤔 Si desea hacer uno, escriba *menú*.',
    },
  },
}

type Json = Record<string, unknown>

function isPlainObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Stored settings over the defaults, key by key: objects merge, a value
 * of the wrong type is ignored (the default stays), arrays replace.
 */
export function mergeSettings<T>(defaults: T, stored: unknown): T {
  if (!isPlainObject(stored) || !isPlainObject(defaults)) return defaults
  const out: Json = { ...(defaults as Json) }
  for (const [key, def] of Object.entries(defaults as Json)) {
    const value = stored[key]
    if (value === undefined || value === null) continue
    if (isPlainObject(def)) out[key] = mergeSettings(def, value)
    else if (Array.isArray(def)) {
      if (Array.isArray(value)) out[key] = value
    } else if (typeof value === typeof def) out[key] = value
  }
  return out as T
}

/** "{pedido} listo" + {pedido:'N° 5'} → "N° 5 listo"; unknown keys → ''. Spaces tidied. */
export function renderText(template: string, values: Record<string, string>): string {
  return template
    .replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? '')
    .replace(/ {2,}/g, ' ')
    .replace(/ ([,.!?])/g, '$1')
}

const strings = (v: unknown[], max: number): string[] =>
  v
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, max)

/**
 * Settings as the app can trust them: merged over the defaults, with
 * list items checked too (mergeSettings only checks that a list IS a
 * list). Used on read and before saving.
 */
export function sanitizeSettings(stored: unknown): BusinessSettings {
  const s = mergeSettings(DEFAULT_BUSINESS_SETTINGS, stored)
  const hour = (h: unknown) => typeof h === 'number' && Number.isFinite(h) && h >= 0 && h <= 24
  const hours = s.openingHours.slice(0, 7).map((d) =>
    Array.isArray(d) && d.length === 2 && hour(d[0]) && hour(d[1]) && d[0] < d[1]
      ? ([d[0], d[1]] as [number, number])
      : null,
  )
  return {
    ...s,
    utcOffsetHours: Math.max(-12, Math.min(14, s.utcOffsetHours)),
    phoneCountryCode: s.phoneCountryCode.replace(/\D/g, ''),
    // Seven days or none (= always open); a partial week is padded closed.
    openingHours: hours.length ? [...hours, ...Array(7 - hours.length).fill(null)] : [],
    staffPhones: strings(s.staffPhones, 20),
    checkInWords: strings(s.checkInWords, 20).map((w) => w.toLowerCase()),
    blockedProducts: {
      terms: strings(s.blockedProducts.terms, 300).map((w) => w.toLowerCase()),
      reply: s.blockedProducts.reply,
    },
    crossSell: s.crossSell
      .filter(
        (r): r is CrossSellRule =>
          isPlainObject(r) &&
          typeof r.keyword === 'string' &&
          typeof r.suggestion === 'string' &&
          r.keyword.trim() !== '' &&
          r.suggestion.trim() !== '',
      )
      .map((r) => ({ keyword: r.keyword.trim().toLowerCase(), suggestion: r.suggestion.trim() }))
      .slice(0, 200),
  }
}

const CACHE_MS = 60_000
const cache = new Map<string, { at: number; value: BusinessSettings }>()

export function clearBusinessSettingsCache(accountId?: string): void {
  if (accountId) cache.delete(accountId)
  else cache.clear()
}

/**
 * The account's settings (merged over the defaults). Cached for a
 * minute per process — the bot reads them on every message. Never
 * throws: a missing table/row or a read error yields the defaults.
 */
export async function loadBusinessSettings(
  db: SupabaseClient,
  accountId: string,
): Promise<BusinessSettings> {
  const hit = cache.get(accountId)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value
  let stored: unknown = null
  try {
    const { data, error } = await db
      .from('business_settings')
      .select('settings')
      .eq('account_id', accountId)
      .maybeSingle()
    if (error) console.error('[business-settings] read failed:', error.message)
    stored = (data as { settings?: unknown } | null)?.settings ?? null
  } catch (err) {
    console.error('[business-settings] read threw:', err)
  }
  const value = sanitizeSettings(stored)
  cache.set(accountId, { at: Date.now(), value })
  return value
}
