// ============================================================
// Google Calendar through a service account — no Google SDK, just a
// signed JWT exchanged for an access token and the Calendar REST API.
//
// Setup (once): a service account in Google Cloud with the Calendar API
// enabled; the business calendar shared with the service account's
// email ("Make changes to events"). Server environment:
//   GOOGLE_SERVICE_ACCOUNT_JSON  the key file's JSON (or base64 of it)
//   GOOGLE_CALENDAR_ID           the calendar's id (Settings → Integrate)
// Without them every call is a no-op ("off").
// ============================================================

import { createSign } from "node:crypto";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://www.googleapis.com/calendar/v3";
const SCOPE = "https://www.googleapis.com/auth/calendar.events";

interface ServiceAccount {
  client_email: string;
  private_key: string;
}

export interface CalendarEventInput {
  summary: string;
  description?: string;
  location?: string;
  start: Date;
  minutes: number;
  timeZone: string;
}

function serviceAccount(): ServiceAccount | null {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  if (!raw) return null;
  try {
    const json = raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
    const sa = JSON.parse(json) as Partial<ServiceAccount>;
    return sa.client_email && sa.private_key ? { client_email: sa.client_email, private_key: sa.private_key } : null;
  } catch {
    console.error("[calendar] GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON");
    return null;
  }
}

export function calendarConfigured(): boolean {
  return !!serviceAccount() && !!process.env.GOOGLE_CALENDAR_ID?.trim();
}

const b64url = (data: string | Buffer) => Buffer.from(data).toString("base64url");

let cached: { token: string; expires: number } | null = null;

async function accessToken(): Promise<string> {
  if (cached && cached.expires > Date.now() + 60_000) return cached.token;
  const sa = serviceAccount();
  if (!sa) throw new Error("calendar not configured");
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  const signature = b64url(signer.sign(sa.private_key.replace(/\\n/g, "\n")));
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${header}.${claims}.${signature}`,
    }),
  });
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!res.ok || !json.access_token) throw new Error(`google token: ${res.status} ${json.error_description ?? ""}`);
  cached = { token: json.access_token, expires: Date.now() + (json.expires_in ?? 3600) * 1000 };
  return json.access_token;
}

function eventBody(e: CalendarEventInput) {
  const end = new Date(e.start.getTime() + e.minutes * 60_000);
  return {
    summary: e.summary,
    description: e.description,
    location: e.location,
    start: { dateTime: e.start.toISOString(), timeZone: e.timeZone },
    end: { dateTime: end.toISOString(), timeZone: e.timeZone },
    reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 24 * 60 }, { method: "popup", minutes: 120 }] },
  };
}

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  const calendarId = encodeURIComponent(process.env.GOOGLE_CALENDAR_ID!.trim());
  return fetch(`${API}/calendars/${calendarId}${path}`, {
    method,
    headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
}

/** Create or update the event; returns its id. */
export async function upsertCalendarEvent(eventId: string | null, e: CalendarEventInput): Promise<string> {
  if (eventId) {
    const res = await call("PATCH", `/events/${encodeURIComponent(eventId)}`, eventBody(e));
    if (res.ok) return ((await res.json()) as { id: string }).id;
    // Deleted in Google by hand: create it again.
    if (res.status !== 404 && res.status !== 410) throw new Error(`calendar update: ${res.status} ${await res.text()}`);
  }
  const res = await call("POST", "/events", eventBody(e));
  if (!res.ok) throw new Error(`calendar create: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { id: string }).id;
}

export async function deleteCalendarEvent(eventId: string): Promise<void> {
  const res = await call("DELETE", `/events/${encodeURIComponent(eventId)}`);
  if (!res.ok && res.status !== 404 && res.status !== 410) throw new Error(`calendar delete: ${res.status}`);
}
