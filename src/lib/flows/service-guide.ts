/**
 * An AI "service advisor" for home-service requests (plumbing,
 * electricity, painting, locks…): after the customer says what's wrong,
 * it asks the few things the person in charge needs to plan the visit —
 * one short question at a time — and writes a clear summary of the job.
 *
 * It never quotes prices or times: the job has to be seen first, and the
 * person in charge confirms the cost with the customer. When something
 * is urgent (a leak, sparks) it may add one safety tip.
 *
 * Best-effort: any failure returns null and the request simply goes on
 * with what the customer already said.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadAiConfig } from "../ai/config";
import { aiRequestTimeoutMs } from "../ai/defaults";
import { generateAnthropic } from "../ai/providers/anthropic";
import { generateOpenAi } from "../ai/providers/openai";
import { logAiUsage } from "../ai/usage";
import { loadBusinessSettings } from "../business/settings";

const GUIDE_TIMEOUT_MS = 12_000;

export interface GuideAnswer {
  q: string;
  a: string;
}

export interface GuideStep {
  /** The next question for the customer, or null when there's enough to plan the visit. */
  question: string | null;
  /** The job in 1–3 plain lines, for the person in charge ("" while still asking). */
  summary: string;
  /** One short safety tip for an urgent problem, if any. */
  tip: string | null;
  /**
   * Set when the customer only wants to BUY something (a tool, a part,
   * material) — no job to do: what to put on their order, e.g.
   * "1 destornillador Torx T9". The flow then continues as an order.
   */
  purchase?: string | null;
  /** The question is "just buy it, or have it installed?" — asked with two buttons. */
  buyOrInstall?: boolean;
}

/** Model reply → GuideStep; null when it isn't the expected JSON. */
export function parseGuideStep(raw: string): GuideStep | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  // While still asking, the model may leave the summary for later.
  const question = str(j.question);
  const summary = str(j.summary) ?? "";
  const purchase = str(j.purchase);
  if (purchase) return { question: null, summary, tip: null, purchase };
  if (!question && !summary) return null;
  const step: GuideStep = { question, summary, tip: str(j.tip) };
  if (question && j.buy_or_install === true) step.buyOrInstall = true;
  return step;
}

const plainText = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

// Words that mean there IS a job to do (someone has to come or work).
const JOB_WORDS =
  /\b(tecnic[oa]s?|maestro|gasfiter[oa]|plomer[oa]|electricista|pintor|instal\w*|arregl\w*|repar\w*|pinten|pintar|cambien|revis\w*|visita|que (vaya|venga|vengan|vayan))\b/;
const PURCHASE_PATTERNS = [
  // "solo comprar la herramienta", "solo necesito el destornillador", "nomás eso"
  /\b(solo|solamente|nomas|no mas|unicamente)\s+(quiero\s+|necesito\s+|deseo\s+|busco\s+|era\s+|es\s+)?(comprar|compro|el|la|los|las|un|una|unos|unas|eso|esa|ese|para comprar)\b/,
  // "quiero comprar…", "necesito comprar…"
  /\b(quiero|quisiera|deseo|necesito|busco|voy a|vengo a)\s+comprar\b/,
  // "no necesito técnico", "no quiero que vengan"
  /\bno\s+(necesito|quiero|requiero|hace falta)\s+(un\s+|una\s+|el\s+|al\s+|que\s+)?(tecnic\w*|servicio|visita|que (vaya|venga|vengan)|maestro)/,
  // "es para comprar", "solo la herramienta"
  /\b(es|era)\s+(solo\s+)?para\s+comprar\b/,
  /\bsolo\s+(la|el)\s+(herramienta|producto|repuesto|material|pieza)\b/,
];

/**
 * "Solo quiero comprar la herramienta", "solo necesito el destornillador",
 * "no necesito técnico": during a service request, the customer actually
 * wants to buy something. Phrases that name a job ("que venga un técnico a
 * instalarlo") don't count, except an explicit "no necesito técnico".
 */
export function isPurchaseOnly(text: string): boolean {
  const t = plainText(text);
  if (!t) return false;
  if (/\bno\s+(necesito|quiero|requiero|hace falta)\s+(un\s+|una\s+|el\s+|al\s+|que\s+)?(tecnic|servicio|visita|que (vaya|venga|vengan)|maestro)/.test(t)) {
    return true;
  }
  if (JOB_WORDS.test(t)) return false;
  return PURCHASE_PATTERNS.some((p) => p.test(t));
}

const GENERIC_ITEM = /^(la |el |los |las |un |una |unos |unas )?(herramienta|producto|repuesto|material|pieza|eso|esa|ese|nada mas|nada)$/;

/**
 * The product to put on the order, from the purchase phrase ("solo
 * necesito el destornillador" → "destornillador"), or "" when the phrase
 * doesn't name one ("solo comprar la herramienta") — the caller then uses
 * what the customer first described.
 */
export function purchaseItemFrom(text: string): string {
  let t = plainText(text)
    .replace(/[.!¡¿?,]+/g, " ")
    .replace(/\b(solo|solamente|nomas|no mas|unicamente|quiero|quisiera|deseo|necesito|busco|voy a|vengo a|comprar|compro|para|es|era|gracias|por favor)\b/g, " ")
    .replace(/\bno\s+(un\s+|una\s+|el\s+|al\s+|que\s+)?(tecnic\w*|servicio|visita|maestro)\b.*$/, " ")
    .replace(/\s+/g, " ")
    .trim();
  t = t.replace(/^(el|la|los|las)\s+/, "");
  return t.length < 3 || GENERIC_ITEM.test(t) ? "" : t;
}

export type GuideKind = "home_service" | "bakery";

function bakeryInstructions(business: string): string {
  return `Eres quien toma los encargos de pastelería y panadería de ${business} por WhatsApp (tortas por encargo, bocaditos y pan para eventos o negocios). Tu objetivo: que el encargado tenga todo lo necesario para preparar el pedido sin volver a preguntar.

Reglas:
- NUNCA des precios ni montos de anticipo: el encargado confirma el precio y el anticipo.
- Los encargos se hacen con al menos 1 día de anticipación. Si el cliente lo quiere para hoy, dile con amabilidad que necesitamos un día y pregunta si le sirve para mañana.
- Pregunta solo lo que falte, juntando datos en una sola pregunta cuando se pueda, con ejemplos. Lo que sirve saber:
  torta: ocasión, para cuántas personas, sabor y relleno, decoración o texto que lleve, fecha y hora en que la necesita;
  bocaditos: tipo (dulces, salados o mixtos), cantidad, fecha y hora;
  pan: tipo y cantidad, fecha, y si es un pedido que se repite (diario o semanal).
- Si el cliente ya lo dijo, no lo vuelvas a preguntar. Si ya está claro, o ya hiciste las preguntas permitidas, "question": null. Nunca preguntes por permiso o confirmación; no preguntes cómo lo recibe (se pregunta después).
- Si el cliente pregunta el precio, en la pregunta siguiente dile primero en pocas palabras que el encargado le confirma el precio y el anticipo, y sigue.
- "tip": null siempre.
- Trata al cliente de "usted". Sé cálido y breve.
- "summary": el encargo en 1 a 3 líneas claras para el encargado (qué, para cuántos, sabor/detalles, fecha y hora), sin saludos.
Responde SOLO con JSON: {"question": "..." o null, "tip": null, "summary": "..."}`;
}

function instructions(business: string, kind: GuideKind = "home_service"): string {
  if (kind === "bakery") return bakeryInstructions(business);
  return `Eres el asesor de mantenimiento y reparaciones de ${business}. Un cliente pide por WhatsApp un trabajo en su casa o local (gasfitería, eléctricos, pintura, reparaciones del hogar u otro trabajo). Tu objetivo: entender bien el trabajo para que el encargado de servicio al cliente pueda organizar la visita del técnico sin volver a preguntar.

Reglas:
- NUNCA des precios, costos, rangos ni tiempos de llegada: el trabajo se revisa primero y el encargado confirma el costo con el cliente.
- Pregunta solo lo que de verdad hace falta y que el cliente pueda responder fácil, UNA pregunta corta a la vez, con ejemplos de respuesta. Ejemplos de lo que sirve saber:
  gasfitería: dónde es (baño, cocina, patio), qué falla (gotea, no sale agua, tapado), desde cuándo, si la llave de paso cierra;
  eléctricos: qué no funciona, si saltó el breaker, si hay chispas u olor a quemado, cuántos puntos;
  pintura: interior o exterior, qué espacios y medida aproximada (m² o número de paredes), si ya tiene la pintura o necesita que se la cotice, estado de la pared (humedad, grietas);
  reparaciones del hogar: qué hay que arreglar (chapa, puerta, cerámica, techo, gypsum…), dónde y medida o cantidad aproximada.
- No repitas lo que el cliente ya dijo. Si ya está claro, o ya hiciste las preguntas permitidas, "question": null. Mejor pocas preguntas: el técnico verá el resto en la visita.
- Nunca preguntes por permiso o confirmación ("¿le parece bien que…?", "¿está de acuerdo…?"): solo datos del trabajo. No preguntes la dirección ni el horario (se piden después).
- Si el cliente pregunta el precio, en la pregunta siguiente dile primero en pocas palabras que el costo se lo confirma el encargado al revisar el trabajo, y sigue.
- "tip" SOLO si hay un riesgo real ahora mismo (agua saliendo sin control, chispas, olor a quemado o a gas): UN consejo de seguridad corto (ej. "Mientras tanto, cierre la llave de paso del agua"). En cualquier otro caso, "tip": null.
- Trata al cliente de "usted". Sé cálido y breve.
- "summary": el trabajo en 1 a 3 líneas claras para el encargado (qué, dónde, detalles útiles), sin saludos.
- Si el cliente en realidad solo quiere COMPRAR un producto, herramienta, repuesto o material (no necesita que un técnico vaya), deja de preguntar: responde con "purchase" = lo que quiere comprar, con la cantidad si la dijo (ej. "1 destornillador Torx T9"), "question": null y "summary": "". Si el cliente solo nombra un producto o pieza (ej. "necesito una chapa", "un tomacorriente doble", "una llave para el lavabo") sin decir que hay que instalarlo, cambiarlo o repararlo, NO lo asumas: tu PRIMERA pregunta es si solo quiere comprarlo o que se lo instalen, en una pregunta corta, con "buy_or_install": true (el cliente responde con dos botones: "Solo comprarlo" / "Que lo instalen").
Responde SOLO con JSON: {"question": "..." o null, "tip": "..." o null, "summary": "...", "purchase": null o "...", "buy_or_install": true o false}`;
}

export async function nextGuideStep(
  db: SupabaseClient,
  accountId: string,
  conversationId: string | null,
  args: {
    /** e.g. "Servicio: Plomería" (from the flow). */
    context: string;
    /** What the customer first said. */
    initial: string;
    /** Questions asked so far and their answers. */
    answers: GuideAnswer[];
    /** Questions still allowed. */
    remaining: number;
    kind?: GuideKind;
  },
): Promise<GuideStep | null> {
  let config;
  try {
    config = await loadAiConfig(db, accountId);
  } catch {
    return null;
  }
  if (!config?.apiKey) return null;
  const biz = await loadBusinessSettings(db, accountId);
  const business = [biz.name || "la tienda", biz.city].filter(Boolean).join(", ");
  const content = [
    args.context.trim(),
    `Lo que dijo el cliente: ${args.initial}`,
    ...args.answers.map((x, i) => `Pregunta ${i + 1}: ${x.q}\nRespuesta: ${x.a}`),
    args.remaining > 0
      ? `Puedes hacer como máximo ${args.remaining} pregunta(s) más.`
      : 'Ya no puedes hacer más preguntas: "question" debe ser null.',
  ]
    .filter(Boolean)
    .join("\n\n");
  try {
    const callArgs = {
      apiKey: config.apiKey,
      model: config.model,
      systemPrompt: instructions(business, args.kind),
      messages: [{ role: "user" as const, content }],
      timeoutMs: Math.min(aiRequestTimeoutMs(), GUIDE_TIMEOUT_MS),
    };
    const result =
      config.provider === "openai" ? await generateOpenAi(callArgs) : await generateAnthropic(callArgs);
    void logAiUsage(db, {
      accountId,
      conversationId,
      mode: "auto_reply",
      provider: config.provider,
      model: config.model,
      usage: result.usage,
    });
    const step = parseGuideStep(result.text);
    if (step && args.kind === "bakery") {
      step.purchase = null;
      step.buyOrInstall = false;
    }
    if (step && args.remaining <= 0) step.question = null;
    return step;
  } catch (err) {
    console.error("[service-guide] failed:", err);
    return null;
  }
}
