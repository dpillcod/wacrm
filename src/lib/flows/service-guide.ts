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
  if (!question && !summary) return null;
  return { question, summary, tip: str(j.tip) };
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
Responde SOLO con JSON: {"question": "..." o null, "tip": "..." o null, "summary": "..."}`;
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
    if (step && args.remaining <= 0) step.question = null;
    return step;
  } catch (err) {
    console.error("[service-guide] failed:", err);
    return null;
  }
}
