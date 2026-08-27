// ============================================================
// Subtle, curated cross-sell nudges for the auto-reply assistant.
//
// Deliberately NOT left to the model to invent: an LLM asked to
// "suggest something complementary" will happily pair items the
// business doesn't stock, or vary its pick turn to turn for the same
// request. A short business-authored list is boring but trustworthy —
// exactly the property that matters here, since a bad suggestion reads
// as the business not knowing its own inventory.
//
// Fires at most ONCE per conversation (see `pickCrossSellSuggestion`)
// and is appended to the reply as a separate, casual aside — never
// framed as an ask, per the "disimulado, no directo" brief (nobody
// likes being pushed to buy more).
// ============================================================

export interface CrossSellRule {
  /** Trigger word, matched case-insensitively as a whole word against
   *  the customer's latest message. Plain Spanish, no stemming — add
   *  both singular/plural or accented/unaccented variants as separate
   *  rules rather than trying to be clever about matching. */
  keyword: string
  /** The aside appended to the reply the first time this rule fires.
   *  Written to sound like an offhand tip, not a pitch. */
  suggestion: string
}

/**
 * Curated pairings, grouped as the business owner described them:
 *   - pan / leche / queso / café (desayuno)
 *   - licor / hielo / snacks (reunión)
 *   - carnes / arroz / aceite / hierbas aromáticas (comida)
 *   - cerveza / snacks / colas
 *   - detergente / suavizante / cloro / trapeador (limpieza)
 *
 * Each keyword suggests OTHER items from its own group, never itself —
 * "pide pan → sugiere queso/café", "pide queso → sugiere pan/café".
 * Order matters when a message could match more than one rule: the
 * first match in this list wins, so more specific/earlier entries take
 * priority over a later incidental match.
 */
export const CROSS_SELL_RULES: CrossSellRule[] = [
  // --- Pan / lácteos / café ---
  { keyword: 'pan', suggestion: 'Por cierto, si quieres te agrego queso fresco o café, recién nos llegó 🙂' },
  { keyword: 'panes', suggestion: 'Por cierto, si quieres te agrego queso fresco o café, recién nos llegó 🙂' },
  { keyword: 'leche', suggestion: 'Por cierto, ¿te provoca pan fresco o café para acompañar? 🙂' },
  { keyword: 'queso', suggestion: 'Por cierto, tenemos pan recién horneado que combina bien, ¿te agrego? 🙂' },
  { keyword: 'quesos', suggestion: 'Por cierto, tenemos pan recién horneado que combina bien, ¿te agrego? 🙂' },
  { keyword: 'café', suggestion: 'Por cierto, tenemos pan recién horneado, ideal para acompañar el café 🙂' },
  { keyword: 'cafe', suggestion: 'Por cierto, tenemos pan recién horneado, ideal para acompañar el café 🙂' },

  // --- Licor / hielo / snacks de reunión ---
  { keyword: 'licor', suggestion: 'Por cierto, ¿te hace falta hielo o algún snack para acompañar? 🙂' },
  { keyword: 'hielo', suggestion: 'Por cierto, si es para una reunión, tenemos snacks y salsa de queso que combinan bien 🙂' },
  { keyword: 'hielos', suggestion: 'Por cierto, si es para una reunión, tenemos snacks y salsa de queso que combinan bien 🙂' },

  // --- Carnes / arroz / aceite / hierbas aromáticas ---
  { keyword: 'pollo', suggestion: 'Por cierto, ¿te agrego arroz, aceite o culantro/perejil para la sazón? 🙂' },
  { keyword: 'res', suggestion: 'Por cierto, ¿te agrego arroz, aceite o culantro/perejil para la sazón? 🙂' },
  { keyword: 'carne', suggestion: 'Por cierto, ¿te agrego arroz, aceite o culantro/perejil para la sazón? 🙂' },
  { keyword: 'chancho', suggestion: 'Por cierto, ¿te agrego arroz, aceite o culantro/perejil para la sazón? 🙂' },
  { keyword: 'cerdo', suggestion: 'Por cierto, ¿te agrego arroz, aceite o culantro/perejil para la sazón? 🙂' },
  { keyword: 'arroz', suggestion: 'Por cierto, ¿buscas también algo de carne o aceite para acompañar? 🙂' },
  { keyword: 'aceite', suggestion: 'Por cierto, ¿te hace falta arroz o algo de carne para la comida? 🙂' },

  // --- Cerveza / snacks / colas ---
  { keyword: 'cerveza', suggestion: 'Por cierto, ¿te agrego unos snacks o colas para acompañar? 🙂' },
  { keyword: 'cervezas', suggestion: 'Por cierto, ¿te agrego unos snacks o colas para acompañar? 🙂' },

  // --- Limpieza ---
  { keyword: 'detergente', suggestion: 'Por cierto, ¿te hace falta suavizante o cloro para completar la limpieza? 🙂' },
  { keyword: 'detergentes', suggestion: 'Por cierto, ¿te hace falta suavizante o cloro para completar la limpieza? 🙂' },
  { keyword: 'suavizante', suggestion: 'Por cierto, ¿te hace falta detergente para completar la limpieza? 🙂' },
  { keyword: 'cloro', suggestion: 'Por cierto, ¿te hace falta detergente o suavizante también? 🙂' },
  { keyword: 'trapeador', suggestion: 'Por cierto, ¿te hace falta detergente para la limpieza general? 🙂' },
  { keyword: 'trapeadores', suggestion: 'Por cierto, ¿te hace falta detergente para la limpieza general? 🙂' },
]

function normalize(text: string): string {
  return ` ${text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ')} `
}

/**
 * Picks the cross-sell aside for THIS turn, or `null` if none applies.
 *
 * At most one per conversation: if any earlier assistant message
 * already contains one of `CROSS_SELL_RULES`' suggestion strings
 * verbatim, every rule is treated as already shown — a customer who
 * orders pan, then leche, then queso across three messages gets ONE
 * aside on the first, not three separate nudges.
 */
export function pickCrossSellSuggestion(
  customerMessage: string,
  priorMessages: { role: string; content: string }[],
): string | null {
  const alreadyShown = priorMessages.some(
    (m) =>
      m.role === 'assistant' &&
      CROSS_SELL_RULES.some((rule) => m.content.includes(rule.suggestion)),
  )
  if (alreadyShown) return null

  const normalized = normalize(customerMessage)
  for (const rule of CROSS_SELL_RULES) {
    if (normalized.includes(` ${rule.keyword} `)) {
      return rule.suggestion
    }
  }
  return null
}
