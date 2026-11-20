import type { SupabaseClient } from '@supabase/supabase-js'
import { sanitizeAdLinks, type AdLink } from '@/lib/marketing/ad-links'

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

import { sanitizeSeasonalReplies, type SeasonalReply } from './seasonal-replies'
import { sanitizeMenuPromos, type MenuPromo } from './menu-promos'
import { sanitizeAdLines, type AdLine } from '@/lib/flows/ad-lines'

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
  /**
   * What customers ask, answered once by the business: delivery,
   * payments, invoices, returns, who handles wholesale… The bot and the
   * chat AI answer from this, never inventing policies.
   */
  customerInfo: string
  /** "If they order X, suggest Y" — one aside per conversation. */
  crossSell: CrossSellRule[]
  /** Campaign answers for words like "canasta" — see seasonal-replies.ts. */
  seasonalReplies: SeasonalReply[]
  /** Campaign line at the top of the menu and for the AI — see menu-promos.ts. */
  menuPromos: MenuPromo[]
  /** Contact custom field holding the birthday (MM-DD) for the birthday flow. */
  birthdayFieldName: string
  /** One line about delivery shown in the product picker's cart ('' = none). */
  shopDeliveryNote: string
  /** The product picker's name, as the bot writes it ("Catálogo express", "RAPIDITO ⚡"). */
  shopName: string
  /** Text of the WhatsApp button that opens the picker (20 characters max). */
  shopButton: string
  /** The picker's promise, under its name in the page header ('' = none). */
  shopTagline: string
  /** Logo for the picker's header, white on dark (public https URL; '' = the name as text). */
  shopLogoUrl: string
  /** Same-day delivery cut-off hour (local, 1-23): the page says "pida en 2 h 15 min y le llega HOY" / "mañana temprano". 0 = off. */
  shopSameDayCutoff: number
  /** Contact custom field that keeps the customer's ID number (cédula / RUC) for invoices. */
  idNumberFieldName: string
  /** WooCommerce store URL (keys stay in the server environment). */
  woocommerceUrl: string
  /**
   * The CRM's public address (https://…), used to build links the bot
   * sends — like the product picker. Falls back to NEXT_PUBLIC_SITE_URL.
   */
  publicAppUrl: string
  /** The web shop's product feed (CSV), for the product picker. '' = picker off. */
  shopFeedUrl: string
  /** The business's WhatsApp number (digits, with country code), for "Volver a WhatsApp" links. */
  whatsappNumber: string
  /**
   * Tell the team when a customer starts a conversation (first message
   * after 3 h of silence), so someone can follow it: 'off', 'app' (CRM
   * notification) or 'whatsapp' (CRM + WhatsApp to staff on shift).
   */
  newConversationAlert: 'off' | 'app' | 'whatsapp'
  /**
   * Allow sending WhatsApp message templates (Inbox, broadcasts, flows,
   * automations). Meta charges for templates, so they're off until the
   * business turns them on; replies within 24 h are free and unaffected.
   */
  allowPaidTemplates: boolean
  /** Advertising links (Advertising page); changed only through /api/marketing/links. */
  adLinks: AdLink[]
  /** Campaign lines for ads and first messages (see flows/ad-lines.ts). */
  adLines: AdLine[]
  /**
   * Partner program for Airbnb hosts (Advertising page → Hosts): guests
   * who write through a host's QR get the discount while their stay
   * lasts. Changed only through /api/marketing/hosts.
   */
  hostProgram: {
    /** Discount for the host's guests, in percent (0 = none). */
    discountPct: number
    /** Free delivery from this order amount, in the shop's currency (0 = not offered). */
    freeDeliveryFrom: number
    /** Days after the guest's last message with the code that the discount still applies. */
    validDays: number
    /** Sent the first time a guest writes. {anfitrion} {alojamiento} {descuento} {envio} {dias} {negocio} */
    welcomeText: string
  }

  /** AI help with what customers send (uses the account's AI key). */
  aiFeatures: {
    /** Photo of a written list or of a product → order lines. */
    readImages: boolean
    /** Voice notes → text (needs TRANSCRIBE_API_KEY or an OpenAI key). */
    transcribeAudio: boolean
    /** A whole order typed as the first message starts the order flow. */
    entryRouter: boolean
    /** Most voice notes transcribed per day (protects the transcription credits). */
    audioDailyLimit: number
    /** Answer questions asked in the middle of an order instead of writing them down. */
    answerQuestions: boolean
    /** Review each conversation with AI once the customer stops writing; admins hear about problems. */
    reviewConversations: boolean
  }
  /** Bakery orders (cakes, party snacks, bread). */
  bakery: {
    /** Node of the main flow where a bakery order starts ("quiero una torta"); '' = off. */
    entryNode: string
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
    /** A file from the customer (PDF, Word…); {archivo} = " *name*" or "". The team is notified. */
    documentReceived: string
    /** A supplier, salesperson or sponsorship request writing to the customer chat. */
    vendorReply: string
    /** Customer went quiet in the middle of something that isn't an order list. */
    idleNudgeGeneral: string
    /** A voice note over 3 minutes. */
    audioTooLong: string
    /** Two hours after a customer left a list half-way; {lista} = its first lines. */
    recoveryReminder: string
    /** "Más tarde" on that reminder. */
    recoveryLater: string
    /**
     * A finished list whose customer didn't send name and ID number: it
     * went to the team anyway, and the data is asked for as a favor.
     * {cuando} = "en breve" / "mañana a partir de las 7am"; {sin_cedula} =
     * "(si no tiene cédula ecuatoriana, solo su nombre)" for foreign numbers.
     */
    listHandedOver: string
    /**
     * One promotion line when an order ends well (after the order went to
     * the team, or with the "gracias" reply); once a week per customer.
     * {promo} = the menu promotion, when the customer didn't see the menu.
     * '' = off.
     */
    closingPromo: string
    /**
     * Closing message instead of the promotion when the order carries
     * something usually installed (lock, faucet, socket…), with buttons
     * [Sí, instálenlo] [No, gracias]; {producto} = that order line. '' = off.
     */
    closingInstall: string
    /** Reply to "Sí, instálenlo"; the team gets the request. */
    closingInstallYes: string
    /**
     * Added to the closing promotion when the order was typed (not picked
     * in the catalog), sent with the catalog button. '' = off.
     */
    closingCatalogTip: string
    /**
     * Top of the catalog button when the customer asked for it by name
     * ("rapidito") and skipped the menu — "{{vars.shop_intro}}" in the
     * flow's catalog node. {nombre} = " Juan" or "", {promo} = the menu
     * promotion. '' = off.
     */
    shopWelcome: string
    /**
     * Confirmation of a web form's technician request; {nombre}, {codigo}
     * (its code), {servicio} (kind of job). The photo question follows.
     */
    webServiceReceived: string
    /** Catalog button after a campaign line's answer; {catalogo} = its name. '' = no button. */
    adLineCatalog: string
    /** "¿Cuánto es el total?" after the order went to staff; {pedido} = the order number. */
    totalPending: string
    /** "Gracias" / "ok" after the order went to staff. */
    thanksReply: string
    /** The customer asked to be called, within opening hours. */
    callRequestOpen: string
    /** …outside opening hours; {cuando} = "mañana a partir de las 7am". */
    callRequestClosed: string
    /** A cart left in the product picker; {productos} = "3 productos", {total} = "$6,70". */
    cartReminder: string
    /** "Ver carrito" on that reminder (above the link button). */
    cartView: string
    /** "Enviar mi pedido" when the cart was already sent or is empty. */
    cartEmpty: string
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
  /** Formal quotes (PDF) that staff prepare from an order card and send in the chat. */
  quote: {
    /** Seller shown on the PDF (legal name), its tax id (RUC), address, phone and email. */
    legalName: string
    taxId: string
    address: string
    phone: string
    email: string
    /** Days the prices hold. */
    validDays: number
    /** Small print at the bottom of the PDF. */
    footer: string
    /** Sent with the PDF; {cotizacion} = "C-0037", {total} = "$2.160,00", {validez} = "20/11/2026". */
    message: string
    /** "✅ Acepto" on the quote; the team is told. */
    acceptedReply: string
    /** "✏️ Cambiar algo" on the quote; the team is told. */
    changeReply: string
  }
  /**
   * Nobody answered a customer the team was called in for (after the
   * "⏰ SIN RESPUESTA" second alert): tell the admins and these people.
   */
  escalation: {
    /** Minutes after the first alert (0 = off). */
    minutes: number
    /** Who also gets it by WhatsApp (same format as the staff list; only while their 24 h window is open). */
    phones: string[]
  }
  /**
   * Conversions API: when an order card reaches "Entregado", tell Meta
   * the sale and its value, so ads are shown to people who buy (not just
   * people who write). Needs the whatsapp_business_manage_events
   * permission on the WhatsApp token.
   */
  metaConversions: {
    enabled: boolean
    /** Facebook page id: lets Meta match customers who didn't come from an ad click (optional). */
    pageId: string
    /** Filled in automatically the first time (the WhatsApp account's dataset). */
    datasetId: string
  }
  orderBoard: {
    /** The pipeline whose cards are orders. */
    pipelineName: string
    /** Sent when a card reaches that column; {pedido} = "N° 0015" (may be empty). */
    messages: { paid: string; ready: string; delivered: string; cancelled: string }
    csatQuestion: string
    /** Thanks for "Excelente" (no review link: see reviewRequest). */
    csatExcellent: string
    csatGood: string
    csatBad: string
    /**
     * The Google review request, sent to EVERY delivered order's customer
     * (never only to happy ones: Google forbids that) reviewDelayHours
     * after "Entregado", once per customer every 90 days, only inside the
     * free 24 h window. {resena} = googleReviewUrl, {negocio} = name.
     */
    reviewRequest: string
    /** Hours after delivery (0 = off). */
    reviewDelayHours: number
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
  customerInfo: '',
  crossSell: [],
  seasonalReplies: [],
  menuPromos: [],
  birthdayFieldName: 'Fecha de nacimiento',
  idNumberFieldName: 'Cédula',
  shopDeliveryNote: '',
  shopName: 'Catálogo express',
  shopButton: '🛒 CATÁLOGO EXPRESS',
  shopTagline: '',
  shopLogoUrl: '',
  shopSameDayCutoff: 0,
  woocommerceUrl: '',
  publicAppUrl: '',
  shopFeedUrl: '',
  whatsappNumber: '',
  newConversationAlert: 'off',
  allowPaidTemplates: false,
  adLinks: [],
  adLines: [],
  hostProgram: {
    discountPct: 5,
    freeDeliveryFrom: 0,
    validDays: 15,
    welcomeText:
      '🏠 ¡Bienvenido/a! Por hospedarse en *{alojamiento}*, tiene *{descuento} de descuento* en sus compras en {negocio} durante su estadía{envio}.\n\n' +
      '🇬🇧 Welcome! As a guest of {alojamiento} you get *{descuento} off* your purchases at {negocio} during your stay{envio_en}. Just send us your list here.',
  },
  aiFeatures: { readImages: true, transcribeAudio: true, entryRouter: true, audioDailyLimit: 200, answerQuestions: true, reviewConversations: false },
  bakery: { entryNode: '' },
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
    vendorReply:
      'Gracias por escribirnos 🙂 Por este chat atendemos pedidos de clientes. Las propuestas comerciales, proveedores y empleo las atiende nuestro equipo administrativo: un asesor le indicará a dónde escribir.',
    documentReceived:
      '📄 Recibimos su archivo{archivo}, ¡gracias! Una persona de nuestro equipo lo revisa y le responde por aquí 🙂',
    idleNudgeGeneral: '¿Sigue ahí? 🙂 Cuando pueda, respóndame y continuamos.',
    audioTooLong: 'Su audio es un poco largo 🙏 ¿Me lo puede escribir, o enviar uno más corto (menos de 3 minutos)?',
    recoveryReminder: '🛒 Su lista quedó guardada:\n{lista}\n\n¿Seguimos con su pedido?',
    recoveryLater: 'Perfecto, aquí la guardamos 🙂 Cuando quiera, escriba *menú* y seguimos.',
    listHandedOver:
      '📋 Le pasé su lista a nuestro equipo; le escriben por aquí {cuando} para confirmarla 🙂\n\nPara la factura, cuando pueda envíeme su *nombre completo* y su *cédula*{sin_cedula}.',
    closingPromo: '',
    closingInstall:
      '🔧 *¿Se lo instalamos?* Uno de nuestros técnicos le instala: _{producto}_ en su casa. El día y el costo se los confirma el técnico.',
    closingInstallYes: '✅ ¡Listo! Le pasé su pedido de instalación a nuestro equipo; le confirman el día y el costo por aquí 🙂',
    closingCatalogTip: '⚡ La próxima vez pida en 1 minuto, con fotos y precios, en nuestro *{catalogo}* 👇',
    shopWelcome: '¡Hola{nombre}! 👋 Gracias por escribirnos 🙌\n\n{promo}',
    webServiceReceived:
      '✅ ¡Hola{nombre}! Recibimos su pedido de técnico de la web *{codigo}*: {servicio}. Ya tenemos sus datos, no hace falta repetirlos 🙂',
    adLineCatalog: '¿Ya sabe lo que quiere? Pídalo en 1 minuto en {catalogo} 👇',
    totalPending:
      'Su asesor está preparando el total de su pedido {pedido} y se lo envía por aquí en unos minutos 🙂 Mientras tanto, ¿desea agregar algo más?',
    thanksReply: '¡Con gusto! 🙂 Cualquier cosa, aquí estamos.',
    callRequestOpen: '📞 ¡Listo! Ya avisamos a nuestro equipo: le llamaremos en los próximos minutos a este número.',
    callRequestClosed: '📞 Recibido. Ahora estamos fuera de horario; le llamaremos {cuando} a este número 🙂',
    cartReminder: '🛒 Dejó {productos} en su carrito del catálogo ({total}). ¿Se los envío a nuestro asesor?',
    cartView: 'Aquí está su carrito, tal como lo dejó 👇',
    cartEmpty: 'Su carrito ya fue enviado o está vacío 🙂 Si necesita algo más, escríbame.',
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
  quote: {
    legalName: '',
    taxId: '',
    address: '',
    phone: '',
    email: '',
    validDays: 3,
    footer: 'Precios incluyen IVA. Sujeto a disponibilidad de stock al momento de confirmar el pedido.',
    message: '🧾 Aquí tiene su cotización {cotizacion}: total *{total}*, válida hasta el {validez}. ¿Le parece bien?',
    acceptedReply: '¡Gracias! 🙌 Un asesor le escribe por aquí para coordinar el pago y la entrega.',
    changeReply: 'Claro 🙂 Escríbame qué desea cambiar y un asesor le actualiza la cotización.',
  },
  escalation: { minutes: 25, phones: [] },
  metaConversions: { enabled: false, pageId: '', datasetId: '' },
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
    csatExcellent: '¡Muchas gracias! 🙂 Nos alegra mucho haberle atendido bien.',
    csatGood: '¡Muchas gracias por su calificación! 🙂',
    csatBad:
      'Lamentamos que no haya sido una buena experiencia 🙏 Una persona de nuestro equipo le escribirá para saber qué pasó.',
    reviewRequest:
      '¡Gracias por su compra en {negocio}! 🙌 Si le gustó el servicio, ¿nos ayuda con su opinión en Google? Le toma un minuto ⭐\n{resena}',
    reviewDelayHours: 2,
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

const clampNumber = (n: number, min: number, max: number): number =>
  Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : min

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
    aiFeatures: { ...s.aiFeatures, audioDailyLimit: Math.max(0, Math.min(5000, Math.round(s.aiFeatures.audioDailyLimit))) },
    phoneCountryCode: s.phoneCountryCode.replace(/\D/g, ''),
    whatsappNumber: s.whatsappNumber.replace(/\D/g, ''),
    newConversationAlert: (['off', 'app', 'whatsapp'] as const).includes(s.newConversationAlert) ? s.newConversationAlert : 'off',
    publicAppUrl: s.publicAppUrl.trim().replace(/\/+$/, ''),
    shopFeedUrl: s.shopFeedUrl.trim(),
    shopName: s.shopName.trim().slice(0, 40) || DEFAULT_BUSINESS_SETTINGS.shopName,
    shopButton: [...(s.shopButton.trim() || DEFAULT_BUSINESS_SETTINGS.shopButton)].slice(0, 20).join(''),
    shopTagline: s.shopTagline.trim().slice(0, 120),
    shopLogoUrl: /^https:\/\/[^\s]+$/.test(s.shopLogoUrl.trim()) ? s.shopLogoUrl.trim() : '',
    shopSameDayCutoff: Math.round(clampNumber(s.shopSameDayCutoff, 0, 23)),
    // Seven days or none (= always open); a partial week is padded closed.
    openingHours: hours.length ? [...hours, ...Array(7 - hours.length).fill(null)] : [],
    staffPhones: strings(s.staffPhones, 20),
    adLinks: sanitizeAdLinks(s.adLinks),
    adLines: sanitizeAdLines(s.adLines),
    hostProgram: {
      discountPct: clampNumber(s.hostProgram.discountPct, 0, 50),
      freeDeliveryFrom: clampNumber(s.hostProgram.freeDeliveryFrom, 0, 10000),
      validDays: Math.round(clampNumber(s.hostProgram.validDays, 1, 90)),
      welcomeText: s.hostProgram.welcomeText.slice(0, 1000),
    },
    orderBoard: { ...s.orderBoard, reviewDelayHours: clampNumber(s.orderBoard.reviewDelayHours, 0, 72) },
    quote: { ...s.quote, validDays: Math.round(clampNumber(s.quote.validDays, 1, 60)) },
    escalation: {
      minutes: Math.round(clampNumber(s.escalation.minutes, 0, 240)),
      phones: strings(s.escalation.phones, 10),
    },
    metaConversions: {
      enabled: s.metaConversions.enabled,
      pageId: s.metaConversions.pageId.replace(/\D/g, ''),
      datasetId: s.metaConversions.datasetId.replace(/\D/g, ''),
    },
    seasonalReplies: sanitizeSeasonalReplies(s.seasonalReplies),
    menuPromos: sanitizeMenuPromos(s.menuPromos),
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

export const TEMPLATES_DISABLED_MESSAGE =
  'Message templates are turned off in Settings → My business (Meta charges for them).'

/** Whether this business allows sending (paid) message templates. */
export async function templatesAllowed(db: SupabaseClient, accountId: string): Promise<boolean> {
  return (await loadBusinessSettings(db, accountId)).allowPaidTemplates
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
