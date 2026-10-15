// ============================================================
// The customer's billing profile, asked once (name, ID number, email)
// and kept on the contact: name → contacts.name, email →
// contacts.email, ID number → the custom field named in business
// settings (idNumberFieldName). Next time the bot greets them by that
// name and the invoice data is already known — no "¿con datos o
// consumidor final?" question.
//
// Pure parsing / validation at the top (unit-tested); the database
// helpers below.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

export const FINAL_CONSUMER = "CONSUMIDOR FINAL";

export interface CustomerProfile {
  /** Full name as typed, tidied ("Juan Carlos Pérez López"). */
  name: string;
  /** Cédula / RUC, or FINAL_CONSUMER. */
  idNumber: string;
  email: string;
}

export type ProfilePart = "name" | "id" | "email";

export type ProfileParse =
  | { ok: true; profile: CustomerProfile }
  /** An ID number was given but isn't valid. */
  | { ok: false; problem: "id"; bad: string }
  /** Parts still to come (typed in several messages, or left out). */
  | { ok: false; problem: "missing"; missing: ProfilePart[] };

/** Ecuadorian cédula (10 digits, province + check digit). */
export function validCedula(id: string): boolean {
  if (!/^\d{10}$/.test(id)) return false;
  const province = Number(id.slice(0, 2));
  if (!((province >= 1 && province <= 24) || province === 30)) return false;
  if (Number(id[2]) >= 6) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    let d = Number(id[i]) * (i % 2 === 0 ? 2 : 1);
    if (d > 9) d -= 9;
    sum += d;
  }
  return (10 - (sum % 10)) % 10 === Number(id[9]);
}

/** Ecuadorian RUC: 13 digits ending in 001; a person's RUC starts with their cédula. */
export function validRuc(id: string): boolean {
  if (!/^\d{10}001$/.test(id)) return false;
  const province = Number(id.slice(0, 2));
  if (!((province >= 1 && province <= 24) || province === 30)) return false;
  const third = Number(id[2]);
  return third < 6 ? validCedula(id.slice(0, 10)) : third === 6 || third === 9;
}

/** An ID number for the country (Ecuador: cédula or RUC; elsewhere 5–20 letters/digits). */
export function validIdNumber(id: string, countryCode: string): boolean {
  if (countryCode === "593") return validCedula(id) || validRuc(id);
  return /^[A-Za-z0-9-]{5,20}$/.test(id);
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const EMAIL_ALL = new RegExp(EMAIL.source, "g");
const ID_ALL = /\d[\d .-]{8,20}\d/g;
// A shared location ("-2.9070, -79.0427") or a link isn't an ID number.
const NOT_ID = /-?\d{1,3}\.\d{3,}\s*,\s*-?\d{1,3}\.\d{3,}|https?:\/\/\S+/g;

/** The text without coordinates and links, for reading an ID number. */
export function withoutCoordinates(text: string): string {
  return text.replace(NOT_ID, " ");
}
const LABELS = /(^|\s)(nombres?|apellidos?|c[eé]dula|ruc|correo|email|mail|completo)\s*:?/giu;

function tidyName(raw: string): string {
  return raw
    .replace(/[^\p{L}\s'.-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("es")
    .replace(/(^|[\s'-])(\p{L})/gu, (_, sep: string, ch: string) => sep + ch.toLocaleUpperCase("es"));
}

function plain(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

/** "consumidor final", "sin datos", "cf". */
export function isFinalConsumer(text: string): boolean {
  return /^(consumidor\s*final|cf|sin\s+datos|sin\s+factura|no\s+deseo\s+factura|final)\.?$/.test(plain(text));
}

/** "no acepto", "no autorizo", "no gracias" — declines to give data. */
export function isRefusal(text: string): boolean {
  return /^(no|no acepto|no autorizo|no gracias|no deseo|no quiero|no doy mis datos|no, gracias)[.!]*$/.test(plain(text));
}

// Words that never appear in a person's name: "Voy a pasar viendo de su
// tienda", "Solo 5 paquetes perdón", "Cuánto sale" are not names.
const NOT_NAME_WORDS = new Set(
  ("a al con de del el en la las lo los y o u e por para que su sus mi mis me te se le les un una unos unas " +
    "es esta este esto estoy voy va vamos ir pasar paso viendo ver tienda tiene tienen tengo hay quiero quisiera " +
    "necesito deseo puede pueden podria favor gracias perdon disculpe hola buenos buenas dias tardes noches " +
    "cuanto cuanta cuesta sale precio solo nomas mas menos paquete paquetes funda fundas litro litros kilo libra " +
    "no si ok listo bueno perfecto claro").split(" "),
);
// Particles that are fine INSIDE a name ("María de los Ángeles", "Juan del Pozo").
const NAME_PARTICLES = new Set(["de", "del", "la", "las", "los", "y"]);

/** "Pamela Gárate" yes; "Voy a pasar viendo de su tienda" no. */
export function looksLikePersonName(line: string): boolean {
  if (/[?¿!¡\d@]/.test(line)) return false;
  const words = plain(line).replace(/[^a-zñ\s'-]/g, " ").split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 6) return false;
  return words.every((w, i) => {
    if (NAME_PARTICLES.has(w)) return i > 0 && i < words.length - 1;
    return w.length > 1 && !NOT_NAME_WORDS.has(w);
  });
}

/**
 * The customer's name among everything they typed while registering:
 * the name written next to the ID number wins (same line or the line
 * before it), then the last line that looks like a name.
 */
export function pickName(lines: string[]): string {
  const withoutIds = lines.map((l) => l.replace(EMAIL_ALL, " ").replace(LABELS, " "));
  const hasId = withoutIds.map((l) => /\d[\d .-]{8,20}\d/.test(withoutCoordinates(l)));
  const candidates = withoutIds
    .map((l, i) => ({ i, raw: l.replace(ID_ALL, " ").trim() }))
    .filter((c) => looksLikePersonName(c.raw));
  const nextToId = [...candidates].reverse().find((c) => hasId[c.i] || hasId[c.i + 1]);
  const chosen = nextToId ?? candidates.at(-1);
  return chosen ? tidyName(chosen.raw) : "";
}

/**
 * Read a profile from a submitted form ({nombre, cedula, correo}) or a
 * typed message ("Juan Pérez 0102030405 juan@mail.com", in any order).
 */
export function parseCustomerProfile(
  input: { fields?: Record<string, unknown>; text?: string },
  countryCode: string,
): ProfileParse {
  const f = input.fields ?? {};
  const field = (k: string) => (typeof f[k] === "string" ? (f[k] as string).trim() : "");
  let name = field("nombre") || field("name");
  let id = (field("cedula") || field("id_number")).replace(/[\s.-]/g, "");
  let email = field("correo") || field("email");
  const text = (input.text ?? "").trim();
  if (!name && !id && !email) {
    if (!text) return { ok: false, problem: "missing", missing: ["name", "id", "email"] };
    if (isFinalConsumer(text)) {
      return { ok: true, profile: { name: "", idNumber: FINAL_CONSUMER, email: "" } };
    }
    // Typed over several messages (one per line), maybe repeated after
    // a correction: the last email, the last ID number and the last line
    // that holds a full name win.
    email = text.match(EMAIL_ALL)?.at(-1) ?? "";
    id = withoutCoordinates(text.replace(EMAIL_ALL, " ")).match(ID_ALL)?.at(-1)?.replace(/[\s.-]/g, "") ?? "";
    name = pickName(text.split("\n"));
  }
  name = tidyName(name);
  email = email.toLowerCase();
  if (id && !validIdNumber(id, countryCode)) return { ok: false, problem: "id", bad: id };
  const missing: ProfilePart[] = [];
  if (name.split(" ").filter((w) => w.length > 1).length < 2) missing.push("name");
  if (!id) missing.push("id");
  if (!EMAIL.test(email)) missing.push("email");
  if (missing.length) return { ok: false, problem: "missing", missing };
  return { ok: true, profile: { name, idNumber: id, email } };
}

const PART_NAMES: Record<ProfilePart, string> = {
  name: "su nombre completo (nombres y apellidos)",
  id: "su cédula o RUC",
  email: "su correo para la factura",
};

/** What to tell the customer when the data isn't complete or valid. */
export function profileProblemText(p: Exclude<ProfileParse, { ok: true }>): string {
  if (p.problem === "id") {
    return `La cédula o RUC *${p.bad}* no es válida 🤔 Revísela por favor y escríbala de nuevo.`;
  }
  if (p.missing.length === 3) return "No recibí sus datos 🤔 Escríbame su nombre completo, cédula y correo, o toque *Registrar mis datos*.";
  const parts = p.missing.map((m) => PART_NAMES[m]);
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} y ${parts.at(-1)}` : parts[0];
  return `Gracias 🙂 Me falta ${list}.`;
}

/** "Juan Carlos Pérez López" → "Juan Carlos"; "Ana Pérez" → "Ana". */
export function greetingName(fullName: string): string {
  const words = fullName.trim().split(/\s+/).filter(Boolean);
  return (words.length >= 4 ? words.slice(0, 2) : words.slice(0, 1)).join(" ");
}

/** One line for the list step and the clerk's note. */
export function billingLine(p: CustomerProfile): string {
  if (p.idNumber === FINAL_CONSUMER) return "Consumidor final";
  return `${p.name} · ${p.idNumber} · ${p.email}`;
}

// ---------------------------------------------------------------- db

async function idFieldId(
  db: SupabaseClient,
  accountId: string,
  fieldName: string,
  createAs?: string,
): Promise<string | null> {
  const { data } = await db
    .from("custom_fields")
    .select("id")
    .eq("account_id", accountId)
    .eq("field_name", fieldName)
    .limit(1);
  const id = (data as { id: string }[] | null)?.[0]?.id;
  if (id || !createAs) return id ?? null;
  const { data: created, error } = await db
    .from("custom_fields")
    .insert({ account_id: accountId, user_id: createAs, field_name: fieldName, field_type: "text" })
    .select("id")
    .single();
  if (error) throw new Error(`custom field: ${error.message}`);
  return (created as { id: string }).id;
}

/** The saved profile, or null when the customer hasn't registered. */
export async function loadCustomerProfile(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  idFieldName: string,
): Promise<CustomerProfile | null> {
  const fieldId = await idFieldId(db, accountId, idFieldName);
  if (!fieldId) return null;
  const [{ data: value }, { data: contact }] = await Promise.all([
    db.from("contact_custom_values").select("value").eq("contact_id", contactId).eq("custom_field_id", fieldId).maybeSingle(),
    db.from("contacts").select("name, email").eq("id", contactId).maybeSingle(),
  ]);
  const idNumber = ((value as { value?: string | null } | null)?.value ?? "").trim();
  if (!idNumber) return null;
  const c = (contact as { name?: string | null; email?: string | null } | null) ?? {};
  return { name: (c.name ?? "").trim(), idNumber, email: (c.email ?? "").trim() };
}

/** Keep the profile on the contact (a final consumer keeps their WhatsApp name). */
export async function saveCustomerProfile(
  db: SupabaseClient,
  args: { accountId: string; userId: string; contactId: string; idFieldName: string; profile: CustomerProfile },
): Promise<void> {
  const { profile } = args;
  if (profile.idNumber !== FINAL_CONSUMER) {
    const { error } = await db
      .from("contacts")
      .update({ name: profile.name, email: profile.email, updated_at: new Date().toISOString() })
      .eq("id", args.contactId)
      .eq("account_id", args.accountId);
    if (error) throw new Error(`contact: ${error.message}`);
  }
  const fieldId = await idFieldId(db, args.accountId, args.idFieldName, args.userId);
  const { error } = await db
    .from("contact_custom_values")
    .upsert(
      { contact_id: args.contactId, custom_field_id: fieldId, value: profile.idNumber },
      { onConflict: "contact_id,custom_field_id" },
    );
  if (error) throw new Error(`id number: ${error.message}`);
}
