import type { SupabaseClient } from "@supabase/supabase-js";
import { loadBusinessSettings, renderText } from "@/lib/business/settings";
import { engineSendText } from "@/lib/flows/meta-send";
import { isWithinBusinessHours } from "@/lib/flows/store-policy";
import { customerWindowOpen } from "./order-cards";

// ============================================================
// Google review request after a delivered order (tablero C4).
//
// Google's rules: ask EVERY customer the same way. No rewards, and no
// "review gating" (asking "¿quedó contento?" first and sending the link
// only to the ones who say yes). So the satisfaction survey never
// carries the link; this request goes to everyone whose card reached
// "Entregado", whatever they rated:
//
//   - orderBoard.reviewDelayHours after delivery (2 by default), during
//     opening hours;
//   - once per customer every 90 days;
//   - only inside the free 24 h window (no paid template); otherwise
//     it's skipped.
//
// The card's delivered_at is set by the stage-changed route; the cron
// (/api/flows/cron, every 5 minutes) sends what's due.
// ============================================================

const ONCE_EVERY_MS = 90 * 86_400_000;
/** Cards delivered longer ago than this aren't asked any more (the window would be closed anyway). */
const GIVE_UP_MS = 26 * 3_600_000;

/** First time a card reaches "Entregado". */
export async function markDelivered(db: SupabaseClient, dealId: string): Promise<void> {
  const { error } = await db
    .from("deals")
    .update({ delivered_at: new Date().toISOString() })
    .eq("id", dealId)
    .is("delivered_at", null);
  if (error) console.error("[review-request] delivered_at not saved:", error.message);
}

interface PendingDeal {
  id: string;
  account_id: string;
  contact_id: string | null;
  conversation_id: string | null;
  delivered_at: string;
}

export type ReviewDecision = "wait" | "send" | "skip";

/** Pure: what to do with one delivered card now. */
export function reviewDecision(args: {
  deliveredAt: Date;
  now: Date;
  delayHours: number;
  reviewUrl: string;
  open: boolean;
  hasConversation: boolean;
  askedRecently: boolean;
  windowOpen: boolean;
}): ReviewDecision {
  if (!args.delayHours || !args.reviewUrl) return "wait";
  if (args.now.getTime() - args.deliveredAt.getTime() < args.delayHours * 3_600_000) return "wait";
  if (!args.hasConversation || args.askedRecently || !args.windowOpen) return "skip";
  if (!args.open) return "wait";
  return "send";
}

/** Sends the review requests due now; returns how many went out. */
export async function sweepReviewRequests(db: SupabaseClient, now: Date = new Date()): Promise<number> {
  const { data, error } = await db
    .from("deals")
    .select("id, account_id, contact_id, conversation_id, delivered_at")
    .not("delivered_at", "is", null)
    .is("review_request_status", null)
    .gte("delivered_at", new Date(now.getTime() - GIVE_UP_MS).toISOString())
    .order("delivered_at", { ascending: true })
    .limit(200);
  if (error) {
    // Migration 054 not applied yet: nothing to do.
    if (!/column|does not exist/i.test(error.message)) console.error("[review-request] scan failed:", error.message);
    return 0;
  }
  let sent = 0;
  for (const deal of (data ?? []) as PendingDeal[]) {
    const biz = await loadBusinessSettings(db, deal.account_id);
    let askedRecently = false;
    if (deal.contact_id) {
      const { count } = await db
        .from("deals")
        .select("id", { count: "exact", head: true })
        .eq("contact_id", deal.contact_id)
        .eq("review_request_status", "sent")
        .gte("review_requested_at", new Date(now.getTime() - ONCE_EVERY_MS).toISOString());
      askedRecently = (count ?? 0) > 0;
    }
    const decision = reviewDecision({
      deliveredAt: new Date(deal.delivered_at),
      now,
      delayHours: biz.orderBoard.reviewDelayHours,
      reviewUrl: biz.googleReviewUrl,
      open: isWithinBusinessHours(biz, now),
      hasConversation: !!deal.conversation_id && !!deal.contact_id,
      askedRecently,
      windowOpen: deal.conversation_id ? await customerWindowOpen(db, deal.conversation_id) : false,
    });
    if (decision === "wait") continue;

    let status: "sent" | "skipped" = "skipped";
    if (decision === "send") {
      const { data: config } = await db.from("whatsapp_config").select("user_id").eq("account_id", deal.account_id).maybeSingle();
      try {
        await engineSendText({
          accountId: deal.account_id,
          userId: (config as { user_id?: string } | null)?.user_id ?? "",
          conversationId: deal.conversation_id!,
          contactId: deal.contact_id!,
          text: renderText(biz.orderBoard.reviewRequest, { resena: biz.googleReviewUrl, negocio: biz.name }),
        });
        status = "sent";
        sent += 1;
      } catch (err) {
        console.error("[review-request] send failed:", err instanceof Error ? err.message : err);
      }
    }
    await db
      .from("deals")
      .update({ review_request_status: status, review_requested_at: now.toISOString() })
      .eq("id", deal.id);
  }
  return sent;
}
