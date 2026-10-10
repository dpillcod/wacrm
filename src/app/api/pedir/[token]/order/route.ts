import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { readOrderLinkToken } from "@/lib/catalog/order-link";
import { cartOrderLines, cleanItems, clearCart } from "@/lib/catalog/carts";
import { customerWindowOpen } from "@/lib/pipelines/order-cards";
import { receiveCatalogOrder } from "@/lib/flows/engine";
import { checkRateLimit } from "@/lib/rate-limit";

// POST /api/pedir/<token>/order   { items: [{ sku, qty }], note? }
//   Public (the signed link is the key). Prices come from the database,
//   never from the browser. The list lands in the customer's WhatsApp
//   chat, where the bot shows it with the estimated total.
//
//   200 { ok, lines, total }   400 bad request   401/410 bad/expired link
//   409 { error: "window_closed" } — the customer hasn't written in 24 h

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const check = readOrderLinkToken(token);
  if (!check.ok) return NextResponse.json({ error: check.reason }, { status: check.reason === "expired" ? 410 : 401 });
  const limit = checkRateLimit(`pedir-order:${token.slice(-32)}`, { limit: 10, windowMs: 60_000 });
  if (!limit.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

  let body: { items?: unknown; note?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }
  const items = cleanItems(body.items);
  const note = typeof body.note === "string" ? body.note.slice(0, 1000) : "";
  if (items.length === 0 && !note.trim()) return NextResponse.json({ error: "empty" }, { status: 400 });

  const db = supabaseAdmin();
  const { accountId, contactId, conversationId } = check.link;
  const { data: conv } = await db
    .from("conversations")
    .select("id")
    .eq("id", conversationId)
    .eq("account_id", accountId)
    .eq("contact_id", contactId)
    .maybeSingle();
  if (!conv) return NextResponse.json({ error: "invalid" }, { status: 401 });
  if (!(await customerWindowOpen(db, conversationId))) {
    return NextResponse.json({ error: "window_closed" }, { status: 409 });
  }

  let lines: string[];
  let total: number;
  try {
    ({ lines, total } = await cartOrderLines(db, accountId, items));
  } catch (err) {
    console.error("[pedir] product lookup failed:", err);
    return NextResponse.json({ error: "lookup_failed" }, { status: 500 });
  }
  if (lines.length === 0 && !note.trim()) return NextResponse.json({ error: "empty" }, { status: 400 });

  const result = await receiveCatalogOrder({ accountId, contactId, conversationId, lines, note });
  if (!result.ok) {
    console.error("[pedir] could not deliver the order:", result.error);
    return NextResponse.json({ error: "delivery_failed" }, { status: 500 });
  }
  await clearCart(db, accountId, contactId).catch(() => undefined);
  return NextResponse.json({ ok: true, lines: lines.length, total });
}
