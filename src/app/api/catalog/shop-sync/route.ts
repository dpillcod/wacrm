import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { requireRole } from "@/lib/auth/account";
import { syncShopProducts } from "@/lib/catalog/shop-sync";

// GET /api/catalog/shop-sync
//   Cron (X-Cron-Secret = AUTOMATION_CRON_SECRET): syncs every account
//   that has a shop feed set. An admin signed in to the CRM can also
//   call it to sync their own account now.

function cronAuthorized(request: Request): boolean {
  const expected = process.env.AUTOMATION_CRON_SECRET;
  const supplied = request.headers.get("x-cron-secret") ?? "";
  if (!expected || !supplied) return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(request: Request) {
  const db = supabaseAdmin();
  if (cronAuthorized(request)) {
    const { data } = await db.from("business_settings").select("account_id, settings");
    const results: Record<string, unknown> = {};
    for (const row of (data ?? []) as { account_id: string; settings: { shopFeedUrl?: string } }[]) {
      if (!row.settings?.shopFeedUrl) continue;
      results[row.account_id] = await syncShopProducts(db, row.account_id);
    }
    return NextResponse.json({ results });
  }
  let accountId: string;
  try {
    accountId = (await requireRole("admin")).accountId;
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json(await syncShopProducts(db, accountId));
}
