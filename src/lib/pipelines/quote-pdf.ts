// The quote's PDF (server only: pdf-lib stays out of the browser bundle).
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { lineTotal, localDate, quoteMoney, quoteTotals, type Quote, type QuoteSeller } from "./quote";

// The PDF's standard fonts only cover Windows-1252: keep accents and
// "ñ", drop emoji and anything else they can't draw.
const WIN_ANSI_EXTRA = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ");
export function pdfSafe(text: string): string {
  return Array.from(String(text ?? "").normalize("NFC"))
    .filter((ch) => {
      const c = ch.codePointAt(0) ?? 0;
      return (c >= 32 && c <= 126) || (c >= 160 && c <= 255) || WIN_ANSI_EXTRA.has(ch);
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const words = pdfSafe(text).split(" ").filter(Boolean);
  const out: string[] = [];
  let line = "";
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (font.widthOfTextAtSize(next, size) <= width) {
      line = next;
      continue;
    }
    if (line) out.push(line);
    // A single word wider than the column: cut it.
    let rest = w;
    while (font.widthOfTextAtSize(rest, size) > width && rest.length > 1) {
      let cut = rest.length - 1;
      while (cut > 1 && font.widthOfTextAtSize(rest.slice(0, cut), size) > width) cut--;
      out.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    line = rest;
  }
  if (line) out.push(line);
  return out.length ? out : [""];
}

/** The quote as a one-or-more page A4 PDF. */
export async function buildQuotePdf(quote: Quote, seller: QuoteSeller): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(pdfSafe(`Cotización ${quote.number} - ${seller.name}`));
  pdf.setAuthor(pdfSafe(seller.name));
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.1, 0.1, 0.12);
  const muted = rgb(0.42, 0.42, 0.46);
  const line = rgb(0.85, 0.85, 0.88);
  const band = rgb(0.95, 0.95, 0.96);

  const W = 595.28;
  const H = 841.89;
  const M = 42;
  let page: PDFPage = pdf.addPage([W, H]);
  let y = H - M;

  const text = (s: string, x: number, yy: number, size = 9, f: PDFFont = font, color = ink) =>
    page.drawText(pdfSafe(s), { x, y: yy, size, font: f, color });
  const right = (s: string, xRight: number, yy: number, size = 9, f: PDFFont = font, color = ink) => {
    const safe = pdfSafe(s);
    page.drawText(safe, { x: xRight - f.widthOfTextAtSize(safe, size), y: yy, size, font: f, color });
  };

  // Header: the store on the left, the quote's number and dates on the right.
  text(seller.name || "Cotización", M, y - 16, 18, bold);
  let left = y - 32;
  for (const s of [
    seller.legalName,
    seller.taxId ? `RUC: ${seller.taxId}` : "",
    seller.address,
    [seller.phone, seller.email].filter(Boolean).join(" · "),
    seller.website,
  ].filter(Boolean)) {
    text(s, M, left, 8.5, font, muted);
    left -= 11.5;
  }
  right("COTIZACIÓN", W - M, y - 16, 16, bold);
  right(`N° ${quote.number}`, W - M, y - 32, 10, bold);
  right(`Fecha: ${localDate(quote.createdAt, seller.utcOffsetHours)}`, W - M, y - 45, 8.5, font, muted);
  right(
    `Válida hasta: ${localDate(quote.createdAt, seller.utcOffsetHours, quote.validDays)}`,
    W - M,
    y - 57,
    8.5,
    font,
    muted,
  );
  y = Math.min(left, y - 66) - 10;

  // Customer box.
  const boxH = 44;
  page.drawRectangle({ x: M, y: y - boxH, width: W - 2 * M, height: boxH, color: band });
  text("CLIENTE", M + 10, y - 14, 7.5, bold, muted);
  text(quote.customerName || "Consumidor final", M + 10, y - 28, 10, bold);
  const idAndPhone = [quote.customerId ? `Cédula/RUC: ${quote.customerId}` : "", quote.customerPhone ? `Tel.: ${quote.customerPhone}` : ""]
    .filter(Boolean)
    .join("   ·   ");
  if (idAndPhone) text(idAndPhone, M + 10, y - 39, 8.5, font, muted);
  y -= boxH + 18;

  // Table.
  const cQty = M;
  const cDesc = M + 48;
  const cUnitR = W - M - 80;
  const cTotalR = W - M;
  const descW = cUnitR - 70 - cDesc;
  const header = () => {
    page.drawRectangle({ x: M, y: y - 18, width: W - 2 * M, height: 18, color: ink });
    const white = rgb(1, 1, 1);
    text("CANT.", cQty + 6, y - 12.5, 8, bold, white);
    text("DESCRIPCIÓN", cDesc, y - 12.5, 8, bold, white);
    right("P. UNIT.", cUnitR, y - 12.5, 8, bold, white);
    right("TOTAL", cTotalR - 6, y - 12.5, 8, bold, white);
    y -= 18;
  };
  header();
  const qtyText = (n: number) => (Number.isInteger(n) ? String(n) : String(n).replace(".", ","));
  for (const item of quote.items) {
    const rows = wrap(item.description, font, 9, descW);
    const rowH = 8 + rows.length * 11.5;
    if (y - rowH < M + 140) {
      page = pdf.addPage([W, H]);
      y = H - M;
      header();
    }
    rows.forEach((r, i) => text(r, cDesc, y - 13 - i * 11.5, 9));
    text(qtyText(item.qty), cQty + 6, y - 13, 9);
    right(item.unitPrice ? quoteMoney(item.unitPrice) : "—", cUnitR, y - 13, 9);
    right(item.unitPrice ? quoteMoney(lineTotal(item)) : "—", cTotalR - 6, y - 13, 9, bold);
    y -= rowH;
    page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.6, color: line });
  }

  // Totals.
  const t = quoteTotals(quote);
  y -= 16;
  if (t.delivery > 0) {
    right("Productos", cUnitR, y, 9, font, muted);
    right(quoteMoney(t.items), cTotalR - 6, y, 9);
    y -= 14;
    right("Envío", cUnitR, y, 9, font, muted);
    right(quoteMoney(t.delivery), cTotalR - 6, y, 9);
    y -= 24;
  }
  page.drawRectangle({ x: cUnitR - 90, y: y - 8, width: cTotalR - cUnitR + 90, height: 24, color: band });
  right("TOTAL", cUnitR, y, 11, bold);
  right(quoteMoney(t.total), cTotalR - 6, y, 12, bold);
  y -= 30;

  if (quote.notes.trim()) {
    text("OBSERVACIONES", M, y, 7.5, bold, muted);
    y -= 12;
    for (const r of wrap(quote.notes, font, 9, W - 2 * M)) {
      if (y < M + 40) {
        page = pdf.addPage([W, H]);
        y = H - M;
      }
      text(r, M, y, 9);
      y -= 11.5;
    }
  }

  // Footer on every page.
  const pages = pdf.getPages();
  pages.forEach((p, i) => {
    page = p;
    const foot = wrap(seller.footer, font, 7.5, W - 2 * M - 40);
    foot.forEach((r, j) => text(r, M, M - 6 + (foot.length - 1 - j) * 9.5, 7.5, font, muted));
    if (pages.length > 1) right(`${i + 1}/${pages.length}`, W - M, M - 6, 7.5, font, muted);
  });

  return pdf.save();
}
