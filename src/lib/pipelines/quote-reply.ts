import type { SupabaseClient } from "@supabase/supabase-js";
import { loadBusinessSettings } from "@/lib/business/settings";
import { engineSendText } from "@/lib/flows/meta-send";
import { notifyAccountInApp } from "@/lib/pipelines/order-cards";
import { notifyStaffOfHandoff } from "@/lib/whatsapp/staff-notify";
import { parseQuoteReplyId, quoteMoney, quoteTotals, type Quote } from "./quote";

/**
 * A tap on [✅ Acepto] / [✏️ Cambiar algo] under a quote sent from an
 * order card (see app/api/pipelines/deals/[id]/quote): the answer goes
 * on the card, the customer gets the reply set in Mi negocio, and the
 * team hears about it (CRM + WhatsApp to staff on shift). A second tap
 * on the same answer only gets the reply. False when it isn't a quote tap.
 */
export async function handleQuoteReply(
  db: SupabaseClient,
  input: { accountId: string; userId: string; contactId: string; conversationId: string },
  replyId: string,
): Promise<boolean> {
  const parsed = parseQuoteReplyId(replyId);
  if (!parsed) return false;
  const { data } = await db
    .from("deals")
    .select("id, title, notes, account_id, quote")
    .eq("id", parsed.dealId)
    .maybeSingle();
  const deal = data as { id: string; title: string; notes: string | null; account_id: string; quote: Quote | null } | null;
  if (!deal || deal.account_id !== input.accountId) return true;

  const biz = await loadBusinessSettings(db, input.accountId);
  const status = parsed.accepted ? "accepted" : "change_requested";
  const repeated = deal.quote?.status === status;
  const number = deal.quote?.number ?? "";
  const total = deal.quote ? quoteMoney(quoteTotals(deal.quote).total) : "";

  if (!repeated) {
    const line = parsed.accepted
      ? `✅ El cliente ACEPTÓ la cotización ${number}${total ? ` (${total})` : ""}`
      : `✏️ El cliente quiere CAMBIAR algo de la cotización ${number}`;
    await db
      .from("deals")
      .update({
        notes: `${deal.notes ?? ""}\n${line}`.trim(),
        ...(deal.quote ? { quote: { ...deal.quote, status } } : {}),
      })
      .eq("id", deal.id);
  }

  try {
    await engineSendText({
      accountId: input.accountId,
      userId: input.userId,
      conversationId: input.conversationId,
      contactId: input.contactId,
      text: parsed.accepted ? biz.quote.acceptedReply : biz.quote.changeReply,
    });
  } catch (err) {
    console.error("[quote] reply failed:", err);
  }
  if (repeated) return true;

  const { data: contact } = await db.from("contacts").select("name").eq("id", input.contactId).maybeSingle();
  const name = (contact as { name?: string | null } | null)?.name?.trim() || "Cliente";
  const title = parsed.accepted
    ? `✅ Cotización aceptada: ${name} — ${number} ${total}`.trim()
    : `✏️ Cotización: el cliente quiere cambiar algo — ${name}`;
  const body = parsed.accepted
    ? `${deal.title}. Coordine con el cliente el pago y la entrega.`
    : `${deal.title}. Escríbale para saber qué desea cambiar y envíe la cotización actualizada.`;
  await notifyAccountInApp(db, {
    accountId: input.accountId,
    conversationId: input.conversationId,
    contactId: input.contactId,
    title,
    body,
  }).catch(() => null);
  await notifyStaffOfHandoff(db, {
    accountId: input.accountId,
    contactName: name,
    summary: `${title}\n${body}`,
    conversationId: input.conversationId,
  }).catch(() => null);
  return true;
}
