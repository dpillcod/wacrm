// ============================================================
// The web shop's product feed (the CSV that also feeds the WhatsApp
// catalog) turned into shop_products rows. Pure: no I/O, unit-tested.
// ============================================================

/** Lower-case, accent-free, single-spaced — how products are searched. */
export function normalizeSearch(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9ñ.,/\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The words a customer typed, ready for the search (no LIKE wildcards). */
export function searchWords(query: string): string[] {
  return normalizeSearch(query)
    .replace(/[%_\\]/g, " ")
    .split(" ")
    .map((w) => w.replace(/^[.,/-]+|[.,/-]+$/g, ""))
    .filter((w) => w.length > 0)
    .slice(0, 8);
}

/**
 * RFC 4180 CSV → rows of fields. Handles quoted fields with commas,
 * doubled quotes and line breaks; tolerates a trailing newline and \r\n.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field);
      field = "";
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);
  return rows;
}

export interface ShopProductRow {
  sku: string;
  title: string;
  price: number;
  sale_price: number | null;
  image_url: string | null;
  link: string | null;
  department: string | null;
  category: string | null;
  in_stock: boolean;
  search_text: string;
}

/** "1.25 USD" → 1.25; null for anything else. */
export function parsePrice(value: string | undefined): number | null {
  const m = (value ?? "").trim().match(/^(\d+(?:\.\d+)?)(?:\s*[A-Z]{3})?$/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

/**
 * Feed rows (with the header as the first row) → products. Rows without
 * an id, a title or a positive price are skipped; a repeated id keeps
 * the first. Department / category come from custom_label_0
 * ("Ferreteria / Pinturas"), falling back to brand.
 */
export function feedToProducts(rows: string[][]): ShopProductRow[] {
  if (rows.length < 2) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const idx = {
    id: col("id"),
    title: col("title"),
    price: col("price"),
    sale: col("sale_price"),
    image: col("image_link"),
    link: col("link"),
    availability: col("availability"),
    brand: col("brand"),
    label: col("custom_label_0"),
  };
  if (idx.id < 0 || idx.title < 0 || idx.price < 0) return [];
  const seen = new Set<string>();
  const out: ShopProductRow[] = [];
  for (const r of rows.slice(1)) {
    const sku = (r[idx.id] ?? "").trim();
    const title = (r[idx.title] ?? "").replace(/\s+/g, " ").trim();
    const price = parsePrice(r[idx.price]);
    if (!sku || !title || price === null || price <= 0 || seen.has(sku)) continue;
    seen.add(sku);
    const label = idx.label >= 0 ? (r[idx.label] ?? "").trim() : "";
    const [dep, ...rest] = label.split(" / ");
    const department = (dep || (idx.brand >= 0 ? r[idx.brand] : "") || "").trim() || null;
    const category = rest.join(" / ").trim() || null;
    const sale = idx.sale >= 0 ? parsePrice(r[idx.sale]) : null;
    const image = idx.image >= 0 ? (r[idx.image] ?? "").trim() : "";
    const link = idx.link >= 0 ? (r[idx.link] ?? "").trim() : "";
    out.push({
      sku,
      title,
      price,
      sale_price: sale !== null && sale > 0 && sale < price ? sale : null,
      image_url: /^https:\/\//.test(image) ? image : null,
      link: /^https:\/\//.test(link) ? link : null,
      department,
      category,
      in_stock: idx.availability < 0 || (r[idx.availability] ?? "").trim() !== "out of stock",
      search_text: normalizeSearch([title, sku, department ?? "", category ?? ""].join(" ")),
    });
  }
  return out;
}

/**
 * A WordPress photo's 300×300 thumbnail ("…/7861.jpg" → "…/7861-300x300.jpg"),
 * which WordPress makes for every product photo — a few KB instead of a
 * full-size image. The page falls back to the original if it's missing.
 */
export function thumbnailUrl(url: string | null, size = 300): string | null {
  if (!url) return null;
  if (!/\/wp-content\/uploads\//.test(url)) return url;
  return url.replace(/(-\d+x\d+)?\.(jpe?g|png|webp)(\?.*)?$/i, `-${size}x${size}.$2`);
}
