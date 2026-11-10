/**
 * A few real models for a product the customer has to choose among (a
 * lock, a faucet, a bulb): shown with the "Anotado" so the customer sees
 * what the store has, without prices — an advisor helps choose and
 * quotes. Asking question after question tired customers out; showing
 * options and letting the advisor take it from there doesn't.
 *
 * Only products in stock (web in stock, ERP stock not zero), best sellers
 * first. Best-effort: any failure is just no options.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { searchShop } from "../catalog/shop-search";

const PER_PRODUCT = 3;
const MAX_PRODUCTS = 2;

// What customers say → how the store's system names it.
const STORE_WORDS: Record<string, string> = {
  chapa: "cerradura",
  chapas: "cerradura",
  grifo: "llave",
  bombillo: "foco",
  bombilla: "foco",
  enchufe: "tomacorriente",
};

/** Up to three product names for these search words, dropping the last word until something matches. */
export async function modelNames(db: SupabaseClient, accountId: string, search: string): Promise<string[]> {
  const words = search
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3)
    .map((w) => STORE_WORDS[w] ?? w);
  const head = words[0];
  while (words.length > 0) {
    const { items } = await searchShop(db, accountId, { q: words.join(" ") });
    if (items.length > 0) {
      // "foco led" also finds a LED strip in the "Focos" section: names
      // that start with the product come first.
      const names = items.map((i) => tidyName(i.title));
      const starts = names.filter((n) => n.toLowerCase().startsWith(head));
      return [...new Set([...starts, ...names])].slice(0, PER_PRODUCT);
    }
    // One word left and nothing: that word isn't how the store names it.
    if (words.length === 1) break;
    words.pop();
  }
  return [];
}

/** "cerradura dormitorio negra" → "cerradura": what was already shown. */
export function productKey(search: string): string {
  const first = search.toLowerCase().split(/\s+/).filter(Boolean)[0] ?? "";
  return STORE_WORDS[first] ?? first;
}

/** "CERRADURA NOVA DORMITORIO AB 567-A/B-ET" stays readable; only stray pipes and spaces go. */
export function tidyName(title: string): string {
  return title.replace(/\s*\|\s*/g, " ").replace(/\s+/g, " ").trim().slice(0, 70);
}

/**
 * The "🔎 Algunos modelos…" note for the lines just written down ("" when
 * none has a choice to make, nothing was found, or its models were
 * already shown), and the searches it used — to not show them twice.
 */
export async function modelOptionsNote(
  db: SupabaseClient,
  accountId: string,
  lines: string[],
  searches: string[],
  alreadyShown: string[] = [],
): Promise<{ note: string; shown: string[] }> {
  // Once per kind of product: "pintura latex negra" after "pintura latex"
  // would only repeat the same three names.
  const wanted = lines
    .map((line, i) => ({ line, search: (searches[i] ?? "").trim().toLowerCase() }))
    .filter((x) => x.search && !alreadyShown.includes(productKey(x.search)))
    .slice(0, MAX_PRODUCTS);
  if (wanted.length === 0) return { note: "", shown: [] };
  try {
    const found = await Promise.all(wanted.map((x) => modelNames(db, accountId, x.search)));
    const blocks = wanted
      .map((x, i) => ({ line: x.line, search: x.search, names: found[i] }))
      .filter((x) => x.names.length > 0);
    if (blocks.length === 0) return { note: "", shown: [] };
    const body =
      blocks.length === 1
        ? blocks[0].names.map((n) => `• ${n}`).join("\n")
        : blocks.map((b) => `*${productOf(b.line)}:* ${b.names.join(" · ")}`).join("\n");
    return {
      note: `\n\n🔎 Algunos modelos que tenemos:\n${body}\nUn asesor le ayuda a elegir y le confirma el precio 🙂`,
      shown: blocks.map((b) => productKey(b.search)),
    };
  } catch (err) {
    console.error("[flows] model options failed:", err);
    return { note: "", shown: [] };
  }
}

/** "2 llaves de lavabo cromadas" → "Llaves de lavabo cromadas" (the label above its models). */
function productOf(line: string): string {
  const name = line.replace(/^\s*\d+([.,]\d+)?\s*/, "").replace(/\s*\(.*?\)\s*/g, " ").trim();
  return name.charAt(0).toUpperCase() + name.slice(1);
}
