// ============================================================
// The personal link to the product picker (/pedir/<token>): which
// account, contact and conversation it belongs to, and until when —
// signed so nobody can forge one or edit it to reach another chat.
//
// Compact on purpose (it goes in a WhatsApp button): the three UUIDs as
// raw bytes + a 4-byte expiry + a 16-byte HMAC-SHA256, base64url —
// about 91 characters. No database row: the signature is the proof.
// ============================================================

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export interface OrderLink {
  accountId: string;
  contactId: string;
  conversationId: string;
  /** Unix seconds. */
  expiresAt: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAYLOAD_BYTES = 16 * 3 + 4;
const SIG_BYTES = 16;

function secret(): Buffer {
  const own = process.env.ORDER_LINK_SECRET;
  if (own) return Buffer.from(own, "utf8");
  const base = process.env.ENCRYPTION_KEY;
  if (!base) throw new Error("ORDER_LINK_SECRET or ENCRYPTION_KEY must be set");
  // A key of its own, derived — never the encryption key itself.
  return createHash("sha256").update(`order-link:${base}`).digest();
}

function uuidBytes(id: string): Buffer {
  if (!UUID_RE.test(id)) throw new Error(`not a uuid: ${id}`);
  return Buffer.from(id.replace(/-/g, ""), "hex");
}

function bytesUuid(b: Buffer): string {
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function sign(payload: Buffer): Buffer {
  return createHmac("sha256", secret()).update(payload).digest().subarray(0, SIG_BYTES);
}

export function createOrderLinkToken(link: OrderLink): string {
  const exp = Buffer.alloc(4);
  exp.writeUInt32BE(Math.max(0, Math.floor(link.expiresAt)));
  const payload = Buffer.concat([uuidBytes(link.accountId), uuidBytes(link.contactId), uuidBytes(link.conversationId), exp]);
  return Buffer.concat([payload, sign(payload)]).toString("base64url");
}

export type OrderLinkCheck =
  | { ok: true; link: OrderLink }
  | { ok: false; reason: "invalid" | "expired" };

/** Checks the signature and the expiry; never throws. */
export function readOrderLinkToken(token: string, now: Date = new Date()): OrderLinkCheck {
  let raw: Buffer;
  try {
    if (!/^[A-Za-z0-9_-]{40,140}$/.test(token)) return { ok: false, reason: "invalid" };
    raw = Buffer.from(token, "base64url");
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (raw.length !== PAYLOAD_BYTES + SIG_BYTES) return { ok: false, reason: "invalid" };
  const payload = raw.subarray(0, PAYLOAD_BYTES);
  const sig = raw.subarray(PAYLOAD_BYTES);
  let expected: Buffer;
  try {
    expected = sign(payload);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (!timingSafeEqual(sig, expected)) return { ok: false, reason: "invalid" };
  const link: OrderLink = {
    accountId: bytesUuid(payload.subarray(0, 16)),
    contactId: bytesUuid(payload.subarray(16, 32)),
    conversationId: bytesUuid(payload.subarray(32, 48)),
    expiresAt: payload.readUInt32BE(48),
  };
  if (link.expiresAt * 1000 < now.getTime()) return { ok: false, reason: "expired" };
  return { ok: true, link };
}

/** "https://crm.example.com" → "https://crm.example.com/pedir/<token>"; null without an https base. */
export function orderLinkUrl(baseUrl: string, token: string): string | null {
  const base = baseUrl.trim().replace(/\/+$/, "");
  return /^https:\/\/[^\s/]+/.test(base) ? `${base}/pedir/${token}` : null;
}
