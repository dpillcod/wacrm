/**
 * "A person is attending this customer": when the bot and the AI keep
 * quiet, and what happens when that person goes quiet too.
 *
 * With the WhatsApp Business app connected (coexistence) the team writes
 * from the phone all day — the cashier's "¡Gracias por preferirnos!" to
 * every customer who pays by transfer. Muting the bot for hours after
 * any of those left customers with nobody answering later. So:
 *
 * - Only a REPLY counts: a team message sent after the customer wrote
 *   (within REPLY_LOOKBACK_MS). The team writing first doesn't mute.
 * - The pause lasts `humanPause.minutes` (Mi negocio) after that reply;
 *   a closed conversation ends it right away.
 * - Afterwards a greeting gets `texts.welcomeBack`, not the whole menu.
 * - The customer writes during the pause and nobody answers: alert the
 *   team after `waitAlertMinutes`, tell the customer after twice that.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadBusinessSettings } from "../business/settings";
import { notifyAccountInApp } from "../pipelines/order-cards";
import { getStaffPhones, notifyStaffOfHandoff } from "../whatsapp/staff-notify";
import { localPhone } from "../whatsapp/phone-utils";
import { engineSendText } from "./meta-send";
import { isWithinBusinessHours } from "./store-policy";

/** A team message answers the customer when they wrote this shortly before it. */
const REPLY_LOOKBACK_MS = 3 * 3_600_000;
/** How long after a person attended a greeting still gets the short "welcome back". */
const WELCOME_BACK_WITHIN_MS = 12 * 3_600_000;

export interface PauseMessage {
  sender_type: string;
  created_at: string;
}

/** The latest team message that answered something the customer wrote (ms), or null. Oldest-first input. */
export function lastHumanReplyAt(messages: PauseMessage[]): number | null {
  let lastCustomer = -Infinity;
  let reply: number | null = null;
  for (const m of messages) {
    const at = new Date(m.created_at).getTime();
    if (m.sender_type === "customer") lastCustomer = at;
    else if (m.sender_type === "agent" && at - lastCustomer <= REPLY_LOOKBACK_MS) reply = at;
  }
  return reply;
}

export interface HumanState {
  /** A person answered within the pause: the bot keeps quiet. */
  attending: boolean;
  /** A person answered earlier (pause over), and the bot hasn't spoken since: greet with welcomeBack. */
  welcomeBack: boolean;
}

/** Pure decision over the recent messages (oldest-first). */
export function humanStateOf(messages: PauseMessage[], now: number, pauseMinutes: number, closed: boolean): HumanState {
  const reply = lastHumanReplyAt(messages);
  if (reply === null) return { attending: false, welcomeBack: false };
  const age = now - reply;
  const attending = !closed && age < pauseMinutes * 60_000;
  const botSince = messages.some((m) => m.sender_type === "bot" && new Date(m.created_at).getTime() > reply);
  return { attending, welcomeBack: !attending && age < WELCOME_BACK_WITHIN_MS && !botSince };
}

async function recentMessages(db: SupabaseClient, conversationId: string, sinceMs: number): Promise<PauseMessage[]> {
  const { data } = await db
    .from("messages")
    .select("sender_type, created_at")
    .eq("conversation_id", conversationId)
    .gte("created_at", new Date(sinceMs).toISOString())
    .order("created_at", { ascending: true })
    .limit(500);
  return (data ?? []) as PauseMessage[];
}

/** Where this conversation stands, judged on what came before the customer's message being handled. */
export async function loadHumanState(
  db: SupabaseClient,
  accountId: string,
  conversationId: string,
  now: number = Date.now(),
): Promise<HumanState> {
  const biz = await loadBusinessSettings(db, accountId);
  const [{ data: conv }, messages] = await Promise.all([
    db.from("conversations").select("status").eq("id", conversationId).maybeSingle(),
    recentMessages(db, conversationId, now - WELCOME_BACK_WITHIN_MS - REPLY_LOOKBACK_MS),
  ]);
  const closed = (conv as { status?: string } | null)?.status === "closed";
  // The customer's newest message is the one being handled: judge what came before it.
  const lastCustomer = messages.map((m) => m.sender_type).lastIndexOf("customer");
  const before = lastCustomer === messages.length - 1 ? messages.slice(0, -1) : messages;
  return humanStateOf(before, now, biz.humanPause.minutes, closed);
}

/** True while a person attends this conversation (the bot and the AI keep quiet). */
export async function humanIsAttending(db: SupabaseClient, accountId: string, conversationId: string): Promise<boolean> {
  return (await loadHumanState(db, accountId, conversationId)).attending;
}

// ------------------------------------------------------------
// Safety net: the customer wrote during the pause, nobody answers.
// In-memory timers (like the handoff follow-ups): a restart drops them,
// and the cron's "⏰ SIN RESPUESTA" / "🔴 ESCALADO" still follow the alert.
// ------------------------------------------------------------

const pending = new Map<string, ReturnType<typeof setTimeout>>();

interface WaitArgs {
  accountId: string;
  userId: string;
  conversationId: string;
  contactId: string;
  /** What the customer wrote (for the alert). */
  said: string;
}

async function answeredSince(db: SupabaseClient, conversationId: string, sinceIso: string): Promise<boolean> {
  const { data } = await db
    .from("messages")
    .select("id")
    .eq("conversation_id", conversationId)
    .eq("sender_type", "agent")
    .gt("created_at", sinceIso)
    .limit(1);
  return (data ?? []).length > 0;
}

/** Starts the "nobody answers" checks for a message written during the pause (once per conversation at a time). */
export async function watchCustomerWaiting(db: SupabaseClient, args: WaitArgs): Promise<void> {
  if (pending.has(args.conversationId)) return;
  const biz = await loadBusinessSettings(db, args.accountId);
  const minutes = biz.humanPause.waitAlertMinutes;
  if (!minutes) return;
  const { data: contact } = await db.from("contacts").select("name, phone").eq("id", args.contactId).maybeSingle();
  const c = contact as { name?: string | null; phone?: string | null } | null;
  const digits = String(c?.phone ?? "").replace(/\D/g, "");
  if (digits && getStaffPhones(biz).includes(digits)) return;
  const since = new Date().toISOString();

  const alert = async () => {
    const fresh = await loadBusinessSettings(db, args.accountId);
    if (!isWithinBusinessHours(fresh) || (await answeredSince(db, args.conversationId, since))) {
      pending.delete(args.conversationId);
      return;
    }
    const name = c?.name?.trim() || "Cliente";
    const phone = c?.phone ? localPhone(c.phone.replace(/^\+/, ""), fresh.phoneCountryCode) : "";
    const quote = args.said.trim().slice(0, 160);
    await notifyAccountInApp(db, {
      accountId: args.accountId,
      conversationId: args.conversationId,
      contactId: args.contactId,
      // "⚠️ Ayuda al cliente" → the cron repeats it (⏰) and escalates it (🔴) if still unanswered.
      title: `⚠️ Ayuda al cliente: ${name} espera respuesta`,
      body: `Le escribió a una persona y nadie le contesta hace ${minutes} min.${quote ? `\n"${quote}"` : ""}`,
    }).catch(() => null);
    await notifyStaffOfHandoff(db, {
      accountId: args.accountId,
      contactName: name,
      summary: `🚨 CLIENTE ESPERANDO RESPUESTA (${minutes} min)${phone ? ` · ${phone}` : ""}${quote ? `\n"${quote}"` : ""}`,
      conversationId: args.conversationId,
    }).catch(() => null);
    pending.set(args.conversationId, setTimeout(() => void reassure().catch(() => pending.delete(args.conversationId)), minutes * 60_000));
  };

  const reassure = async () => {
    pending.delete(args.conversationId);
    const fresh = await loadBusinessSettings(db, args.accountId);
    if (!fresh.texts.waitingAck.trim() || !isWithinBusinessHours(fresh)) return;
    if (await answeredSince(db, args.conversationId, since)) return;
    await engineSendText({
      accountId: args.accountId,
      userId: args.userId,
      conversationId: args.conversationId,
      contactId: args.contactId,
      text: fresh.texts.waitingAck,
    });
  };

  pending.set(args.conversationId, setTimeout(() => void alert().catch(() => pending.delete(args.conversationId)), minutes * 60_000));
}
