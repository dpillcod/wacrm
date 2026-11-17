import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { clearBusinessSettingsCache, loadBusinessSettings } from "@/lib/business/settings";
import { decrypt } from "@/lib/whatsapp/encryption";

// ============================================================
// Meta's Conversions API for Business Messaging: tell Meta which
// WhatsApp chats ended in a sale, so its ads are shown to people who
// buy, not just people who write.
//
//   1. The first message after a Click-to-WhatsApp ad carries a click
//      id (referral.ctwa_clid) → kept on the contact (recordAdClick).
//   2. The order card reaches "Entregado" → one Purchase event with the
//      card's value (reportPurchase), sent once per card.
//
// Without a click id, Meta can still match by the hashed phone, but
// only with the business's Facebook page id (Mi negocio). Off unless
// Mi negocio → metaConversions.enabled; needs the
// whatsapp_business_manage_events permission on the WhatsApp token.
// Free: Meta doesn't charge for events.
// ============================================================

const GRAPH = "https://graph.facebook.com/v23.0";
/** Meta only attributes clicks from the last 7 days; older ones aren't worth sending. */
const CLICK_MAX_AGE_MS = 7 * 86_400_000;

/** Keep the ad's click id on the contact (best-effort). */
export async function recordAdClick(db: SupabaseClient, contactId: string, clickId: string | undefined): Promise<void> {
  const id = clickId?.trim();
  if (!id) return;
  const { error } = await db
    .from("contacts")
    .update({ ad_click_id: id.slice(0, 500), ad_click_at: new Date().toISOString() })
    .eq("id", contactId);
  if (error) console.error("[meta-conversions] click id not saved:", error.message);
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Phone as Meta wants it before hashing: digits only, with country code. */
export function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, "");
}

export interface PurchaseEventInput {
  dealId: string;
  value: number;
  currency: string;
  wabaId: string;
  clickId: string | null;
  pageId: string;
  phone: string;
  eventTime: number;
}

/** The Purchase event, or null when Meta couldn't match it (no click id and no page id). */
export function purchaseEvent(e: PurchaseEventInput): Record<string, unknown> | null {
  const userData: Record<string, unknown> = { whatsapp_business_account_id: e.wabaId };
  if (e.clickId) userData.ctwa_clid = e.clickId;
  else if (e.pageId && normalizePhone(e.phone)) {
    userData.page_id = e.pageId;
    userData.ph = [sha256(normalizePhone(e.phone))];
  } else return null;
  return {
    event_name: "Purchase",
    event_time: e.eventTime,
    event_id: `deal-${e.dealId}`,
    action_source: "business_messaging",
    messaging_channel: "whatsapp",
    user_data: userData,
    custom_data: { currency: e.currency || "USD", value: Math.round(e.value * 100) / 100 },
  };
}

export type ConversionResult =
  | { sent: true }
  | { sent: false; reason: "off" | "already_sent" | "no_value" | "no_match" | "no_config" | "no_dataset" | "meta_error"; error?: string };

async function graph(path: string, token: string, init?: RequestInit): Promise<{ ok: boolean; body: Record<string, unknown> }> {
  const res = await fetch(`${GRAPH}/${path}${path.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}`, init);
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok && !body.error, body };
}

function metaError(body: Record<string, unknown>): string {
  const e = body.error as { message?: string; code?: number } | undefined;
  return e ? `${e.code ?? ""} ${e.message ?? ""}`.trim() : JSON.stringify(body).slice(0, 200);
}

/** The WhatsApp account's dataset (created the first time), saved in Mi negocio. */
async function datasetFor(
  db: SupabaseClient,
  accountId: string,
  wabaId: string,
  token: string,
): Promise<{ id: string } | { error: string }> {
  const biz = await loadBusinessSettings(db, accountId);
  if (biz.metaConversions.datasetId) return { id: biz.metaConversions.datasetId };
  let r = await graph(`${wabaId}/dataset`, token);
  let id = r.ok ? String(((r.body.data as { id?: string }[] | undefined)?.[0]?.id ?? r.body.id ?? "")) : "";
  if (!id) {
    r = await graph(`${wabaId}/dataset`, token, { method: "POST" });
    id = r.ok ? String(r.body.id ?? "") : "";
  }
  if (!id) return { error: metaError(r.body) };
  const { data } = await db.from("business_settings").select("settings").eq("account_id", accountId).maybeSingle();
  const stored = ((data as { settings?: Record<string, unknown> } | null)?.settings ?? {}) as Record<string, unknown>;
  const mc = (stored.metaConversions ?? {}) as Record<string, unknown>;
  await db
    .from("business_settings")
    .update({ settings: { ...stored, metaConversions: { ...mc, datasetId: id } }, updated_at: new Date().toISOString() })
    .eq("account_id", accountId);
  clearBusinessSettingsCache(accountId);
  return { id };
}

/** One Purchase event for a delivered order card (once per card). */
export async function reportPurchase(db: SupabaseClient, dealId: string): Promise<ConversionResult> {
  const { data } = await db
    .from("deals")
    .select("id, account_id, contact_id, value, currency, conversion_sent_at")
    .eq("id", dealId)
    .maybeSingle();
  const deal = data as {
    id: string;
    account_id: string;
    contact_id: string | null;
    value: number | string | null;
    currency: string | null;
    conversion_sent_at: string | null;
  } | null;
  if (!deal) return { sent: false, reason: "no_config" };
  const biz = await loadBusinessSettings(db, deal.account_id);
  if (!biz.metaConversions.enabled) return { sent: false, reason: "off" };
  if (deal.conversion_sent_at) return { sent: false, reason: "already_sent" };
  const value = Number(deal.value) || 0;
  if (value <= 0) return { sent: false, reason: "no_value" };

  const { data: contact } = deal.contact_id
    ? await db.from("contacts").select("phone, ad_click_id, ad_click_at").eq("id", deal.contact_id).maybeSingle()
    : { data: null };
  const c = contact as { phone?: string | null; ad_click_id?: string | null; ad_click_at?: string | null } | null;
  const clickFresh = c?.ad_click_id && c.ad_click_at && Date.now() - new Date(c.ad_click_at).getTime() < CLICK_MAX_AGE_MS;

  const { data: config } = await db
    .from("whatsapp_config")
    .select("waba_id, access_token")
    .eq("account_id", deal.account_id)
    .maybeSingle();
  const cfg = config as { waba_id?: string | null; access_token?: string } | null;
  if (!cfg?.waba_id || !cfg.access_token) return { sent: false, reason: "no_config" };

  const event = purchaseEvent({
    dealId: deal.id,
    value,
    currency: deal.currency ?? "USD",
    wabaId: cfg.waba_id,
    clickId: clickFresh ? c!.ad_click_id! : null,
    pageId: biz.metaConversions.pageId,
    phone: c?.phone ?? "",
    eventTime: Math.floor(Date.now() / 1000),
  });
  if (!event) return { sent: false, reason: "no_match" };

  const token = decrypt(cfg.access_token);
  const dataset = await datasetFor(db, deal.account_id, cfg.waba_id, token);
  if ("error" in dataset) {
    console.error("[meta-conversions] no dataset:", dataset.error);
    return { sent: false, reason: "no_dataset", error: dataset.error };
  }
  const r = await graph(`${dataset.id}/events`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: [event], partner_agent: "wacrm" }),
  });
  if (!r.ok) {
    console.error("[meta-conversions] event rejected:", metaError(r.body));
    return { sent: false, reason: "meta_error", error: metaError(r.body) };
  }
  await db.from("deals").update({ conversion_sent_at: new Date().toISOString() }).eq("id", deal.id);
  return { sent: true };
}
