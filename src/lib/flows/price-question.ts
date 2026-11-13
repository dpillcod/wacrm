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
  // Services and bakery orders: "¿cuánto me cobran?"
  'cuanto cobran',
  'cuanto me cobran',
  'cuanto cobra',
  'cuanto me cobra',
  'cuanto me sale',
  'cuanto costaria',
  'que precio tiene',
  'que precio tienen',
  'cual es el precio',
  'cual es el costo',
  'cual seria el costo',
  'cuanto valdria',
  // "¿Me da el total?" after the order went to staff.
  'darme el total',
  'me da el total',
  'me pasa el total',
  'me pasan el total',
  'el total a',
  'total a cancelar',
  'total a pagar',
  'valor a pagar',
  'valor a cancelar',
  'valor total',
  'precio total',
  'cuanto es todo',
  'cuanto seria todo',
  'cuanto sale todo',
  'cuanto le debo',
  'cuanto toca pagar',
  // "¿Cuál es el valor?", "quiero saber precio", "mándeme precio y modelos".
  'cual es el valor',
  'cual seria el valor',
  'que valor tiene',
  'que valor tienen',
  // "Las 100 unidades, ¿qué valor tendrían?" (Nov 12)
  'que valor tendria',
  'que valor tendrian',
  'que valor seria',
  'que valor serian',
  'saber precio',
  'saber el precio',
  'saber precios',
  'saber los precios',
  'mandeme precio',
  'mandeme el precio',
  'mandeme precios',
  'mandeme los precios',
  'me manda precio',
  'me manda el precio',
  'me pasa precio',
  'me pasa el precio',
  'me envia el precio',
  'en cuanto esta',
  'en cuanto sale',
  'a como esta',
  'a como estan',
  'y los precios',
  'los precios por favor',
  'precios por favor',
  'el precio por favor',
  'y el precio',
  // "No, ¿qué costo tiene?" (Nov 10).
  'que costo tiene',
  'que costo tienen',
  'que costo',
  'y el costo',
  'el costo por favor',
  'cual es su costo',
  'cual es su precio',
  'cuanto esta',
  'cuanto estan',
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
