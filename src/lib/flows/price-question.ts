// ============================================================
// Detects "how much do I owe" style questions typed mid-order, so the
// flow engine can answer them honestly instead of two worse outcomes:
//
//   1. Silently appending the question as if it were another item
//      ("1 libra de queso\ncuanto le debo" landing in order_text).
//   2. At the payment-method step specifically, misrouting it —
//      "¿cuánto es para transferir?" contains "transferir", which
//      would satisfy route_payment_text's `contains "transf"` check
//      and wrongly lock in "Transferencia" as the chosen method
//      before the customer ever answered the question.
//
// Curated phrase list rather than a price/plan-aware LLM call, same
// reasoning as cross-sell.ts: this is the flow engine's deterministic
// path, not the AI chat, so a boring but reliable word list beats
// asking a model to classify intent on every keystroke.
// ============================================================

const PRICE_QUESTION_PHRASES = [
  'cuanto es',
  'cuanto le debo',
  'cuanto te debo',
  'cuanto debo',
  'cuanto seria',
  'cuanto vale',
  'cuanto sale',
  'cuanto cuesta',
  'cuanto cuestan',
  'cual es el total',
  'cuanto es el total',
  'el total es',
  'cuanto es para transferir',
  'cuanto tengo que pagar',
  'cuanto voy a pagar',
  'cuanto tengo que transferir',
  'me ayuda con la cuenta',
  'ayudeme con la cuenta',
  'ayudame con la cuenta',
  'me pasa la cuenta',
];

function normalize(text: string): string {
  return ` ${text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()} `;
}

/** True when the customer's message is asking for a price/total rather than naming an item or answering a question. */
export function isPriceQuestion(text: string): boolean {
  const normalized = normalize(text);
  return PRICE_QUESTION_PHRASES.some((phrase) => normalized.includes(` ${phrase} `));
}
