// ============================================================
// Order lines for products picked from the shop's catalog, and the
// estimated total of a list. Pure, unit-tested.
//
// A picked product's line carries its unit price and code, so the
// person in charge can pick it by barcode and the total can be worked
// out again after the customer edits the list:
//   "2 × ATUN VANCAMPS 140GR · $1,30 c/u (cód. 722008000218)"
// Typed lines ("1 libra de queso") have no price: they count as
// "por confirmar".
// ============================================================

export function money(n: number): string {
  return `$${n.toFixed(2).replace(".", ",")}`;
}

export interface PickedProduct {
  sku: string;
  title: string;
  price: number;
  salePrice: number | null;
}

export const MAX_QTY = 999;
export const MAX_LINES = 150;

/** Picked items (sku, quantity) → order lines, from the server's own prices. */
export function catalogOrderLines(
  items: { sku: string; qty: number }[],
  products: Map<string, PickedProduct>,
): { lines: string[]; total: number; missing: string[] } {
  const lines: string[] = [];
  const missing: string[] = [];
  let total = 0;
  const seen = new Set<string>();
  for (const it of items.slice(0, MAX_LINES)) {
    const qty = Math.floor(Number(it.qty));
    if (!it.sku || seen.has(it.sku) || !Number.isFinite(qty) || qty < 1) continue;
    seen.add(it.sku);
    const p = products.get(it.sku);
    if (!p) {
      missing.push(it.sku);
      continue;
    }
    const q = Math.min(qty, MAX_QTY);
    const unit = p.salePrice !== null && p.salePrice > 0 && p.salePrice < p.price ? p.salePrice : p.price;
    total += unit * q;
    lines.push(`${q} × ${p.title.replace(/\s+/g, " ").trim()} · ${money(unit)} c/u (cód. ${p.sku})`);
  }
  return { lines, total: Math.round(total * 100) / 100, missing };
}

const PRICED_LINE = /^(\d+(?:[.,]\d+)?)\s*[×x]\s.*·\s*\$(\d+(?:[.,]\d{1,2})?)\s*c\/u/i;

/** The estimated total of a list: priced (catalog) lines, and how many still need a price. */
export function listTotal(list: string): { total: number; priced: number; unpriced: number } {
  let total = 0;
  let priced = 0;
  let unpriced = 0;
  for (const raw of list.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(PRICED_LINE);
    if (m) {
      total += Number(m[1].replace(",", ".")) * Number(m[2].replace(",", "."));
      priced += 1;
    } else unpriced += 1;
  }
  return { total: Math.round(total * 100) / 100, priced, unpriced };
}

/** The line shown under the list ("💰 Total estimado…"), or "" when nothing has a price. */
export function totalLine(list: string): string {
  const t = listTotal(list);
  if (t.priced === 0) return "";
  const pending = t.unpriced ? ` + ${t.unpriced} producto${t.unpriced === 1 ? "" : "s"} por confirmar` : "";
  return `\n\n💰 *Total estimado: ${money(t.total)}*${pending}\n_Precios con IVA. El asesor confirma disponibilidad y envío._`;
}

const CATALOG_LINE = /^(\d+(?:[.,]\d+)?)\s*[×x]\s+(.+?)\s*·\s*(\$\d+(?:[.,]\d{1,2})?)\s*c\/u\s*\(cód\.\s*([^)]+)\)\s*$/i;

function plain(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * After the AI rewrites a list ("agregue 2 pilas", "que sean 3 atunes"),
 * put back the catalog lines it may have reworded: a line that names a
 * picked product (by its name or code) gets that product's price and
 * code again, with the line's new quantity. Lines it removed stay
 * removed; new typed lines stay as typed.
 */
export function keepCatalogLines(before: string[], after: string[]): string[] {
  const picked = before
    .map((l) => l.trim().match(CATALOG_LINE))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => ({ qty: m[1], title: m[2].trim(), price: m[3], code: m[4].trim(), key: plain(m[2]) }));
  if (!picked.length) return after;
  const used = new Set<number>();
  return after.map((raw) => {
    const line = raw.trim();
    if (CATALOG_LINE.test(line)) return line;
    const p = plain(line);
    const i = picked.findIndex(
      (x, n) => !used.has(n) && x.key.length > 2 && (` ${p} `.includes(` ${x.key} `) || (x.code.length >= 4 && ` ${p} `.includes(` ${plain(x.code)} `))),
    );
    if (i < 0) return line;
    used.add(i);
    const x = picked[i];
    const qty = line.match(/^(\d+(?:[.,]\d+)?)\b/)?.[1] ?? x.qty;
    return `${qty} × ${x.title} · ${x.price} c/u (cód. ${x.code})`;
  });
}
