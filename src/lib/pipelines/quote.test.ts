import { describe, expect, it } from "vitest";
import {
  parseQuoteReplyId,
  quoteDraftFromNotes,
  quoteItemFromLine,
  quoteMoney,
  quoteNumber,
  quoteReplyIds,
  quoteTotals,
  sanitizeQuoteItems,
  localDate,
} from "./quote";
import { buildQuotePdf, pdfSafe } from "./quote-pdf";

describe("quotes from an order card", () => {
  it("formats money the Ecuadorian way", () => {
    expect(quoteMoney(2160)).toBe("$2.160,00");
    expect(quoteMoney(1.3)).toBe("$1,30");
    expect(quoteMoney(1234567.891)).toBe("$1.234.567,89");
  });

  it("numbers the quote after the order", () => {
    expect(quoteNumber("Pedido N° 0037 — Sharon", "abc")).toBe("C-0037");
    expect(quoteNumber("Encargo N° S-0004 — Ana", "abc")).toBe("C-0004");
    expect(quoteNumber("Cotización baldes", "1f6f57e7-43e0")).toBe("C-1F6F57");
  });

  it("reads the card's list and invoice data", () => {
    const notes = [
      "Pedido N° 0037",
      "Lista del cliente:",
      "1. 200 sacos de cemento Holcim",
      "2. 2 × ATUN VANCAMPS 140GR · $1,30 c/u (cód. 722008000218)",
      "3. 3500 gramos de carne molida",
      "🧾 Factura: Sharon Quituisaca · 0100000009",
      "💲 SOLO COTIZACIÓN: el cliente quiere precios antes de decidir",
    ].join("\n");
    const d = quoteDraftFromNotes(notes);
    expect(d.items).toEqual([
      { qty: 200, description: "sacos de cemento Holcim", unitPrice: 0 },
      { qty: 2, description: "ATUN VANCAMPS 140GR (cód. 722008000218)", unitPrice: 1.3 },
      { qty: 1, description: "3500 gramos de carne molida", unitPrice: 0 },
    ]);
    expect(d.customerName).toBe("Sharon Quituisaca");
    expect(d.customerId).toBe("0100000009");
    expect(quoteDraftFromNotes("🧾 Factura: Consumidor final").customerName).toBe("");
  });

  it("keeps a line without a number whole", () => {
    expect(quoteItemFromLine("balde de 5 galones blanco")).toEqual({ qty: 1, description: "balde de 5 galones blanco", unitPrice: 0 });
  });

  it("adds up rows and delivery", () => {
    const t = quoteTotals({ items: [{ qty: 200, description: "cemento", unitPrice: 10.8 }, { qty: 3, description: "x", unitPrice: 0.333 }], delivery: 25 });
    expect(t).toEqual({ items: 2161, delivery: 25, total: 2186 });
  });

  it("cleans what a person typed", () => {
    expect(sanitizeQuoteItems([{ qty: "2", description: " clavos ", unitPrice: "0.5" }, { qty: 0, description: "x" }, { description: "" }, "bad"])).toEqual([
      { qty: 2, description: "clavos", unitPrice: 0.5 },
    ]);
    expect(sanitizeQuoteItems(null)).toEqual([]);
  });

  it("round-trips the button ids", () => {
    const ids = quoteReplyIds("d1");
    expect(parseQuoteReplyId(ids.ok)).toEqual({ accepted: true, dealId: "d1" });
    expect(parseQuoteReplyId(ids.change)).toEqual({ accepted: false, dealId: "d1" });
    expect(parseQuoteReplyId("csat_bien:d1")).toBeNull();
  });

  it("dates in the store's time zone", () => {
    expect(localDate("2026-11-17T03:00:00Z", -5)).toBe("16/11/2026");
    expect(localDate("2026-11-17T03:00:00Z", -5, 3)).toBe("19/11/2026");
  });

  it("draws a PDF without choking on emoji", async () => {
    expect(pdfSafe("Cemento 🧱 Holcim — año ñ")).toBe("Cemento Holcim — año ñ");
    const bytes = await buildQuotePdf(
      {
        number: "C-0037",
        items: Array.from({ length: 60 }, (_, i) => ({ qty: i + 1, description: `Producto ${i} con un nombre bastante largo para que ocupe dos líneas en la tabla 🧱`, unitPrice: 1.25 })),
        delivery: 5,
        validDays: 3,
        notes: "Entrega en 2 días",
        customerName: "Sharon Quituisaca",
        customerId: "0100000009",
        customerPhone: "0990000831",
        createdAt: "2026-11-17T15:00:00Z",
      },
      { name: "Ferrotienda", legalName: "Rosa", taxId: "0102249976001", address: "Cuenca", phone: "098", email: "a@b.c", website: "ferrotiendaec.com", footer: "Precios incluyen IVA.", utcOffsetHours: -5 },
    );
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
    expect(bytes.length).toBeGreaterThan(2000);
  });
});
