// ============================================================
// POST /api/webhooks/woocommerce/[accountId]
//
// Receives WooCommerce's native "order created" webhook (configured
// in the store's own admin: WooCommerce → Settings → Advanced →
// Webhooks — zero code on that side) and hands the order off to a
// dedicated flow, so a customer who checks out on the real website
// (real photos/prices/stock, a normal cart — see contenido-web /
// catalog discussion) gets a WhatsApp follow-up (payment QR, cédula/
// RUC for the invoice, staff notification) without retyping their
// order back into the chat.
//
// `accountId` is in the URL because wacrm is multi-tenant and
// WooCommerce has no idea any of that exists — it just posts to
// whatever delivery URL you configured for this store's webhook.
//
// Auth model: no session, no API key — WooCommerce signs the request
// body with a shared secret (HMAC-SHA256, base64, same algorithm
// WooCommerce always uses for its own webhooks) that's set once in
// both places: the webhook's "Secret" field in WooCommerce, and
// `whatsapp_config.woocommerce_webhook_secret` here.
//
// Best-effort, like every other webhook receiver in this codebase
// (the WhatsApp webhook, the outbound event webhooks in
// docs/public-api.md): always 200 once the signature checks out, so
// WooCommerce doesn't retry-storm us over a downstream hiccup (a
// contact lookup failing, the target flow being paused, etc.) — those
// get logged, not retried.
// ============================================================

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import crypto from "crypto";

import { resolveConversationByPhone } from "@/lib/whatsapp/resolve-conversation";
import { SendMessageError } from "@/lib/whatsapp/send-message";
import { startFlowRunForExternalEvent } from "@/lib/flows/engine";

let _adminClient: SupabaseClient | null = null;
function supabaseAdmin(): SupabaseClient {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    );
  }
  return _adminClient;
}

interface WooCommerceLineItem {
  name?: string;
  quantity?: number;
}

interface WooCommerceOrderPayload {
  id?: number | string;
  total?: string;
  payment_method?: string;
  billing?: {
    first_name?: string;
    last_name?: string;
    phone?: string;
  };
  line_items?: WooCommerceLineItem[];
}

/** True when `signature` (base64) is a valid HMAC-SHA256 of `rawBody`
 *  under `secret` — WooCommerce's own webhook-signing algorithm.
 *  Exported for testing without needing a live request/DB. */
export function isValidWooCommerceSignature(
  rawBody: string,
  signature: string | null,
  secret: string,
): boolean {
  if (!signature) return false;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("base64");
  const expectedBuf = Buffer.from(expected);
  const gotBuf = Buffer.from(signature);
  if (expectedBuf.length !== gotBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, gotBuf);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ accountId: string }> },
) {
  const { accountId } = await params;
  const db = supabaseAdmin();

  // Raw text first — the signature is computed over the exact bytes
  // WooCommerce sent, not a re-serialized JSON.parse/stringify
  // round-trip (which can byte-differ on key order/whitespace).
  const rawBody = await request.text();

  const { data: config, error: configError } = await db
    .from("whatsapp_config")
    .select("woocommerce_webhook_secret, woocommerce_order_flow_id")
    .eq("account_id", accountId)
    .maybeSingle();
  if (configError || !config?.woocommerce_webhook_secret) {
    // Not configured for this account — nothing to verify against.
    // 404 rather than 200: a delivery URL pointed at an account with
    // no secret set is a setup mistake worth WooCommerce's admin UI
    // flagging (it marks the webhook "failing" on non-2xx), not a
    // steady-state condition to silently swallow forever.
    return NextResponse.json({ error: "not configured" }, { status: 404 });
  }

  const signature = request.headers.get("x-wc-webhook-signature");
  if (
    !isValidWooCommerceSignature(
      rawBody,
      signature,
      config.woocommerce_webhook_secret,
    )
  ) {
    console.error("[woocommerce webhook] signature mismatch", { accountId });
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  // From here on: signature verified, always answer 200 — any
  // failure past this point is ours to log and investigate, not
  // WooCommerce's to retry.
  const topic = request.headers.get("x-wc-webhook-topic");
  if (topic !== "order.created") {
    return NextResponse.json({ ok: true, skipped: "topic" });
  }

  if (!config.woocommerce_order_flow_id) {
    console.error("[woocommerce webhook] no flow configured", { accountId });
    return NextResponse.json({ ok: true, skipped: "no_flow_configured" });
  }

  let order: WooCommerceOrderPayload;
  try {
    order = JSON.parse(rawBody) as WooCommerceOrderPayload;
  } catch {
    return NextResponse.json({ error: "malformed json" }, { status: 400 });
  }

  const phone = order.billing?.phone;
  if (!phone) {
    console.error("[woocommerce webhook] order has no billing phone", {
      accountId,
      orderId: order.id,
    });
    return NextResponse.json({ ok: true, skipped: "no_phone" });
  }
  const customerName = [order.billing?.first_name, order.billing?.last_name]
    .filter(Boolean)
    .join(" ")
    .trim();

  try {
    const { conversationId, contactId } = await resolveConversationByPhone(
      db,
      accountId,
      phone,
      customerName || undefined,
    );

    const itemsSummary =
      (order.line_items ?? [])
        .map((li) => `${li.quantity ?? 1}x ${li.name ?? "?"}`)
        .join(", ") || "(sin detalle)";

    const result = await startFlowRunForExternalEvent(
      db,
      config.woocommerce_order_flow_id,
      {
        contactId,
        conversationId,
        vars: {
          order_id: String(order.id ?? ""),
          order_total: order.total ?? "",
          payment_method: order.payment_method ?? "",
          order_items_summary: itemsSummary,
        },
      },
    );

    return NextResponse.json({ ok: true, outcome: result.outcome });
  } catch (err) {
    if (err instanceof SendMessageError) {
      console.error("[woocommerce webhook] resolve conversation failed:", {
        accountId,
        code: err.code,
        message: err.message,
      });
    } else {
      console.error("[woocommerce webhook] unexpected error:", err);
    }
    // Still 200 — see best-effort note above.
    return NextResponse.json({ ok: true, skipped: "processing_error" });
  }
}
