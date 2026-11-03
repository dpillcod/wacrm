// ============================================================
// GET /api/v1/broadcast-drafts/{id} — what became of a draft
// (scope: broadcasts:draft).
//
// `status` stays 'draft' until a person sends it, then moves
// 'sending' → 'sent' with the delivery counts. Only drafts left
// through the API are visible here; a foreign or CRM-made id → 404.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireApiKey(request, 'broadcasts:draft');
    const { id } = await params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return fail('not_found', 'Draft not found', 404);

    const { data, error } = await ctx.supabase
      .from('broadcasts')
      .select(
        'id, name, template_name, status, total_recipients, sent_count, delivered_count, read_count, replied_count, failed_count, created_at, updated_at',
      )
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .not('origin', 'is', null)
      .maybeSingle();
    if (error) {
      console.error('[api/v1/broadcast-drafts] read error:', error);
      return fail('internal', 'Failed to read draft', 500);
    }
    if (!data) return fail('not_found', 'Draft not found', 404);
    return ok(data);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
