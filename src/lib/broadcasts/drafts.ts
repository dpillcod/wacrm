// ============================================================
// Broadcast drafts left by another app (POST /api/v1/broadcast-drafts)
// — pure, no I/O.
//
// A marketing app proposes a broadcast: an approved template, the
// header image, the body values and a suggested audience. It lands in
// Broadcasts as a draft; a person reviews it and sends it. The app can
// never send by itself.
// ============================================================

export type DraftVariable = { type: 'static'; value: string } | { type: 'field'; value: 'name' | 'phone' };

export interface DraftOrigin {
  source: string;
  ref: string | null;
  note: string | null;
  text: string | null;
  headerMediaUrl: string | null;
  suggestedTags: string[];
}

export interface DraftInput {
  name: string;
  templateName: string;
  templateLanguage: string | null;
  headerImageUrl: string | null;
  variables: Record<string, DraftVariable>;
  audienceTags: string[];
  text: string | null;
  ref: string | null;
  note: string | null;
}

const str = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null;
  const s = v.trim().slice(0, max);
  return s || null;
};

/** "{contact.name}" / "{contact.phone}" fill per customer; anything else is sent as written. */
function toVariable(v: string): DraftVariable {
  const field = /^\{\{?\s*contact\.(name|phone)\s*\}?\}$/i.exec(v.trim());
  return field ? { type: 'field', value: field[1].toLowerCase() as 'name' | 'phone' } : { type: 'static', value: v };
}

/** Validate the request body; `error` names the first bad field. */
export function parseDraftInput(body: unknown): { input: DraftInput } | { error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Request body must be a JSON object' };
  const b = body as Record<string, unknown>;

  const name = str(b.name, 120);
  if (!name) return { error: '`name` is required' };
  const templateName = str(b.template_name, 512);
  if (!templateName || !/^[a-z0-9_]+$/.test(templateName)) {
    return { error: '`template_name` is required (lowercase letters, digits and _)' };
  }

  let headerImageUrl: string | null = null;
  if (b.header_image_url !== undefined && b.header_image_url !== null) {
    headerImageUrl = str(b.header_image_url, 2000);
    if (!headerImageUrl || !/^https:\/\/\S+$/i.test(headerImageUrl)) {
      return { error: '`header_image_url` must be an https URL' };
    }
  }

  const variables: Record<string, DraftVariable> = {};
  if (b.variables !== undefined) {
    if (!Array.isArray(b.variables) || b.variables.length > 20) {
      return { error: '`variables` must be a list of up to 20 strings ({{1}}, {{2}}…)' };
    }
    for (const [i, v] of b.variables.entries()) {
      if (typeof v !== 'string' || !v.trim()) return { error: `\`variables[${i}]\` must be a non-empty string` };
      variables[String(i + 1)] = toVariable(v.slice(0, 1000));
    }
  }

  const audienceTags: string[] = [];
  if (b.audience_tags !== undefined) {
    if (!Array.isArray(b.audience_tags) || b.audience_tags.length > 20) {
      return { error: '`audience_tags` must be a list of up to 20 tag names' };
    }
    for (const t of b.audience_tags) {
      const tag = str(t, 80);
      if (tag && !audienceTags.includes(tag)) audienceTags.push(tag);
    }
  }

  return {
    input: {
      name,
      templateName,
      templateLanguage: str(b.template_language, 20),
      headerImageUrl,
      variables,
      audienceTags,
      text: str(b.text, 2000),
      ref: str(b.ref, 60),
      note: str(b.note, 500),
    },
  };
}

/** The draft's origin, as stored on the broadcast row. */
export function draftOrigin(input: DraftInput, source: string): DraftOrigin {
  return {
    source: source.slice(0, 80),
    ref: input.ref,
    note: input.note,
    text: input.text,
    headerMediaUrl: input.headerImageUrl,
    suggestedTags: input.audienceTags,
  };
}

/** Read `origin` back from a row (null for broadcasts made in the CRM). */
export function readOrigin(v: unknown): DraftOrigin | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const s = (x: unknown) => (typeof x === 'string' && x ? x : null);
  return {
    source: s(o.source) ?? 'api',
    ref: s(o.ref),
    note: s(o.note),
    text: s(o.text),
    headerMediaUrl: s(o.headerMediaUrl),
    suggestedTags: Array.isArray(o.suggestedTags) ? o.suggestedTags.filter((t): t is string => typeof t === 'string') : [],
  };
}
