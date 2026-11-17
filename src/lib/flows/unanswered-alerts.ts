/**
 * A second alert when the team was called in and nobody answered.
 *
 * The bot tells the customer "una persona le escribe por aquí en breve"
 * (a price, "¿lo tienen para hoy?", a file to print, a photo it can't
 * read, a list without the customer's details) and alerts the team once.
 * In the Nov 9 chats nobody answered those alerts for 40+ minutes and
 * the customers left. Orders already get their own "sigue sin atender"
 * reminders (handoff follow-up); this covers the other alerts.
 *
 * Swept by /api/flows/cron: an alert from 10–90 minutes ago, during
 * opening hours, with no agent message in its conversation since, gets
 * ONE "⏰ SIN RESPUESTA" alert (CRM + WhatsApp to staff on shift). The
 * "⏰" notification itself marks it as done.
 *
 * Still nobody after `escalation.minutes` (Mi negocio, 25 by default)
 * from the first alert — also for new orders and their "sigue sin
 * atender" reminders — one "🔴 ESCALADO": CRM to everyone plus WhatsApp
 * to the escalation list (or, with no list, to the staff on shift again).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadBusinessSettings } from "../business/settings";
import { notifyAccountInApp } from "../pipelines/order-cards";
import { notifyStaffOfHandoff } from "../whatsapp/staff-notify";
import { localPhone } from "../whatsapp/phone-utils";
import { isWithinBusinessHours } from "./store-policy";

const AFTER_MS = 10 * 60_000;
const UNTIL_MS = 90 * 60_000;
/** How far back escalations look (an order placed at 8:50 escalates at 9:15 even if the cron missed a beat). */
const ESCALATE_UNTIL_MS = 3 * 3_600_000;
export const REALERT_PREFIX = "⏰ SIN RESPUESTA";
export const ESCALATION_PREFIX = "🔴 ESCALADO";

/** Alerts that promise the customer a person will write — the ones worth repeating. */
export function needsAnswer(title: string): boolean {
  return /^(⚠️ Ayuda al cliente|📄 Archivo del cliente|📷 Foto de un cliente|⏳ Pedido sin datos|💰 |🚨 |✏️ Cotización)/u.test(title) &&
    !title.includes("SIN RESPUESTA");
}

/** Alerts that escalate when nobody answers: the ones above, plus new orders and their reminders. */
export function escalates(title: string): boolean {
  if (title.startsWith(ESCALATION_PREFIX) || title.startsWith(REALERT_PREFIX)) return false;
  return needsAnswer(title) || /^(⚠️ )?(🧾 Pedido|Pedido|🔧 |🎂 |💬 Cliente para atender|✏️ Cotización)/u.test(title);
}

interface AlertRow {
  account_id: string;
  conversation_id: string;
  contact_id: string | null;
  title: string;
  body: string | null;
  created_at: string;
}

/** Sends the second alerts due now; returns how many went out. */
export async function sweepUnansweredAlerts(db: SupabaseClient, now: Date = new Date()): Promise<number> {
  const { data } = await db
    .from("notifications")
    .select("account_id, conversation_id, contact_id, title, body, created_at")
    .not("conversation_id", "is", null)
    .gte("created_at", new Date(now.getTime() - ESCALATE_UNTIL_MS).toISOString())
    .order("created_at", { ascending: true })
    .limit(3000);
  const all = (data ?? []) as AlertRow[];
  const since = now.getTime() - UNTIL_MS;
  const rows = all.filter((r) => new Date(r.created_at).getTime() >= since);

  // One row per alert per team member: the first alert of each
  // conversation since its last "⏰" (a "⏰" closes the ones before it).
  const first = new Map<string, AlertRow>();
  for (const r of rows) {
    if (r.title.startsWith(REALERT_PREFIX)) first.delete(r.conversation_id);
    else if (needsAnswer(r.title) && !first.has(r.conversation_id)) first.set(r.conversation_id, r);
  }

  let sent = 0;
  for (const [conversationId, alert] of first) {
    const age = now.getTime() - new Date(alert.created_at).getTime();
    if (age < AFTER_MS) continue;
    const biz = await loadBusinessSettings(db, alert.account_id);
    if (!isWithinBusinessHours(biz, now)) continue;
    const { data: answered } = await db
      .from("messages")
      .select("id")
      .eq("conversation_id", conversationId)
      .eq("sender_type", "agent")
      .gte("created_at", alert.created_at)
      .limit(1);
    if ((answered ?? []).length > 0) continue;

    const { data: contact } = alert.contact_id
      ? await db.from("contacts").select("name, phone").eq("id", alert.contact_id).maybeSingle()
      : { data: null };
    const c = contact as { name?: string | null; phone?: string | null } | null;
    const phone = c?.phone ? localPhone(c.phone.replace(/^\+/, ""), biz.phoneCountryCode) : "";
    const name = c?.name?.trim() || "Cliente";
    const minutes = Math.round(age / 60_000);
    const what = alert.title.replace(/:.*$/, "").trim();
    await notifyAccountInApp(db, {
      accountId: alert.account_id,
      conversationId,
      contactId: alert.contact_id,
      title: `${REALERT_PREFIX} (${minutes} min): ${name}${phone ? ` (${phone})` : ""}`,
      body: `Nadie le ha escrito todavía. Aviso anterior: ${what}.${alert.body ? `\n${alert.body.slice(0, 300)}` : ""}`,
    }).catch(() => null);
    await notifyStaffOfHandoff(db, {
      accountId: alert.account_id,
      contactName: name,
      summary: `${REALERT_PREFIX} hace ${minutes} min — ${what}${phone ? ` · ${phone}` : ""}\nEl cliente sigue esperando; escríbale por favor.`,
      conversationId,
    }).catch(() => null);
    sent += 1;
  }
  return sent + (await sweepEscalations(db, all, now));
}

/** Third step: nobody answered since the first alert → admins and the escalation list. */
async function sweepEscalations(db: SupabaseClient, rows: AlertRow[], now: Date): Promise<number> {
  const first = new Map<string, AlertRow>();
  for (const r of rows) {
    if (r.title.startsWith(ESCALATION_PREFIX)) first.delete(r.conversation_id);
    else if (escalates(r.title) && !first.has(r.conversation_id)) first.set(r.conversation_id, r);
  }
  let sent = 0;
  for (const [conversationId, alert] of first) {
    const biz = await loadBusinessSettings(db, alert.account_id);
    const after = biz.escalation.minutes * 60_000;
    const age = now.getTime() - new Date(alert.created_at).getTime();
    if (!after || age < after) continue;
    if (!isWithinBusinessHours(biz, now)) continue;
    const { data: answered } = await db
      .from("messages")
      .select("id")
      .eq("conversation_id", conversationId)
      .eq("sender_type", "agent")
      .gte("created_at", alert.created_at)
      .limit(1);
    if ((answered ?? []).length > 0) continue;
    const { data: conv } = await db.from("conversations").select("status").eq("id", conversationId).maybeSingle();
    if ((conv as { status?: string } | null)?.status === "closed") continue;

    const { data: contact } = alert.contact_id
      ? await db.from("contacts").select("name, phone").eq("id", alert.contact_id).maybeSingle()
      : { data: null };
    const c = contact as { name?: string | null; phone?: string | null } | null;
    const phone = c?.phone ? localPhone(c.phone.replace(/^\+/, ""), biz.phoneCountryCode) : "";
    const name = c?.name?.trim() || "Cliente";
    const minutes = Math.round(age / 60_000);
    const what = alert.title.replace(/:.*$/, "").trim();
    await notifyAccountInApp(db, {
      accountId: alert.account_id,
      conversationId,
      contactId: alert.contact_id,
      title: `${ESCALATION_PREFIX} (${minutes} min sin respuesta): ${name}${phone ? ` (${phone})` : ""}`,
      body: `Nadie le ha escrito en ${minutes} minutos. Primer aviso: ${what}.${alert.body ? `\n${alert.body.slice(0, 300)}` : ""}`,
    }).catch(() => null);
    await notifyStaffOfHandoff(db, {
      accountId: alert.account_id,
      contactName: name,
      summary: `${ESCALATION_PREFIX}: ${minutes} min sin respuesta — ${what}${phone ? ` · ${phone}` : ""}\nNadie del equipo le ha escrito. Por favor atiéndalo o asígnelo ahora.`,
      conversationId,
      ...(biz.escalation.phones.length ? { recipients: biz.escalation.phones } : {}),
    }).catch(() => null);
    sent += 1;
  }
  return sent;
}
