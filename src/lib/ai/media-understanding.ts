/**
 * AI that turns what customers send the way they actually send it —
 * voice notes, a photo of a handwritten shopping list, a whole order in
 * the first message — into something the order flow can use.
 *
 *   transcribeAudio      voice note → text (any OpenAI-compatible
 *                        transcription API: Groq's free tier by default)
 *   readImage            photo → order lines (a written list, or a
 *                        product photographed), or "not an order"
 *   classifyFirstMessage free text with no bot conversation running →
 *                        is it an order (and its lines), a question, or
 *                        a request for a person?
 *
 * All best-effort: any failure returns null and the caller carries on
 * exactly as before (the inbox still has the original message).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadAiConfig } from "./config";
import { logAiUsage } from "./usage";
import type { AiConfig } from "./types";
import { normalizeUsage } from "./providers/shared";
import { decrypt } from "../whatsapp/encryption";
import { getMediaUrl, downloadMedia } from "../whatsapp/meta-api";
import { loadBusinessSettings } from "../business/settings";
import { businessIntro } from "../flows/order-clarify";

const MEDIA_TIMEOUT_MS = 25_000;
/** Images above this are not sent to the model (WhatsApp photos are ~100–400 KB). */
const MAX_IMAGE_BYTES = 4_500_000;
/** Voice notes above this (~10+ minutes) are not transcribed. */
const MAX_AUDIO_BYTES = 20_000_000;

export interface InboundMedia {
  buffer: Buffer;
  mimeType: string;
}

/** "/api/whatsapp/media/123" or "https://host/api/whatsapp/media/123" → "123". */
export function mediaIdFromUrl(url: string | null | undefined): string | null {
  const m = url?.match(/\/api\/whatsapp\/media\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

/** The bytes of a customer's photo or voice note, straight from Meta. */
export async function loadInboundMedia(
  db: SupabaseClient,
  accountId: string,
  mediaUrl: string | null | undefined,
): Promise<InboundMedia | null> {
  const mediaId = mediaIdFromUrl(mediaUrl);
  if (!mediaId) return null;
  try {
    const { data } = await db
      .from("whatsapp_config")
      .select("access_token")
      .eq("account_id", accountId)
      .maybeSingle();
    const token = (data as { access_token?: string } | null)?.access_token;
    if (!token) return null;
    const accessToken = decrypt(token);
    const { url, mimeType } = await getMediaUrl({ mediaId, accessToken });
    const { buffer, contentType } = await downloadMedia({ downloadUrl: url, accessToken });
    return { buffer, mimeType: (mimeType || contentType).split(";")[0].trim() };
  } catch (err) {
    console.error("[media-understanding] media download failed:", err);
    return null;
  }
}

// ---------------------------------------------------------------- audio

interface TranscriptionTarget {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/**
 * Where voice notes are transcribed: TRANSCRIBE_API_KEY (+ optional
 * TRANSCRIBE_BASE_URL / TRANSCRIBE_MODEL; defaults to Groq's free
 * Whisper), else the account's own OpenAI key. Anthropic has no
 * speech-to-text, so an Anthropic-only account needs the env key.
 */
export function transcriptionTarget(config: AiConfig | null): TranscriptionTarget | null {
  const envKey = process.env.TRANSCRIBE_API_KEY;
  if (envKey) {
    return {
      baseUrl: (process.env.TRANSCRIBE_BASE_URL || "https://api.groq.com/openai/v1").replace(/\/+$/, ""),
      apiKey: envKey,
      model: process.env.TRANSCRIBE_MODEL || "whisper-large-v3-turbo",
    };
  }
  if (config?.provider === "openai" && config.apiKey) {
    return { baseUrl: "https://api.openai.com/v1", apiKey: config.apiKey, model: "gpt-4o-mini-transcribe" };
  }
  return null;
}

function audioFileName(mimeType: string): string {
  const ext = mimeType.includes("ogg") ? "ogg"
    : mimeType.includes("mpeg") ? "mp3"
    : mimeType.includes("mp4") || mimeType.includes("m4a") || mimeType.includes("aac") ? "m4a"
    : mimeType.includes("amr") ? "amr"
    : "ogg";
  return `audio.${ext}`;
}

/** A voice note as text, or null (not configured, too long, failed, silent). */
export async function transcribeAudio(
  db: SupabaseClient,
  accountId: string,
  mediaUrl: string | null | undefined,
): Promise<string | null> {
  let config: AiConfig | null = null;
  try {
    config = await loadAiConfig(db, accountId);
  } catch {
    config = null;
  }
  const target = transcriptionTarget(config);
  if (!target) return null;
  const media = await loadInboundMedia(db, accountId, mediaUrl);
  if (!media || media.buffer.length > MAX_AUDIO_BYTES) return null;
  try {
    const form = new FormData();
    form.append(
      "file",
      new Blob([new Uint8Array(media.buffer)], { type: media.mimeType }),
      audioFileName(media.mimeType),
    );
    form.append("model", target.model);
    form.append("language", "es");
    form.append("response_format", "json");
    const res = await fetch(`${target.baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${target.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(MEDIA_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error("[media-understanding] transcription HTTP", res.status, (await res.text()).slice(0, 200));
      return null;
    }
    const data = (await res.json()) as { text?: string };
    const text = data.text?.trim() ?? "";
    return text.length > 0 ? text : null;
  } catch (err) {
    console.error("[media-understanding] transcription failed:", err);
    return null;
  }
}

// ---------------------------------------------------------------- vision + routing

export type ImageReading =
  | { kind: "list"; lines: string[] }
  | { kind: "product"; lines: string[] }
  | { kind: "receipt"; summary: string }
  | { kind: "other"; summary: string };

export interface FirstMessageRoute {
  intent: "order" | "service" | "question" | "human" | "other";
  lines: string[];
}

/** First {...} block of a model reply, parsed; null when there is none. */
function firstJson(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const v = JSON.parse(raw.slice(start, end + 1));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function cleanLines(v: unknown, max = 40): string[] {
  return Array.isArray(v)
    ? v.filter((l): l is string => typeof l === "string")
        .map((l) => l.replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .slice(0, max)
    : [];
}

export function parseImageReading(raw: string): ImageReading | null {
  const j = firstJson(raw);
  if (!j) return null;
  const lines = cleanLines(j.lines);
  const summary = typeof j.summary === "string" ? j.summary.trim() : "";
  if ((j.kind === "list" || j.kind === "product") && lines.length > 0) {
    return { kind: j.kind, lines };
  }
  if (j.kind === "receipt") return { kind: "receipt", summary };
  return { kind: "other", summary };
}

export function parseFirstMessageRoute(raw: string): FirstMessageRoute | null {
  const j = firstJson(raw);
  if (!j) return null;
  const intent = j.intent;
  if (intent !== "order" && intent !== "service" && intent !== "question" && intent !== "human" && intent !== "other") {
    return null;
  }
  const lines = cleanLines(j.lines);
  if (intent === "order" && lines.length === 0) return { intent: "other", lines: [] };
  return { intent, lines: intent === "order" ? lines : [] };
}

const LINE_RULES = `Escribe cada producto en una línea: cantidad + producto + detalles que se vean o se digan (ej. "2 Coca-Cola de 3 litros", "1 libra de queso fresco"). Si no hay cantidad, pon 1. No inventes marcas ni tamaños. Nunca hables de precios.`;

const IMAGE_TASK = `Un cliente envió esta foto por WhatsApp mientras arma un pedido.
- Si es una LISTA de compras (escrita a mano, impresa o una captura): transcribe cada producto. ${LINE_RULES} Ignora tachones y precios escritos.
- Si es la foto de un PRODUCTO o repuesto que quiere (ej. una llave de agua, un foco, un envase): describe ese producto para que un empleado lo encuentre en la percha (tipo, marca y medida si se ven), como una sola línea con cantidad 1.
- Si es un COMPROBANTE de pago o de transferencia: kind "receipt" y en "summary" el banco, el monto y la fecha que se vean.
- Si es otra cosa (selfie, paisaje, documento): kind "other", no inventes productos.
Responde SOLO con JSON: {"kind":"list"|"product"|"receipt"|"other","lines":["..."],"summary":"qué se ve, si es receipt u other"}`;

const ROUTE_TASK = `Este es un mensaje de un cliente por WhatsApp, sin una conversación de pedido abierta. Clasifícalo:
- "order": está pidiendo productos para comprar (ej. "quiero 2 panes y una leche", "me manda 1 foco y un cemento"). Extrae los productos en "lines". ${LINE_RULES}
- "service": necesita un TRABAJO en su casa o local (plomería, electricidad, pintura, cerrajería, arreglos: "se me dañó la llave del baño", "necesito un electricista", "quiero pintar la sala", "cambiar la chapa de la puerta").
- "question": pregunta algo (horario, ubicación, si tienen un producto, precio, cómo comprar) sin hacer todavía un pedido concreto.
- "human": pide hablar con una persona o asesor, o tiene un reclamo.
- "other": saludo, agradecimiento o cualquier otra cosa.
Responde SOLO con JSON: {"intent":"order"|"service"|"question"|"human"|"other","lines":["..."]}`;

async function callVisionOrText(
  db: SupabaseClient,
  config: AiConfig,
  accountId: string,
  conversationId: string | null,
  systemPrompt: string,
  content: { text: string; image?: InboundMedia },
): Promise<string> {
  const signal = AbortSignal.timeout(MEDIA_TIMEOUT_MS);
  let text = "";
  let usage: { input_tokens?: number; output_tokens?: number; prompt_tokens?: number; completion_tokens?: number } | undefined;
  if (config.provider === "openai") {
    const parts: unknown[] = [{ type: "text", text: content.text }];
    if (content.image) {
      parts.push({
        type: "image_url",
        image_url: { url: `data:${content.image.mimeType};base64,${content.image.buffer.toString("base64")}` },
      });
    }
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.model,
        max_tokens: 800,
        messages: [{ role: "system", content: systemPrompt }, { role: "user", content: parts }],
      }),
      signal,
    });
    if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}`);
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[]; usage?: typeof usage };
    text = data.choices?.[0]?.message?.content ?? "";
    usage = data.usage;
  } else {
    const parts: unknown[] = [];
    if (content.image) {
      parts.push({
        type: "image",
        source: { type: "base64", media_type: content.image.mimeType, data: content.image.buffer.toString("base64") },
      });
    }
    parts.push({ type: "text", text: content.text });
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.model,
        system: systemPrompt,
        max_tokens: 800,
        messages: [{ role: "user", content: parts }],
      }),
      signal,
    });
    if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}`);
    const data = (await res.json()) as { content?: { type?: string; text?: string }[]; usage?: typeof usage };
    text = (data.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
    usage = data.usage;
  }
  void logAiUsage(db, {
    accountId,
    conversationId,
    mode: "auto_reply",
    provider: config.provider,
    model: config.model,
    usage: normalizeUsage({
      prompt: usage?.input_tokens ?? usage?.prompt_tokens,
      completion: usage?.output_tokens ?? usage?.completion_tokens,
    }),
  });
  return text;
}

async function aiSetup(db: SupabaseClient, accountId: string) {
  let config: AiConfig | null = null;
  try {
    config = await loadAiConfig(db, accountId);
  } catch {
    return null;
  }
  if (!config?.apiKey) return null;
  const biz = await loadBusinessSettings(db, accountId);
  return { config, intro: businessIntro(biz) };
}

/** What a customer's photo means for their order (see ImageReading). */
export async function readImage(
  db: SupabaseClient,
  accountId: string,
  conversationId: string | null,
  mediaUrl: string | null | undefined,
  caption: string | null,
): Promise<ImageReading | null> {
  const setup = await aiSetup(db, accountId);
  if (!setup) return null;
  const media = await loadInboundMedia(db, accountId, mediaUrl);
  if (!media || !media.mimeType.startsWith("image/") || media.buffer.length > MAX_IMAGE_BYTES) return null;
  try {
    const raw = await callVisionOrText(db, setup.config, accountId, conversationId, setup.intro, {
      text: `${IMAGE_TASK}${caption ? `\n\nEl cliente escribió junto a la foto: "${caption}"` : ""}`,
      image: media,
    });
    return parseImageReading(raw);
  } catch (err) {
    console.error("[media-understanding] image reading failed:", err);
    return null;
  }
}

/** Order, question or person? — for free text with no bot conversation running. */
export async function classifyFirstMessage(
  db: SupabaseClient,
  accountId: string,
  conversationId: string | null,
  text: string,
): Promise<FirstMessageRoute | null> {
  const setup = await aiSetup(db, accountId);
  if (!setup) return null;
  try {
    const raw = await callVisionOrText(db, setup.config, accountId, conversationId, setup.intro, {
      text: `${ROUTE_TASK}\n\nMensaje: "${text.slice(0, 1500)}"`,
    });
    return parseFirstMessageRoute(raw);
  } catch (err) {
    console.error("[media-understanding] routing failed:", err);
    return null;
  }
}
