// ============================================================
// Detects general "about the business" questions typed mid-order
// (schedule, location, what the business sells in general), so the
// flow engine can answer them instead of silently appending the
// question to the running order as if it were another item — e.g.
// "cual son sus horarios de atencion" landing in order_text next to
// "1 libra de queso".
//
// Same reasoning as price-question.ts: a curated phrase list, not an
// LLM call — this is the flow engine's deterministic path, not the AI
// chat, so a boring but reliable word list beats asking a model to
// classify intent on every keystroke.
// ============================================================

const GENERAL_QUESTION_PHRASES = [
  // Schedule
  'horario de atencion',
  'horarios de atencion',
  'cual es su horario',
  'cual es el horario',
  'cuales son sus horarios',
  'cuales son los horarios',
  'que horario tienen',
  'que horarios tienen',
  'a que hora abren',
  'a que hora abre',
  'a que hora cierran',
  'a que hora cierra',
  'hasta que hora atienden',
  'hasta que hora abren',
  'que dias atienden',
  'atienden los domingos',
  'abren los domingos',
  'estan abiertos',
  'estan abiertos hoy',
  // Location
  'donde estan ubicados',
  'donde estan ubicado',
  'cual es su direccion',
  'cual es la direccion',
  'donde quedan',
  'donde queda la tienda',
  'donde estan',
  // General product / department range
  'que productos tienen',
  'que productos manejan',
  'que productos venden',
  'que venden',
  'que es lo que venden',
  'que areas manejan',
  'que tipo de productos',
  'que marcas manejan',
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

/** True when the customer's message is asking about the business itself (hours, location, general range of products) rather than naming an order item or answering a question. */
export function isGeneralQuestion(text: string): boolean {
  const normalized = normalize(text);
  return GENERAL_QUESTION_PHRASES.some((phrase) => normalized.includes(` ${phrase} `));
}
