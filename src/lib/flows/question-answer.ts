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
import { businessIntro } from "./order-clarify";
import { hoursInWords } from "./store-policy";

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
  /^((hola|buenas|buenos|buen|dias|tardes|noches|como esta|como estan|que tal|disculpe|disculpa|perdon|por favor|porfa|una pregunta|una consulta|consulta|pregunta|estimado|estimada|amigo|amiga|señorita|senorita|joven|oiga|oye)[\s,]*)+/;

const QUESTION_START =
  /^(tiene|tienen|tendra|tendran|tendras|hay|habra|dispone|disponen|venden|vende|manejan|maneja|hacen|hace|realizan|aceptan|acepta|reciben|puedo|puede|pueden|se puede|como|donde|cuando|a que hora|hasta que hora|desde que hora|que|cual|cuales|cuanto|cuantos|cuanta|envian|entregan|llevan|trabajan|atienden|abren|cierran|facturan|me pueden|me puede|quisiera saber|queria saber|sabe si|saben si|existe|consiguen|traen)\b/;

/**
 * Whether a message is a question rather than an order line: it has a
 * question mark, or (after any greeting) starts like one — "tiene…",
 * "hay…", "¿hacen envíos?". A line starting with a quantity is an order
 * line ("2 coca cola ?" included).
 */
export function looksLikeQuestion(text: string): boolean {
  const n = normalize(text);
  if (!n) return false;
  const body = n.replace(/[¿?]/g, " ").replace(LEAD_IN, "").trim();
  if (!body || /^\d/.test(body)) return false;
  if (/^que tal\b/.test(n) && body.split(" ").length <= 1) return false;
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

const AFFIRMATIVE = /^(si|ok|okey|dale|claro|bueno|ya|por favor|porfa|anotelo|agreguelo|apuntelo|de una|perfecto)(?=$|[\s,.!])[\s,.!]*/i;

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
  const quantity = /^\d+([.,]\d+)?\s*[a-záéíóúñ]*\.?\s*(de\s*)?$/i.test(rest) ? rest.replace(/\s*de\s*$/i, "") : "";
  if (affirmative && !rest) return `1 ${product}`;
  if (quantity && (affirmative || /^\d/.test(rest))) return `${quantity} ${product}`;
  return null;
}

export interface FlowAnswer {
  reply: string;
  /** The product asked about, when the reply offered to add it. */
  product: string | null;
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
    return { reply, product };
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
  const hints = await retrieveCatalogProducts(db, accountId, productSearchText(question) || question, 8).catch(() => []);
  const system = [
    businessIntro(biz),
    `Respondes por WhatsApp una pregunta de un cliente. Trata al cliente de "usted"; sé cálido, claro y breve (1 a 3 frases).`,
    `Reglas:
- NUNCA des precios, rangos ni costos de envío: los confirma un asesor.
- Usa solo la información del negocio y las referencias del catálogo de abajo; no inventes datos. Si no sabes, dilo y ofrece que un asesor lo confirme.
- Si pregunta si tenemos un producto: di que sí lo manejamos SOLO si una referencia del catálogo es claramente ese producto (no algo con nombre parecido: "grillete" no es "grilón"); no prometas stock exacto. Si no está claro en las referencias, di con amabilidad que no lo ves en el catálogo pero que lo anotas para que el asesor confirme. En ambos casos ofrece anotarlo preguntando la cantidad o la medida.
- "product": el producto por el que pregunta, nombre corto y claro (ej. "garbanzo", "timer digital"), SIEMPRE que pregunte por un producto, lo tengamos o no. Si no pregunta por un producto, null.
- ${SITUATION[situation]}
Responde SOLO con JSON: {"reply": "...", "product": "..." o null}`,
    `Información del negocio:
- Horario: ${hoursInWords(biz) || "consultar"}.
${biz.websiteUrl ? `- Página web: ${biz.websiteUrl}\n` : ""}${biz.customerInfo.trim() ? biz.customerInfo.trim() : ""}`,
    `Referencias del catálogo (nombres abreviados del sistema, solo para saber si existe algo parecido): ${
      hints.map((h) => h.name).join(" | ") || "(ninguna)"
    }`,
  ].join("\n\n");
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
    return parseFlowAnswer(result.text);
  } catch (err) {
    console.error("[question-answer] failed:", err);
    return null;
  }
}
