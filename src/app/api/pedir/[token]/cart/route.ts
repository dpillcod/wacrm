import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { readOrderLinkToken } from "@/lib/catalog/order-link";
import { cleanItems, saveCart } from "@/lib/catalog/carts";
import { scheduleCartReminder } from "@/lib/flows/engine";
import { checkRateLimit } from "@/lib/rate-limit";

// PUT /api/pedir/<token>/cart   { items: [{ sku, qty }], note? }
//   Public (the signed link is the key). Keeps what the customer has
//   picked so far: a new link opens with the same cart, and the bot can
//   remind them if they leave without sending it. 204 on success.

export async function PUT(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const check = readOrderLinkToken(token);
  if (!check.ok) return NextResponse.json({ error: check.reason }, { status: check.reason === "expired" ? 410 : 401 });
  const limit = checkRateLimit(`pedir-cart:${token.slice(-32)}`, { limit: 60, windowMs: 60_000 });
  if (!limit.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

  let body: { items?: unknown; note?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }
  const { accountId, contactId, conversationId } = check.link;
  const items = cleanItems(body.items);
  const note = typeof body.note === "string" ? body.note.slice(0, 1000) : "";
  try {
    await saveCart(supabaseAdmin(), { accountId, contactId, conversationId, items, note });
  } catch (err) {
    console.error("[pedir] cart save failed:", err);
    return NextResponse.json({ error: "save_failed" }, { status: 500 });
  }
  if (items.length) scheduleCartReminder(accountId, contactId);
  return new NextResponse(null, { status: 204 });
}
