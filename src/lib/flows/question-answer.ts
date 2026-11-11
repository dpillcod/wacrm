/**
 * Answering a customer's question in the middle of the bot's flow, so a
 * question is never written down as if it were a product ("¿Dispone de
 * Grilon?" used to become order line 1). The answer is grounded in the
 * business's own customer information (Settings → My business) and in
 * the catalog — by name only: prices are never given.
 *
 * When the question is about a product, the reply offers to add it, and
 * the product is returned so the next "sí, 10 metros" can be written
 * down as "10 metros Grilon".
 *
 * Best-effort: any failure returns null and the caller carries on as before.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadAiConfig } from "../ai/config";
import { retrieveCatalogProducts } from "../ai/catalog";
import { aiRequestTimeoutMs } from "../ai/defaults";
import { generateAnthropic } from "../ai/providers/anthropic";
import { generateOpenAi } from "../ai/providers/openai";
import { logAiUsage } from "../ai/usage";
import { loadBusinessSettings } from "../business/settings";
import { campaignsForAi } from "../business/menu-promos";
import { localDate } from "../business/seasonal-replies";
import { businessIntro } from "./order-clarify";
import { hoursInWords } from "./store-policy";
import { productKey } from "./model-options";

const ANSWER_TIMEOUT_MS = 12_000;

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9ñ?¿\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Greetings and courtesy words customers put before a question. */
const LEAD_IN =
  /^((hola|buenas|buenos|buen|dias|dia|tardes|noches|como esta|como estan|que tal|disculpe|disculpa|perdon|por favor|porfa|una pregunta|una consulta|consulta|pregunta|estimado|estimada|amigo|amiga|señorita|senorita|joven|oiga|oye|veci|vecino|vecina|vecinito|vecinita|talvez|tal vez|de pronto)[\s,]*)+/;

// "Perfecto, ¿saben venir en paquetes?": an acknowledgement before the
// question. Whole words only ("y" must not eat the start of "yogur").
const ACK_LEAD_IN = /^((perfecto|ok|okey|listo|bueno|claro|gracias|muchas gracias|dale|ya|y)([\s,.!]+|$))+/;

const QUESTION_START =
  /^(tiene|tienen|tendra|tendran|tendras|hay|habra|dispone|disponen|venden|vende|manejan|maneja|hacen|hace|realizan|aceptan|acepta|reciben|puedo|puede|pueden|se puede|como|donde|cuando|a que hora|hasta que hora|desde que hora|que|cual|cuales|cuanto|cuantos|cuanta|envian|entregan|llevan|trabajan|atienden|abren|cierran|facturan|me pueden|me puede|quisiera saber|queria saber|sabe si|saben si|sabe|saben|suelen|viene|vienen|existe|consiguen|traen|tenian|tenia|habia|habian|vendian|vendia|dispongan|disponga|tengan|tenga|vendan|me pueda|me puedan|me podria|me podrian|podria|podrian|me confirma|me confirman|confirmeme|en que|de que|con que|que colores?|cuales colores|que tamanos?|que medidas?|que modelos?|que marcas?|esta funcionando|funciona)\b/;

/**
 * Whether a message is a question rather than an order line: it has a
 * question mark, or (after any greeting) starts like one — "tiene…",
 * "hay…", "¿hacen envíos?". A line starting with a quantity is an order
 * line ("2 coca cola ?" included).
 */
export function looksLikeQuestion(text: string): boolean {
  const n = normalize(text);
  if (!n) return false;
  const body = n.replace(/[¿?]/g, " ").replace(/\s+/g, " ").replace(LEAD_IN, "").replace(ACK_LEAD_IN, "").trim();
  if (!body || /^\d/.test(body)) return false;
  if (/^que tal\b/.test(n) && body.split(" ").length <= 1) return false;
  // "formas de pago", "horarios de atención": a topic asked about without
  // a question mark (short, so "2 libras de arroz" never counts).
  if (
    body.split(" ").length <= 6 &&
    /^(sus |los |las |el |la )?(formas? de pago|metodos? de pago|horarios?|horario de atencion|ubicacion|direccion|donde (estan|quedan)|delivery|envios?|costo de envio|precio del envio|telefono|numero de contacto)\b/.test(body)
  ) return true;
  // "…en paquetes, ¿verdad?" written without the question mark.
  if (/\b(verdad|verdsd|cierto)$/.test(body) && body.split(" ").length >= 3) return true;
  return n.includes("?") || n.includes("¿") || QUESTION_START.test(body);
}

const SEARCH_STOPWORDS = new Set([
  "tiene", "tienen", "tendra", "tendran", "tendras", "hay", "habra", "dispone", "disponen", "venden", "vende",
  "manejan", "maneja", "consiguen", "traen", "existe", "el", "la", "los", "las", "de", "del", "dia", "hoy",
  "un", "una", "unos", "unas", "algun", "alguna", "algunos", "que", "si", "me", "por", "para", "con", "usted",
  "ustedes", "favor", "talvez", "tal", "vez", "quisiera", "saber", "quiero", "necesito", "busco", "estoy",
  "buscando", "venta", "en", "stock", "disponible", "disponibles", "ahora", "todavia", "aun", "y", "o", "a",
]);

/**
 * The product words of a question, for the catalog search: "Buenas
 * tardes, disculpe ¿tendrá garbanzo el día de hoy?" → "garbanzo". The
 * whole sentence found sanding discs; the product word finds garbanzos.
 */
export function productSearchText(text: string): string {
  const body = normalize(text).replace(/[¿?]/g, " ").replace(LEAD_IN, "").trim();
  return body
    .split(" ")
    .filter((w) => w.length > 1 && !SEARCH_STOPWORDS.has(w))
    .join(" ")
    .trim();
}

// "Sí, por favor", "me confirma" after the offer: one or more of these.
const AFFIRMATIVE = /^((si|ok|okey|dale|claro|bueno|ya|por favor|porfavor|porfa|anotelo|agreguelo|apuntelo|de una|perfecto|me confirma|me confirman|confirmeme|me lo anota|me anota)(?=$|[\s,.!])[\s,.!]*)+/i;

// "1 funda grande", "una caja de 12 unidades": how the offered product
// comes (its package and size), not another product.
const PACKAGED_QUANTITY = new RegExp(
  "^(\\d+(?:[.,]\\d+)?|un|una)\\s+" +
    "(?:funda|paquete|caja|saco|bolsa|sobre|frasco|botella|lata|galon|tarro|cubeta|rollo|docena|unidad|tubo|pote|bidon|quintal)(?:s|es)?" +
    "(?:\\s+(?:grandes?|medianas?|medianos?|pequenas?|pequenos?|chicas?|chicos?|familiar|personal|economica|economico))?" +
    "(?:\\s+de\\s+\\d+(?:[.,]\\d+)?\\s*[a-z]+)?\\s*(?:de\\s*)?$",
  "i",
);

/**
 * After the bot offered to add `product`: "sí" → "1 product", "sí, 10
 * metros" / "10 metros" → "10 metros product". Null when the reply isn't
 * an acceptance (the customer moved on).
 */
export function acceptOfferedProduct(text: string, product: string): string | null {
  // Accents off ("sí" → "si"): the words are matched, the quantity kept.
  const t = text.trim().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const affirmative = AFFIRMATIVE.test(t);
  const rest = t.replace(AFFIRMATIVE, "").replace(/^[\s,.!-]+/, "").trim();
  const packed = PACKAGED_QUANTITY.exec(rest);
  if (packed) return `${/^\d/.test(packed[1]) ? packed[1] : "1"} ${rest.slice(packed[1].length).trim().replace(/\s+de\s*$/i, "")} ${product}`;
  const quantity = /^\d+([.,]\d+)?\s*[a-záéíóúñ]*\.?\s*(de\s*)?$/i.test(rest) ? rest.replace(/\s*de\s*$/i, "") : "";
  if (affirmative && !rest) return `1 ${product}`;
  if (quantity && (affirmative || /^\d/.test(rest))) return `${quantity} ${product}`;
  return null;
}

export interface FlowAnswer {
  reply: string;
  /** The product asked about, when the reply offered to add it. */
  product: string | null;
  /** The catalog reference the reply relies on to say "sí, lo tenemos". */
  match?: string | null;
}

const GREETING_START =
  /^\s*¡?\s*(hola|buen[oa]s?(\s+(d[ií]as|tardes|noches))?|saludos)(\s+[\p{L}]+){0,2}\s*([!,.]+\s*(👋|😊|🙂|😃)?|👋|😊|🙂|😃)\s*/iu;

/** "¡Hola Eduardo! 👋 Sí, manejamos…" → "Sí, manejamos…": the menu already greeted them. */
export function withoutGreeting(reply: string): string {
  const rest = reply.replace(GREETING_START, "");
  if (!rest.trim() || rest === reply) return reply;
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

const STOCK_CLAIM =
  /^(¡?\s*s[ií]\s*[!,.]*\s*)?(lo |la |los |las )?(manejamos|tenemos|contamos con|disponemos de)\b[^.!?¿\n]*[.!]*\s*(👍|😊|🙂)?\s*/iu;

/** A catalog reference names the product: "arroz" in "ARROZ FLOR 5 LB", "chapa" in "CERRADURA NOVA…". */
export function catalogHasProduct(product: string, names: string[]): boolean {
  const plain = (t: string) => t.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const head = productKey(plain(product));
  const stem = head.length > 4 ? head.replace(/(es|s)$/, "") : head;
  if (stem.length < 3) return false;
  return names.some((n) => plain(n).split(/[^a-z0-9]+/).some((w) => w.startsWith(stem)));
}

/**
 * "¡Sí! Manejamos dulces de guayaba…" said with nothing in the catalog
 * behind it (Nov 9: "sí, manejamos adhesivos", "sí, manejamos chapas"):
 * the claim goes, an advisor confirms.
 */
export function withoutStockClaim(reply: string): string {
  const rest = reply.replace(STOCK_CLAIM, "");
  if (rest === reply) return reply;
  const tail = rest.trim();
  if (/asesor[a]? le confirma/i.test(tail)) return tail.charAt(0).toUpperCase() + tail.slice(1);
  return `Un asesor le confirma si lo tenemos 🙂${tail ? ` ${tail}` : ""}`;
}

export function parseFlowAnswer(raw: string): FlowAnswer | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const j = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    const reply = typeof j.reply === "string" ? j.reply.trim() : "";
    if (!reply) return null;
    const product = typeof j.product === "string" && j.product.trim() ? j.product.trim() : null;
    const match = typeof j.match === "string" && j.match.trim() ? j.match.trim() : null;
    return { reply, product, match };
  } catch {
    return null;
  }
}

const SITUATION: Record<"menu" | "order" | "other", string> = {
  menu: 'El cliente está viendo el menú. Al final invítalo en pocas palabras a escribir lo que necesita o elegir una opción (ej. "Si desea, escríbame lo que necesita y se lo anoto 🙂").',
  order: 'El cliente está armando su lista de compras. Al final, en pocas palabras, invítalo a seguir (ej. "¿Qué más necesita?").',
  other: "El cliente está en medio de otro paso; responde y deja que continúe.",
};

/** One short, grounded answer to a question asked mid-flow (see the module note). */
/** The conversation's last few messages before this one, oldest first. */
export async function recentMessages(
  db: SupabaseClient,
  conversationId: string,
  current: string,
): Promise<{ who: "Cliente" | "Tienda"; text: string }[]> {
  const { data } = await db
    .from("messages")
    .select("sender_type, content_text")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(9);
  const rows = ((data ?? []) as { sender_type: string; content_text: string | null }[])
    .filter((m) => m.content_text?.trim())
    .map((m) => ({
      who: (m.sender_type === "customer" ? "Cliente" : "Tienda") as "Cliente" | "Tienda",
      text: m.content_text!.replace(/\s+/g, " ").trim().slice(0, 200),
    }))
    .reverse();
  // The question itself is usually already stored: leave it out.
  if (rows.at(-1)?.who === "Cliente" && rows.at(-1)?.text === current.replace(/\s+/g, " ").trim().slice(0, 200)) rows.pop();
  return rows.slice(-8);
}

/** Someone (the customer or the store) wrote in this chat in the last 10 minutes, besides this question. */
async function talkedLately(db: SupabaseClient, conversationId: string, current: string): Promise<boolean> {
  const { data } = await db
    .from("messages")
    .select("sender_type, content_text")
    .eq("conversation_id", conversationId)
    .gte("created_at", new Date(Date.now() - 10 * 60_000).toISOString())
    .limit(5);
  return ((data ?? []) as { sender_type: string; content_text: string | null }[]).some(
    (m) => !(m.sender_type === "customer" && (m.content_text ?? "").trim() === current.trim()),
  );
}

export async function answerInFlow(
  db: SupabaseClient,
  accountId: string,
  conversationId: string | null,
  question: string,
  situation: "menu" | "order" | "other",
): Promise<FlowAnswer | null> {
  let config;
  try {
    config = await loadAiConfig(db, accountId);
  } catch {
    return null;
  }
  if (!config?.apiKey) return null;
  const biz = await loadBusinessSettings(db, accountId);
  // The last messages, so "¿tiene plateadas?" is read as "cucharas
  // plateadas" (not "gafas"), and the bot doesn't greet again mid-chat.
  const recent = conversationId ? await recentMessages(db, conversationId, question) : [];
  const previousAsk = [...recent].reverse().find((m) => m.who === "Cliente")?.text ?? "";
  const searches = [productSearchText(question) || question];
  if (previousAsk && (productSearchText(question) || question).split(" ").length <= 3) {
    searches.unshift(`${productSearchText(previousAsk)} ${productSearchText(question)}`.trim());
  }
  const found = await Promise.all(searches.map((q) => retrieveCatalogProducts(db, accountId, q, 8).catch(() => [])));
  const hints = [...new Map(found.flat().map((h) => [h.name, h])).values()].slice(0, 10);
  // Greeting and question sent together ("Buenas noches" + "¿tiene
  // afix?"): the menu already said hello.
  const greeted = conversationId ? await talkedLately(db, conversationId, question) : false;
  const system = [
    businessIntro(biz),
    `Respondes por WhatsApp una pregunta de un cliente. Trata al cliente de "usted" (sin decir "usted" suelto como saludo: nada de "Buenas tardes, usted"); sé cálido, claro y breve (1 a 3 frases). Si el cliente escribe en inglés u otro idioma, responde en ese idioma.`,
    `Reglas:
- NUNCA des precios, rangos ni costos de envío: los confirma un asesor.
- Usa solo la información del negocio y las referencias del catálogo de abajo; no inventes datos. Si no sabes, dilo y ofrece que un asesor lo confirme.
- No ofrezcas servicios que no estén en la información del negocio (impresiones, copias, envíos especiales…): si preguntan por uno, di que un asesor le confirma. El "técnico a domicilio" es SOLO para trabajos en la casa del cliente (gasfitería, electricidad, pintura, reparaciones): nunca lo sugieras para otra cosa.
- Si pregunta si tenemos un producto: di que sí lo manejamos SOLO si una referencia del catálogo es claramente ese producto (no algo con nombre parecido: "grillete" no es "grilón"); no prometas stock exacto. Si no está claro en las referencias, di con amabilidad que no lo ves en el catálogo pero que lo anotas para que el asesor confirme. En ambos casos ofrece anotarlo preguntando la cantidad.
- Si el producto tiene muchos modelos (una chapa, una llave, un foco, una pintura) y el cliente no dijo para qué es, haz UNA sola pregunta general con 2 o 3 opciones de uso o tipo (ej. "¿La chapa es para dormitorio, baño o puerta principal?"). Nunca preguntes color, marca, modelo ni medidas: eso lo ve el asesor.
- "product": el producto por el que pregunta, nombre corto y claro (ej. "garbanzo", "timer digital"), SIEMPRE que pregunte por un producto, lo tengamos o no (si pregunta por varios, el primero). Si no pregunta por un producto, null.
- "match": si dices que sí lo tenemos, el nombre EXACTO (copiado) de la referencia del catálogo que es ese producto; si no, null.${greeted ? "\n- No saludes: ya se saludó al cliente hace un momento." : ""}
- ${SITUATION[situation]}
Responde SOLO con JSON: {"reply": "...", "product": "..." o null, "match": "..." o null}`,
    `Información del negocio:
- Horario: ${hoursInWords(biz) || "consultar"}.
${biz.websiteUrl ? `- Página web: ${biz.websiteUrl}\n` : ""}${biz.customerInfo.trim() ? biz.customerInfo.trim() : ""}`,
    campaignsForAi(biz.menuPromos, biz.seasonalReplies, localDate(biz.utcOffsetHours)),
    recent.length
      ? `Conversación reciente (para entender a qué se refiere; NO saludes de nuevo):\n${recent.map((m) => `${m.who}: ${m.text}`).join("\n")}`
      : "",
    `Referencias del catálogo (nombres abreviados del sistema, solo para saber si existe algo parecido): ${
      hints.map((h) => h.name).join(" | ") || "(ninguna)"
    }`,
  ].filter(Boolean).join("\n\n");
  try {
    const args = {
      apiKey: config.apiKey,
      model: config.model,
      systemPrompt: system,
      messages: [{ role: "user" as const, content: question.slice(0, 1000) }],
      timeoutMs: Math.min(aiRequestTimeoutMs(), ANSWER_TIMEOUT_MS),
    };
    const result = config.provider === "openai" ? await generateOpenAi(args) : await generateAnthropic(args);
    void logAiUsage(db, {
      accountId,
      conversationId,
      mode: "auto_reply",
      provider: config.provider,
      model: config.model,
      usage: result.usage,
    });
    const answer = parseFlowAnswer(result.text);
    if (!answer) return null;
    let reply = greeted ? withoutGreeting(answer.reply) : answer.reply;
    const names = hints.map((h) => h.name);
    const backed =
      (!!answer.match && names.some((n) => n.trim().toLowerCase() === answer.match!.toLowerCase())) ||
      (!!answer.product && catalogHasProduct(answer.product, names));
    if (answer.product && !backed) reply = withoutStockClaim(reply);
    return { ...answer, reply };
  } catch (err) {
    console.error("[question-answer] failed:", err);
    return null;
  }
}
