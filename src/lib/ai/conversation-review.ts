// ============================================================
// Automatic quality review of customer conversations.
//
// Once a customer has stopped writing for a while (SESSION_QUIET_MS),
// the AI reads that session — the customer, the bot and the team — and
// notes what went wrong for the customer: a question left unanswered, a
// product lost or changed, a confusing or repeated reply, a customer who
// got stuck or left. One row per session in conversation_reviews; the
// admins get a notification when it didn't go well.
//
// Opt-in per account: business setting aiFeatures.reviewConversations.
// Pure helpers at the top (unit-tested); the database part below.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadAiConfig } from "./config";
import { generateAnthropic } from "./providers/anthropic";
import { generateOpenAi } from "./providers/openai";
import { logAiUsage } from "./usage";
import { loadBusinessSettings } from "../business/settings";
import { businessIntro } from "../flows/order-clarify";
import { getStaffPhones } from "../whatsapp/staff-notify";

/** More than this without the customer writing starts a new session. */
export const SESSION_GAP_MS = 3 * 3_600_000;
/** A session is reviewed once the customer has been quiet this long. */
export const SESSION_QUIET_MS = 30 * 60_000;
/** Sessions older than this are left alone (not reviewed after the fact). */
const MAX_AGE_MS = 24 * 3_600_000;
const MAX_PER_RUN = 15;
const REVIEW_TIMEOUT_MS = 45_000;

export interface ReviewMessage {
  sender_type: "customer" | "bot" | "agent";
  content_type: string;
  content_text: string | null;
  created_at: string;
}

export interface ReviewProblem {
  gravedad: "alta" | "media" | "baja";
  mensaje_cliente: string;
  que_paso: string;
  sugerencia: string;
}

export interface ReviewVerdict {
  verdict: "bien" | "regular" | "mal";
  summary: string;
  problems: ReviewProblem[];
}

/** The last session of a conversation: its messages since the last long silence of the customer. */
export function lastSession(messages: ReviewMessage[]): ReviewMessage[] {
  const sorted = [...messages].sort((a, b) => a.created_at.localeCompare(b.created_at));
  let start = 0;
  let lastCustomer = 0;
  sorted.forEach((m, i) => {
    if (m.sender_type !== "customer") return;
    const t = new Date(m.created_at).getTime();
    if (lastCustomer && t - lastCustomer > SESSION_GAP_MS) start = i;
    lastCustomer = t;
  });
  // The session starts with the customer's first message after the gap.
  const firstCustomer = sorted.findIndex((m, i) => i >= start && m.sender_type === "customer");
  return firstCustomer < 0 ? [] : sorted.slice(firstCustomer);
}

/** The session as the reviewer reads it. */
export function transcript(messages: ReviewMessage[]): string {
  const who = { customer: "CLIENTE", bot: "BOT", agent: "ASESOR (persona)" } as const;
  return messages
    .map((m) => {
      const text = (m.content_text ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
      return `${who[m.sender_type] ?? m.sender_type}: ${text || `[${m.content_type}]`}`;
    })
    .join("\n")
    .slice(0, 12_000);
}

export function parseReview(raw: string): ReviewVerdict | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const j = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    const verdict = j.veredicto === "mal" || j.veredicto === "regular" ? j.veredicto : "bien";
    const problems = (Array.isArray(j.problemas) ? j.problemas : [])
      .filter((p): p is Record<string, unknown> => !!p && typeof p === "object")
      .map((p) => ({
        gravedad: (p.gravedad === "alta" || p.gravedad === "media" ? p.gravedad : "baja") as ReviewProblem["gravedad"],
        mensaje_cliente: String(p.mensaje_cliente ?? "").slice(0, 300),
        que_paso: String(p.que_paso ?? "").slice(0, 600),
        sugerencia: String(p.sugerencia ?? "").slice(0, 400),
      }))
      .filter((p) => p.que_paso)
      .slice(0, 5);
    return { verdict, summary: String(j.resumen ?? "").slice(0, 400), problems };
  } catch {
    return null;
  }
}

const REVIEW_TASK = `Eres un revisor de calidad de la atención por WhatsApp de esta tienda. Lees una conversación ya terminada entre un CLIENTE, el BOT automático y, a veces, un ASESOR (persona del equipo).
Encuentra lo que salió MAL para el cliente: una pregunta que no se respondió o se respondió mal, un producto que se perdió, se cambió o se anotó sin pedirlo, una pregunta o un saludo anotado como producto, respuestas repetidas o sin sentido, el cliente confundido o atascado en un paso, pidió hablar con una persona y no se le atendió, esperó mucho a un asesor, se fue sin comprar por culpa de la atención, el bot dio precios o datos inventados.
No cuentes como problema lo que salió bien ni detalles sin importancia. Si todo salió bien, "problemas" va vacío y el veredicto es "bien".
"resumen": una frase de qué quería el cliente y cómo terminó.
Responde SOLO con JSON: {"veredicto":"bien"|"regular"|"mal","resumen":"...","problemas":[{"gravedad":"alta"|"media"|"baja","mensaje_cliente":"el mensaje del cliente donde falló","que_paso":"...","sugerencia":"cómo debería haber respondido"}]} (máximo 5 problemas).`;

// ---------------------------------------------------------------- db

/** Review one session with the account's AI. Null when the AI isn't available. */
export async function reviewSession(
  db: SupabaseClient,
  accountId: string,
  conversationId: string,
  messages: ReviewMessage[],
): Promise<ReviewVerdict | null> {
  let config;
  try {
    config = await loadAiConfig(db, accountId);
  } catch {
    return null;
  }
  if (!config?.apiKey) return null;
  const biz = await loadBusinessSettings(db, accountId);
  const system = [
    businessIntro(biz),
    REVIEW_TASK,
    biz.customerInfo.trim() ? `Información del negocio (para saber qué era correcto responder):\n${biz.customerInfo.trim()}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const args = {
    apiKey: config.apiKey,
    model: config.model,
    systemPrompt: system,
    messages: [{ role: "user" as const, content: transcript(messages) }],
    timeoutMs: REVIEW_TIMEOUT_MS,
  };
  try {
    const result = config.provider === "openai" ? await generateOpenAi(args) : await generateAnthropic(args);
    void logAiUsage(db, {
      accountId,
      conversationId,
      mode: "auto_reply",
      provider: config.provider,
      model: config.model,
      usage: result.usage,
    });
    const parsed = parseReview(result.text);
    if (!parsed) console.error("[conversation-review] unreadable answer:", result.text.slice(0, 600));
    return parsed;
  } catch (err) {
    console.error("[conversation-review] failed:", err);
    return null;
  }
}

/**
 * Review the sessions that ended recently and haven't been reviewed:
 * customer quiet for SESSION_QUIET_MS, not older than a day. Staff
 * numbers (clocking in with "turno") are skipped. Returns how many
 * sessions were reviewed and how many had problems.
 */
export async function reviewDueConversations(
  db: SupabaseClient,
  accountId: string,
  notify: (args: { conversationId: string; contactId: string | null; title: string; body: string }) => Promise<void>,
): Promise<{ reviewed: number; withProblems: number }> {
  const biz = await loadBusinessSettings(db, accountId);
  if (!biz.aiFeatures.reviewConversations) return { reviewed: 0, withProblems: 0 };
  const now = Date.now();
  const { data: convs } = await db
    .from("conversations")
    .select("id, contact_id, last_message_at, contacts(name, phone)")
    .eq("account_id", accountId)
    .gte("last_message_at", new Date(now - MAX_AGE_MS).toISOString())
    .lte("last_message_at", new Date(now - SESSION_QUIET_MS).toISOString())
    .order("last_message_at", { ascending: false })
    .limit(60);
  const staff = getStaffPhones(biz).map((p) => p.slice(-9));
  let reviewed = 0;
  let withProblems = 0;
  for (const c of (convs ?? []) as unknown as {
    id: string;
    contact_id: string | null;
    contacts: { name?: string | null; phone?: string | null } | null;
  }[]) {
    if (reviewed >= MAX_PER_RUN) break;
    const phone = (c.contacts?.phone ?? "").replace(/\D/g, "");
    if (phone && staff.some((s) => phone.endsWith(s))) continue;
    const { data: msgs } = await db
      .from("messages")
      .select("sender_type, content_type, content_text, created_at")
      .eq("conversation_id", c.id)
      .gte("created_at", new Date(now - MAX_AGE_MS - SESSION_GAP_MS).toISOString())
      .order("created_at", { ascending: true })
      .limit(300);
    const session = lastSession((msgs ?? []) as ReviewMessage[]);
    const customer = session.filter((m) => m.sender_type === "customer");
    if (customer.length === 0) continue;
    // Still going (the customer wrote recently) or just "turno"/"gracias".
    if (now - new Date(customer.at(-1)!.created_at).getTime() < SESSION_QUIET_MS) continue;
    if (customer.length === 1 && /^\s*(turno|gracias|ok|👍)\s*$/i.test(customer[0].content_text ?? "")) continue;
    const sessionStart = session[0].created_at;
    const { data: done, error: lookupError } = await db
      .from("conversation_reviews")
      .select("id")
      .eq("conversation_id", c.id)
      .eq("session_start", sessionStart)
      .maybeSingle();
    // Table missing (migration 050 not applied) or unreachable: stop
    // here rather than paying for reviews that can't be saved.
    if (lookupError) {
      console.error("[conversation-review] reviews table unavailable:", lookupError.message);
      break;
    }
    if (done) continue;
    const verdict = await reviewSession(db, accountId, c.id, session);
    if (!verdict) break; // AI unavailable: try again next time
    reviewed++;
    const { error } = await db.from("conversation_reviews").insert({
      account_id: accountId,
      conversation_id: c.id,
      contact_id: c.contact_id,
      session_start: sessionStart,
      session_end: session.at(-1)!.created_at,
      verdict: verdict.verdict,
      problems: verdict.problems,
      summary: verdict.summary,
    });
    if (error) {
      console.error("[conversation-review] save failed:", error.message);
      continue;
    }
    const serious = verdict.problems.filter((p) => p.gravedad !== "baja");
    if (verdict.verdict !== "bien" && serious.length) {
      withProblems++;
      const name = c.contacts?.name?.trim() || "Cliente";
      await notify({
        conversationId: c.id,
        contactId: c.contact_id,
        title: `🧪 Revisar atención: ${name}${verdict.verdict === "mal" ? " (salió mal)" : ""}`,
        body: [verdict.summary, ...serious.slice(0, 3).map((p) => `• ${p.que_paso}`)].filter(Boolean).join("\n").slice(0, 1000),
      });
    }
  }
  return { reviewed, withProblems };
}
