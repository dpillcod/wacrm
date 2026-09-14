// ============================================================
// GET /api/tags
//
// Lists the caller's tags, for pickers that need to resolve a tag
// name to its id — e.g. the flow builder's `condition` ("contact has
// tag") and `set_tag` node forms (see
// src/components/flows/forms/node-config-form.tsx's `useUserTags`),
// which have silently fallen back to a raw-UUID text input ever
// since they were written, because this route never existed.
//
// Mirrors src/components/settings/tag-manager.tsx's own query
// exactly (scoped to the caller's user_id, not just account_id) so
// the tags shown here match what Settings → Tags shows the same
// user.
// ============================================================

import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";

interface TagRow {
  id: string;
  name: string;
  color: string | null;
}

export async function GET() {
  try {
    const ctx = await getCurrentAccount();

    const { data, error } = await ctx.supabase
      .from("tags")
      .select("id, name, color")
      .eq("user_id", ctx.userId)
      .order("created_at", { ascending: true });

    if (error) {
      console.error("[GET /api/tags] fetch error:", error);
      return NextResponse.json({ error: "Failed to load tags" }, { status: 500 });
    }

    const tags = (data as TagRow[]).map((row) => ({
      id: row.id,
      name: row.name,
      color: row.color ?? undefined,
    }));

    return NextResponse.json({ tags });
  } catch (err) {
    return toErrorResponse(err);
  }
}
