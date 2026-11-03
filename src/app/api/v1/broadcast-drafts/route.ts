// ============================================================
// POST /api/v1/broadcast-drafts — leave a broadcast for a person to
//                                 review and send (scope: broadcasts:draft).
//
// Body:
//   {
//     "name": "Lanzamiento Navidad",            // required
//     "template_name": "navidad_lanzamiento",   // required
//     "template_language": "es",                // optional
//     "header_image_url": "https://…/pieza.jpg",// optional, image header
//     "variables": ["{contact.name}", "5 %"],   // optional, {{1}}, {{2}}…
//     "audience_tags": ["Clientes frecuentes"], // optional, tag names
//     "text": "…",       // optional — the approved copy, for the reviewer
//     "ref": "NAV26-01", // optional — the piece's code in the design app
//     "note": "…"        // optional — a note for the reviewer
//   }
//
// Nothing is sent: the draft shows in Broadcasts (marked with the key's
// name), the account's admins get an in-app notification, and a person
// opens it, checks audience and preview, and sends. The same row then
// moves draft → sending → sent — poll GET /api/v1/broadcast-drafts/{id}.
//
// Response (201):
//   { "data": { "draft_id", "status": "draft", "template_status",
//               "unknown_tags", "review_url" } }
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { resolveAuditUserId } from '@/lib/api/v1/contacts';
import { draftOrigin, parseDraftInput } from '@/lib/broadcasts/drafts';
import { loadBusinessSettings } from '@/lib/business/settings';
import { appBaseUrl } from '@/lib/marketing/host-stats';

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'broadcasts:draft');
    const parsed = parseDraftInput(await request.json().catch(() => null));
    if ('error' in parsed) return fail('bad_request', parsed.error, 400);
    const input = parsed.input;
    const db = ctx.supabase;

    const [{ data: templates }, { data: tags }, { data: key }] = await Promise.all([
      db
        .from('message_templates')
        .select('name, language, status')
        .eq('account_id', ctx.accountId)
        .eq('name', input.templateName),
      input.audienceTags.length
        ? db.from('tags').select('id, name').eq('account_id', ctx.accountId)
        : Promise.resolve({ data: [] as { id: string; name: string }[] }),
      db.from('api_keys').select('name').eq('id', ctx.keyId).maybeSingle(),
    ]);
    const tpls = (templates ?? []) as { name: string; language: string | null; status: string | null }[];
    const template = tpls.find((t) => !input.templateLanguage || t.language === input.templateLanguage) ?? tpls[0];

    const byName = new Map(
      ((tags ?? []) as { id: string; name: string }[]).map((t) => [t.name.trim().toLowerCase(), t.id]),
    );
    const tagIds: string[] = [];
    const unknownTags: string[] = [];
    for (const name of input.audienceTags) {
      const id = byName.get(name.toLowerCase());
      if (id) tagIds.push(id);
      else unknownTags.push(name);
    }

    const source = (key as { name?: string } | null)?.name || 'API';
    const { data: row, error } = await db
      .from('broadcasts')
      .insert({
        user_id: await resolveAuditUserId(db, ctx.accountId),
        account_id: ctx.accountId,
        name: input.name,
        template_name: input.templateName,
        template_language: input.templateLanguage ?? template?.language ?? 'es',
        template_variables: input.variables,
        audience_filter: tagIds.length ? { type: 'tags', tagIds } : { type: 'all' },
        status: 'draft',
        total_recipients: 0,
        sent_count: 0,
        delivered_count: 0,
        read_count: 0,
        replied_count: 0,
        failed_count: 0,
        origin: draftOrigin(input, source),
      })
      .select('id')
      .single();
    if (error || !row) {
      console.error('[api/v1/broadcast-drafts] insert error:', error);
      return fail('internal', 'Failed to save the draft', 500);
    }

    const { data: admins } = await db
      .from('profiles')
      .select('user_id')
      .eq('account_id', ctx.accountId)
      .in('account_role', ['owner', 'admin']);
    const userIds = ((admins ?? []) as { user_id: string | null }[]).map((a) => a.user_id).filter((u): u is string => !!u);
    if (userIds.length) {
      await db.from('notifications').insert(
        userIds.map((user_id) => ({
          account_id: ctx.accountId,
          user_id,
          type: 'conversation_assigned',
          title: `📣 ${source}: borrador de difusión`,
          body: `«${input.name}» está en Difusiones para que lo revise y lo envíe.`,
        })),
      );
    }

    const biz = await loadBusinessSettings(db, ctx.accountId);
    return ok(
      {
        draft_id: row.id,
        status: 'draft',
        template_status: template?.status ?? 'missing',
        unknown_tags: unknownTags,
        review_url: `${appBaseUrl(biz, request)}/broadcasts/new?draft=${row.id}`,
      },
      201,
    );
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
