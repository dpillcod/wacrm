// ============================================================
// Formal quotes ("cotización") made by staff from an order card.
//
// The bot never gives prices (owner's decision, Nov 2026): a person
// writes the prices on the card, and the CRM turns them into a PDF
// with the store's details, sends it in the chat with
// [✅ Acepto] [✏️ Cambiar algo], and keeps it on the card (deals.quote,
// migration 054). Big orders like "200 sacos de cemento" get a real
// document instead of a price typed in a chat bubble.
//
// This file is pure (parsing, totals) and unit-tested; the PDF itself
// is drawn in quote-pdf.ts (server only).
// ============================================================

export interface QuoteItem {
  qty: number;
  description: string;
  /** Price per unit, taxes included. */
  unitPrice: number;
}

export type QuoteStatus = "draft" | "sent" | "accepted" | "change_requested";

export interface Quote {
  number: string;
  items: QuoteItem[];
  /** Delivery cost (0 = none / not quoted). */
  delivery: number;
  validDays: number;
  notes: string;
  customerName: string;
  customerId: string;
  customerPhone: string;
  /** ISO: when it was last saved (the date printed on the PDF). */
  createdAt: string;
  sentAt?: string | null;
  status?: QuoteStatus;
}

export interface QuoteSeller {
  name: string;
  legalName: string;
  taxId: string;
  address: string;
  phone: string;
  email: string;
  website: string;
  footer: string;
  utcOffsetHours: number;
}

export const QUOTE_OK_PREFIX = "quote_ok:";
export const QUOTE_CHANGE_PREFIX = "quote_change:";
export const MAX_QUOTE_ITEMS = 200;

export function quoteReplyIds(dealId: string): { ok: string; change: string } {
  return { ok: `${QUOTE_OK_PREFIX}${dealId}`, change: `${QUOTE_CHANGE_PREFIX}${dealId}` };
}

export function parseQuoteReplyId(replyId: string): { accepted: boolean; dealId: string } | null {
  if (replyId.startsWith(QUOTE_OK_PREFIX)) return { accepted: true, dealId: replyId.slice(QUOTE_OK_PREFIX.length) };
  if (replyId.startsWith(QUOTE_CHANGE_PREFIX)) return { accepted: false, dealId: replyId.slice(QUOTE_CHANGE_PREFIX.length) };
  return null;
}

/** "$2.160,00" — thousands with a dot, cents with a comma (Ecuador). */
export function quoteMoney(n: number): string {
  const [int, cents] = (Math.round(n * 100) / 100).toFixed(2).split(".");
  return `$${int.replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${cents}`;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function lineTotal(item: QuoteItem): number {
  return round2(item.qty * item.unitPrice);
}

export function quoteTotals(q: Pick<Quote, "items" | "delivery">): { items: number; delivery: number; total: number } {
  const items = round2(q.items.reduce((sum, i) => sum + lineTotal(i), 0));
  const delivery = round2(Math.max(0, q.delivery || 0));
  return { items, delivery, total: round2(items + delivery) };
}

/** "Pedido N° 0037 — Sharon" → "C-0037"; otherwise from the card id. */
export function quoteNumber(dealTitle: string, dealId: string): string {
  const m = dealTitle.match(/N[°º]\s*([A-Z]-)?(\d+)/i);
  return m ? `C-${m[2]}` : `C-${dealId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

// Small units: "3500 gramos de carne" is one line of 3500 g, not 3500 items.
const SMALL_UNIT = /^(g|gr|grs|gramos?|ml|cc|cm|mm|onzas?|oz)\b/i;

/** One order line from the card → a quote row (price still empty unless the catalog gave one). */
export function quoteItemFromLine(line: string): QuoteItem {
  const text = line.replace(/\s+/g, " ").trim();
  // Catalog line: "2 × ATUN VANCAMPS 140GR · $1,30 c/u (cód. 722008000218)"
  const picked = text.match(/^(\d+)\s*[×x]\s*(.+?)\s*·\s*\$\s*([\d.,]+)\s*c\/u(?:\s*\((?:cód\.|cod\.)\s*([^)]+)\))?/i);
  if (picked) {
    const price = Number(picked[3].replace(/\./g, "").replace(",", ".")) || 0;
    const code = picked[4] ? ` (cód. ${picked[4].trim()})` : "";
    return { qty: Number(picked[1]) || 1, description: `${picked[2].trim()}${code}`, unitPrice: price };
  }
  const m = text.match(/^(\d+)\s+(.+)$/);
  if (m && !SMALL_UNIT.test(m[2])) {
    return { qty: Math.max(1, Number(m[1]) || 1), description: m[2].trim(), unitPrice: 0 };
  }
  return { qty: 1, description: text, unitPrice: 0 };
}

/**
 * The order card's notes → the list's rows and the invoice data:
 *   Lista del cliente:
 *   1. 200 sacos de cemento Holcim
 *   🧾 Factura: Sharon Quituisaca · 0100000009
 */
export function quoteDraftFromNotes(notes: string | null | undefined): {
  items: QuoteItem[];
  customerName: string;
  customerId: string;
} {
  const lines = String(notes ?? "").split(/\r?\n/);
  const items: QuoteItem[] = [];
  let inList = false;
  let customerName = "";
  let customerId = "";
  for (const raw of lines) {
    const line = raw.trim();
    const invoice = line.match(/^🧾\s*Factura:\s*(.+)$/u);
    if (invoice) {
      const parts = invoice[1].split("·").map((p) => p.trim());
      if (!/consumidor final/i.test(parts[0] ?? "")) {
        customerName = parts[0] ?? "";
        customerId = (parts[1] ?? "").replace(/[^\dA-Z]/gi, "");
      }
      continue;
    }
    if (/^lista del cliente:?$/i.test(line)) {
      inList = true;
      continue;
    }
    const numbered = line.match(/^\d+[.)]\s+(.+)$/);
    if (numbered && (inList || items.length === 0)) {
      items.push(quoteItemFromLine(numbered[1]));
      inList = true;
      continue;
    }
    if (inList && line) inList = false;
  }
  return { items: items.slice(0, MAX_QUOTE_ITEMS), customerName, customerId };
}

/** Quote rows a person typed, cleaned (empty rows out, numbers in range). */
export function sanitizeQuoteItems(raw: unknown): QuoteItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((r) => {
      const o = (r ?? {}) as Record<string, unknown>;
      const qty = Number(o.qty);
      const unitPrice = Number(o.unitPrice);
      return {
        qty: Number.isFinite(qty) ? Math.max(0, Math.min(100000, Math.round(qty * 1000) / 1000)) : 0,
        description: String(o.description ?? "").replace(/\s+/g, " ").trim().slice(0, 200),
        unitPrice: Number.isFinite(unitPrice) ? Math.max(0, Math.min(1_000_000, round2(unitPrice))) : 0,
      };
    })
    .filter((i) => i.description && i.qty > 0)
    .slice(0, MAX_QUOTE_ITEMS);
}

/** "dd/mm/aaaa" in the store's time zone. */
export function localDate(iso: string, utcOffsetHours: number, plusDays = 0): string {
  const d = new Date(new Date(iso).getTime() + utcOffsetHours * 3_600_000 + plusDays * 86_400_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
}
