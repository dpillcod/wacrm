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

function normalize(text: string): string {
  return ` ${text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ')} `
}

/**
 * Picks the cross-sell aside for THIS turn, or `null` if none applies.
 *
 * At most one per conversation: if any earlier assistant message
 * already contains one of the rules' suggestion strings
 * verbatim, every rule is treated as already shown — a customer who
 * orders pan, then leche, then queso across three messages gets ONE
 * aside on the first, not three separate nudges.
 */
export function pickCrossSellSuggestion(
  customerMessage: string,
  priorMessages: { role: string; content: string }[],
  rules: CrossSellRule[],
): string | null {
  const alreadyShown = priorMessages.some(
    (m) =>
      m.role === 'assistant' &&
      rules.some((rule) => m.content.includes(rule.suggestion)),
  )
  if (alreadyShown) return null

  const normalized = normalize(customerMessage)
  for (const rule of rules) {
    if (normalized.includes(` ${rule.keyword} `)) {
      return rule.suggestion
    }
  }
  return null
}
