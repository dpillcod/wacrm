// ============================================================
// Appointments on cards (deals.appointment_at, migration 049): a
// service visit, or when a cake / party order is ready. The card is the
// agenda; Google Calendar gets a copy (google.ts) so staff get phone
// reminders. The customer is told the date by WhatsApp (free only when
// they wrote within 24 h), and reminded the day before if they write
// again ("escríbanos OK el día anterior"). Each morning the team gets
// the day's agenda.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadBusinessSettings, type BusinessSettings } from "../business/settings";
import { customerWindowOpen } from "../pipelines/order-cards";
import { engineSendText } from "../flows/meta-send";
import { calendarConfigured, deleteCalendarEvent, upsertCalendarEvent } from "./google";

export type AppointmentKind = "service" | "bakery" | "order";

interface DealRow {
  id: string;
  account_id: string;
  title: string;
  notes: string | null;
  status: string | null;
  pipeline_id: string;
  stage_id: string;
  contact_id: string | null;
  conversation_id: string | null;
  appointment_at: string | null;
  calendar_event_id: string | null;
  appointment_reminded_at: string | null;
}

const DEAL_COLUMNS =
  "id, account_id, title, notes, status, pipeline_id, stage_id, contact_id, conversation_id, appointment_at, calendar_event_id, appointment_reminded_at";

// ---------------------------------------------------------------- pure

/** Service board → visit; bakery orders → pickup/delivery; anything else → generic. */
export function appointmentKind(pipelineName: string | null, biz: BusinessSettings, title: string, notes: string | null): AppointmentKind {
  if (pipelineName && pipelineName === biz.serviceBoard.pipelineName) return "service";
  if (/encargo|pasteler|torta|bocadito/i.test(`${title}\n${notes ?? ""}`)) return "bakery";
  return "order";
}

/** IANA zone for the business's fixed UTC offset (Ecuador = -5 → America/Guayaquil). */
export function timeZoneFor(biz: Pick<BusinessSettings, "utcOffsetHours">): string {
  const h = biz.utcOffsetHours;
  if (h === -5) return "America/Guayaquil";
  return h === 0 ? "UTC" : `Etc/GMT${h > 0 ? "-" : "+"}${Math.abs(h)}`;
}

/** "jueves 15 de octubre, 10:00" in the business's time zone. */
export function formatWhen(date: Date, biz: Pick<BusinessSettings, "utcOffsetHours">): string {
  const tz = timeZoneFor(biz);
  const day = new Intl.DateTimeFormat("es-EC", { timeZone: tz, weekday: "long", day: "numeric", month: "long" }).format(date);
  const time = new Intl.DateTimeFormat("es-EC", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
  return `${day}, ${time}`;
}

/** "2026-10-18T15:00" (business local time) → the instant. Null when it isn't a date-time. */
export function localToUtc(local: string, utcOffsetHours: number): Date | null {
  const m = local.trim().match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (!m) return null;
  const utc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - utcOffsetHours, +m[5]);
  return Number.isNaN(utc) ? null : new Date(utc);
}

/** The address written in the card notes ("Dirección: …"), for the calendar event. */
export function addressFromNotes(notes: string | null): string | undefined {
  const m = (notes ?? "").match(/^\s*(?:📍\s*)?Direcci[oó]n:\s*(.+)$/im);
  return m?.[1]?.trim() || undefined;
}

const KIND_ICON: Record<AppointmentKind, string> = { service: "🔧", bakery: "🎂", order: "📦" };
const KIND_MINUTES: Record<AppointmentKind, number> = { service: 90, bakery: 30, order: 30 };

/** What the customer reads when the date is set. */
export function confirmationText(kind: AppointmentKind, title: string, when: string): string {
  const ref = title.split(" — ")[0];
  const what = kind === "service" ? "la visita de nuestro técnico" : kind === "bakery" ? "su encargo" : "su pedido";
  return [
    `📅 *${ref}*`,
    "",
    `Quedó agendado ${what} para el *${when}*.`,
    "",
    "El día anterior escríbanos *OK* y le recordamos los detalles 🙂 Si necesita cambiar la fecha, escríbanos por aquí.",
  ].join("\n");
}

export function reminderText(kind: AppointmentKind, title: string, when: string): string {
  const ref = title.split(" — ")[0];
  const what = kind === "service" ? "la visita de nuestro técnico" : kind === "bakery" ? "su encargo" : "su pedido";
  return `⏰ Le recordamos ${what} (*${ref}*): *${when}*. ¡Le esperamos! Si necesita cambiar algo, escríbanos por aquí 🙂`;
}

// ---------------------------------------------------------------- db

async function loadDeal(db: SupabaseClient, dealId: string): Promise<DealRow | null> {
  const { data } = await db.from("deals").select(DEAL_COLUMNS).eq("id", dealId).maybeSingle();
  return (data as DealRow | null) ?? null;
}

async function context(db: SupabaseClient, deal: DealRow) {
  const [biz, { data: pipeline }, { data: stage }, { data: contact }] = await Promise.all([
    loadBusinessSettings(db, deal.account_id),
    db.from("pipelines").select("name").eq("id", deal.pipeline_id).maybeSingle(),
    db.from("pipeline_stages").select("name").eq("id", deal.stage_id).maybeSingle(),
    deal.contact_id ? db.from("contacts").select("name, phone").eq("id", deal.contact_id).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  const pipelineName = (pipeline as { name?: string } | null)?.name ?? null;
  return {
    biz,
    stageName: (stage as { name?: string } | null)?.name ?? "",
    contact: contact as { name?: string | null; phone?: string | null } | null,
    kind: appointmentKind(pipelineName, biz, deal.title, deal.notes),
  };
}

/**
 * Copy the card's appointment to Google Calendar (create / move / remove).
 * Removed when there's no date, the card is lost, or it's in a cancelled column.
 */
export async function syncDealCalendar(
  db: SupabaseClient,
  dealId: string,
): Promise<"synced" | "removed" | "none" | "off" | "failed"> {
  if (!calendarConfigured()) return "off";
  const deal = await loadDeal(db, dealId);
  if (!deal) return "none";
  const { biz, stageName, contact, kind } = await context(db, deal);
  const cancelled = deal.status === "lost" || /cancel/i.test(stageName);
  try {
    if (!deal.appointment_at || cancelled) {
      if (!deal.calendar_event_id) return "none";
      await deleteCalendarEvent(deal.calendar_event_id);
      await db.from("deals").update({ calendar_event_id: null }).eq("id", deal.id);
      return "removed";
    }
    const link = deal.conversation_id && biz.publicAppUrl ? `${biz.publicAppUrl}/inbox?c=${deal.conversation_id}` : "";
    const description = [
      contact?.name ? `Cliente: ${contact.name}` : "",
      contact?.phone ? `Teléfono: ${contact.phone}` : "",
      stageName ? `Estado: ${stageName}` : "",
      "",
      deal.notes ?? "",
      link ? `\nAbrir en el CRM: ${link}` : "",
    ]
      .filter((l, i, all) => l || (i > 0 && all[i - 1]))
      .join("\n")
      .trim();
    const eventId = await upsertCalendarEvent(deal.calendar_event_id, {
      summary: `${KIND_ICON[kind]} ${deal.title}`,
      description,
      location: addressFromNotes(deal.notes),
      start: new Date(deal.appointment_at),
      minutes: KIND_MINUTES[kind],
      timeZone: timeZoneFor(biz),
    });
    if (eventId !== deal.calendar_event_id) {
      await db.from("deals").update({ calendar_event_id: eventId }).eq("id", deal.id);
    }
    return "synced";
  } catch (err) {
    console.error("[calendar] sync failed:", err);
    return "failed";
  }
}

async function senderFor(db: SupabaseClient, accountId: string): Promise<string | null> {
  const { data } = await db.from("whatsapp_config").select("user_id").eq("account_id", accountId).maybeSingle();
  return (data as { user_id?: string } | null)?.user_id ?? null;
}

/** Tell the customer the date (free only inside their 24 h window). */
export async function confirmAppointment(
  db: SupabaseClient,
  dealId: string,
): Promise<"sent" | "window_closed" | "no_conversation" | "none" | "failed"> {
  const deal = await loadDeal(db, dealId);
  if (!deal?.appointment_at) return "none";
  if (!deal.conversation_id || !deal.contact_id) return "no_conversation";
  if (!(await customerWindowOpen(db, deal.conversation_id))) return "window_closed";
  const { biz, kind } = await context(db, deal);
  const userId = await senderFor(db, deal.account_id);
  if (!userId) return "failed";
  try {
    await engineSendText({
      accountId: deal.account_id,
      userId,
      conversationId: deal.conversation_id,
      contactId: deal.contact_id,
      text: confirmationText(kind, deal.title, formatWhen(new Date(deal.appointment_at), biz)),
    });
    await db.from("deals").update({ appointment_notified_at: new Date().toISOString(), appointment_reminded_at: null }).eq("id", deal.id);
    return "sent";
  } catch (err) {
    console.error("[calendar] confirmation failed:", err);
    return "failed";
  }
}

/**
 * The customer wrote (any message): if they have an appointment in the
 * next ~36 h not reminded yet, remind them now — their window is open,
 * so it's free. Best-effort; never blocks the conversation.
 */
export async function remindAppointmentOnInbound(
  db: SupabaseClient,
  args: { accountId: string; contactId: string; conversationId: string },
): Promise<boolean> {
  const now = Date.now();
  const { data } = await db
    .from("deals")
    .select(DEAL_COLUMNS)
    .eq("account_id", args.accountId)
    .eq("contact_id", args.contactId)
    .is("appointment_reminded_at", null)
    .gte("appointment_at", new Date(now + 30 * 60_000).toISOString())
    .lte("appointment_at", new Date(now + 36 * 3_600_000).toISOString())
    .order("appointment_at", { ascending: true })
    .limit(1);
  const deal = ((data ?? []) as DealRow[])[0];
  if (!deal?.appointment_at || deal.status === "lost") return false;
  const { biz, kind, stageName } = await context(db, deal);
  if (/cancel/i.test(stageName)) return false;
  const userId = await senderFor(db, deal.account_id);
  if (!userId) return false;
  // Claim it first so two quick messages don't remind twice.
  const { data: claimed } = await db
    .from("deals")
    .update({ appointment_reminded_at: new Date().toISOString() })
    .eq("id", deal.id)
    .is("appointment_reminded_at", null)
    .select("id");
  if (!(claimed ?? []).length) return false;
  await engineSendText({
    accountId: deal.account_id,
    userId,
    conversationId: args.conversationId,
    contactId: args.contactId,
    text: reminderText(kind, deal.title, formatWhen(new Date(deal.appointment_at), biz)),
  });
  return true;
}

/** The day's agenda for the team, or null when there's nothing. */
export async function dailyAgenda(
  db: SupabaseClient,
  accountId: string,
  now: Date = new Date(),
): Promise<{ text: string; count: number; toCall: number } | null> {
  const biz = await loadBusinessSettings(db, accountId);
  const offset = biz.utcOffsetHours * 3_600_000;
  const local = new Date(now.getTime() + offset);
  const dayStart = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - offset);
  const dayEnd = new Date(dayStart.getTime() + 24 * 3_600_000);
  const { data } = await db
    .from("deals")
    .select(`${DEAL_COLUMNS}, pipelines(name), pipeline_stages(name), contacts(name, phone)`)
    .eq("account_id", accountId)
    .gte("appointment_at", dayStart.toISOString())
    .lt("appointment_at", dayEnd.toISOString())
    .neq("status", "lost")
    .order("appointment_at", { ascending: true });
  type Row = DealRow & {
    pipelines: { name: string } | null;
    pipeline_stages: { name: string } | null;
    contacts: { name: string | null; phone: string | null } | null;
  };
  const rows = ((data ?? []) as unknown as Row[]).filter((r) => !/cancel/i.test(r.pipeline_stages?.name ?? ""));
  if (!rows.length) return null;
  const tz = timeZoneFor(biz);
  const hour = (d: string) => new Intl.DateTimeFormat("es-EC", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(d));
  let toCall = 0;
  const lines = rows.map((r) => {
    const kind = appointmentKind(r.pipelines?.name ?? null, biz, r.title, r.notes);
    const notReminded = !r.appointment_reminded_at;
    if (notReminded) toCall++;
    const phone = r.contacts?.phone ? ` · 📞 ${r.contacts.phone}` : "";
    return `${KIND_ICON[kind]} ${hour(r.appointment_at!)} — ${r.title}${phone}${notReminded ? " (llamar para confirmar)" : ""}`;
  });
  const dayName = new Intl.DateTimeFormat("es-EC", { timeZone: tz, weekday: "long", day: "numeric", month: "long" }).format(now);
  return {
    text: [`📅 *Agenda de hoy, ${dayName}*`, "", ...lines].join("\n"),
    count: rows.length,
    toCall,
  };
}
