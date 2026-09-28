/**
 * AI help for turning a customer's typed order lines into a list a
 * clerk can pick from the shelf without calling the customer back.
 *
 * The store never quotes prices in chat (the catalog is too large and
 * messy to be sure which product is meant), so the catalog is used here
 * only as a HINT of which real variants exist — letting the model ask a
 * grounded question ("¿de 2 o de 3 litros?") instead of a generic one.
 * No prices ever reach the model.
 *
 * Two calls, each best-effort (any failure → null, and the caller keeps
 * the lines exactly as typed — clarification is a nicety, never a
 * reason to block or lose an order):
 *   1. reviewOrderLines: clean each line; if something a clerk would
 *      need is missing, ask ONE short combined question.
 *   2. applyClarificationAnswer: fold the customer's answer back into
 *      the lines. Never asks again, so the bot can't get stuck.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadAiConfig } from "../ai/config";
import { retrieveCatalogProducts } from "../ai/catalog";
import { aiRequestTimeoutMs } from "../ai/defaults";
import { generateAnthropic } from "../ai/providers/anthropic";
import { generateOpenAi } from "../ai/providers/openai";
import { logAiUsage } from "../ai/usage";
import type { AiConfig } from "../ai/types";

const CLARIFY_TIMEOUT_MS = 12_000;

export interface ReviewResult {
  lines: string[];
  question: string | null;
}

const SHARED_RULES = `Eres el asistente de pedidos de Ferrotienda, una tienda en Cuenca, Ecuador (supermercado, ferretería, bazar, papelería, panadería, cosméticos, accesorios de tecnología, mascotas).
Un cliente está armando por WhatsApp una lista de productos que luego un asesor va a cotizar y despachar.

Reglas:
- NUNCA hables de precios, costos, descuentos ni disponibilidad.
- No inventes datos que el cliente no dijo (marca, tamaño, color, cantidad).
- Si el cliente no dice cantidad, asume 1.
- Escribe cada línea así: cantidad + producto + detalles que el cliente dio (ej. "2 Coca-Cola de 3 litros", "1 foco LED de 12W rosca normal").
- Trata al cliente de "usted". Sé breve y cordial.
- Responde SOLO con JSON válido, sin texto antes ni después.`;

const REVIEW_INSTRUCTIONS = `${SHARED_RULES}

Tarea: revisa las líneas del pedido. Si una línea es vaga y a un empleado le faltaría un dato para tomar el producto correcto de la percha (tamaño, presentación, medida, watts, color, sabor, tipo), escribe UNA pregunta corta para el cliente. Usa las referencias del catálogo solo para sugerir opciones reales (ej. "¿de 2 litros o de 3 litros?"); no menciones códigos. NO preguntes si la línea ya es razonablemente clara (ej. "1 libra de arroz", "10 panes de agua", "1 cuaderno de 100 hojas cuadros"). Las referencias pueden estar incompletas: si no ves todas las presentaciones, pregunta de forma abierta con ejemplos comunes (ej. "¿De qué tamaño: 1, 2 o 3 litros?") en vez de limitarte a las referencias.
Nombra siempre el producto en la pregunta (ej. "¿La Coca-Cola la desea de 1, 2 o 3 litros?").
Si hay una sola línea vaga, haz una sola pregunta corta. Si hay varias, empieza con "Para anotar bien su pedido:" y pon una línea por producto con viñeta "•" (ej. "• Foco: ¿LED o ahorrador? ¿De cuántos watts?"), máximo 3 productos.

Formato: {"lines": ["línea 1", "línea 2"], "question": "pregunta" o null}
"lines" debe tener una entrada por cada línea recibida, en el mismo orden.`;

const APPLY_INSTRUCTIONS = `${SHARED_RULES}

Tarea: al cliente se le hizo una pregunta sobre su pedido y respondió. Reescribe las líneas incorporando lo que respondió. Si la respuesta no aclara algo, deja esa línea como estaba. Si en la respuesta pide productos nuevos, agrégalos como líneas nuevas al final. No hagas más preguntas.

Formato: {"lines": ["línea 1", "línea 2"]}`;

/**
 * The catalog search query for a line: without the quantity and vague
 * size words, which only dilute trigram matching — "1 coca cola grande"
 * found no 3-litre bottle, "coca cola" finds every size.
 */
const VAGUE_WORDS = new Set([
  "un", "una", "unos", "unas", "de", "del", "la", "el", "los", "las",
  "grande", "grandes", "pequeño", "pequeña", "pequeños", "pequeñas",
  "mediano", "mediana", "chico", "chica", "normal", "porfa", "porfavor", "favor",
]);

export function hintQuery(line: string): string {
  const words = line
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w && !/^\d+$/.test(w) && !VAGUE_WORDS.has(w));
  return words.length > 0 ? words.join(" ") : line;
}

/** First {...} block in the model output, parsed; null if none/invalid. */
export function extractJson(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function cleanLines(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const lines = value
    .filter((l): l is string => typeof l === "string")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return lines.length > 0 ? lines : null;
}

/**
 * Validate a review response. The model must return one line per input
 * line — a response that drops or merges lines could silently lose an
 * item, so it's rejected (caller keeps the original lines).
 */
export function parseReviewResponse(raw: string, inputCount: number): ReviewResult | null {
  const json = extractJson(raw);
  if (!json) return null;
  const lines = cleanLines(json.lines);
  if (!lines || lines.length !== inputCount) return null;
  const question =
    typeof json.question === "string" && json.question.trim() ? json.question.trim() : null;
  return { lines, question };
}

/** An answer may add items but must not lose any. */
export function parseApplyResponse(raw: string, minCount: number): string[] | null {
  const json = extractJson(raw);
  const lines = json ? cleanLines(json.lines) : null;
  return lines && lines.length >= minCount ? lines : null;
}

/** Replace the last `count` lines of a newline-joined list. */
export function replaceTrailingLines(
  list: string,
  count: number,
  replacement: string[],
): string {
  const lines = list.split("\n").filter((l) => l.trim());
  const kept = lines.slice(0, Math.max(0, lines.length - count));
  return [...kept, ...replacement].join("\n");
}

async function callModel(
  db: SupabaseClient,
  config: AiConfig,
  accountId: string,
  conversationId: string | null,
  systemPrompt: string,
  userContent: string,
): Promise<string> {
  const args = {
    apiKey: config.apiKey,
    model: config.model,
    systemPrompt,
    messages: [{ role: "user" as const, content: userContent }],
    // A customer is waiting mid-conversation: cap well below the general
    // AI timeout — on timeout the lines are simply kept as typed.
    timeoutMs: Math.min(aiRequestTimeoutMs(), CLARIFY_TIMEOUT_MS),
  };
  const result =
    config.provider === "openai" ? await generateOpenAi(args) : await generateAnthropic(args);
  // ai_usage_log only knows 'auto_reply' | 'draft'; this is bot-side
  // (customer-facing, unattended) work, so it's accounted as auto_reply.
  void logAiUsage(db, {
    accountId,
    conversationId,
    mode: "auto_reply",
    provider: config.provider,
    model: config.model,
    usage: result.usage,
  });
  return result.text;
}

async function loadConfig(db: SupabaseClient, accountId: string): Promise<AiConfig | null> {
  try {
    return await loadAiConfig(db, accountId);
  } catch (err) {
    console.error("[order-clarify] AI config unavailable:", err);
    return null;
  }
}

export async function reviewOrderLines(
  db: SupabaseClient,
  accountId: string,
  conversationId: string | null,
  lines: string[],
): Promise<ReviewResult | null> {
  if (lines.length === 0) return null;
  const config = await loadConfig(db, accountId);
  if (!config) return null;
  try {
    const hints = await Promise.all(
      lines.map((line) =>
        retrieveCatalogProducts(db, accountId, hintQuery(line), 8).catch(() => []),
      ),
    );
    const content =
      "Líneas del pedido:\n" +
      lines.map((l, i) => `${i + 1}. ${l}`).join("\n") +
      "\n\nReferencias del catálogo (nombres abreviados del sistema; solo para sugerir opciones, pueden no coincidir):\n" +
      lines
        .map((_, i) => `${i + 1}. ${hints[i].map((h) => h.name).join(" | ") || "(sin referencias)"}`)
        .join("\n");
    const raw = await callModel(db, config, accountId, conversationId, REVIEW_INSTRUCTIONS, content);
    return parseReviewResponse(raw, lines.length);
  } catch (err) {
    console.error("[order-clarify] review failed:", err);
    return null;
  }
}

export async function applyClarificationAnswer(
  db: SupabaseClient,
  accountId: string,
  conversationId: string | null,
  args: { lines: string[]; question: string; answer: string },
): Promise<string[] | null> {
  const config = await loadConfig(db, accountId);
  if (!config) return null;
  try {
    const content =
      "Líneas del pedido:\n" +
      args.lines.map((l, i) => `${i + 1}. ${l}`).join("\n") +
      `\n\nPregunta que se le hizo al cliente: ${args.question}` +
      `\nRespuesta del cliente: ${args.answer}`;
    const raw = await callModel(db, config, accountId, conversationId, APPLY_INSTRUCTIONS, content);
    return parseApplyResponse(raw, args.lines.length);
  } catch (err) {
    console.error("[order-clarify] apply failed:", err);
    return null;
  }
}
