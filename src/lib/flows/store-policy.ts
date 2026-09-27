/**
 * Store-level policy for the Ferrotienda bot — opening hours and the
 * alcohol rule. Kept as plain code constants rather than per-account
 * settings: this deployment serves one store, and both rules are
 * business facts (not something a flow author should be able to
 * forget to configure on one node and not another).
 *
 * Opening hours: Mon-Sat 7:00-22:00, Sun 8:00-22:00, no holiday
 * closures. Ecuador is UTC-5 year-round (no DST), so a fixed offset is
 * exact — no timezone database needed.
 *
 * Alcohol: Meta's Commerce Policy forbids buying/selling alcohol over
 * WhatsApp, and repeated violations get the number restricted. Liquor
 * is only sold on the website (where checkout handles the age check),
 * so the bot declines it in chat and points to the site instead of
 * adding it to an order.
 */

const ECUADOR_UTC_OFFSET_HOURS = -5;

export const STORE_WEBSITE_URL = "https://ferrotiendaec.com";

/** [openHour, closeHour) per day of week, 0 = Sunday. */
const OPENING_HOURS: Record<number, [number, number]> = {
  0: [8, 22],
  1: [7, 22],
  2: [7, 22],
  3: [7, 22],
  4: [7, 22],
  5: [7, 22],
  6: [7, 22],
};

function toEcuadorTime(now: Date): { day: number; hour: number } {
  const shifted = new Date(now.getTime() + ECUADOR_UTC_OFFSET_HOURS * 3_600_000);
  return { day: shifted.getUTCDay(), hour: shifted.getUTCHours() };
}

export function isWithinBusinessHours(now: Date = new Date()): boolean {
  const { day, hour } = toEcuadorTime(now);
  const [open, close] = OPENING_HOURS[day];
  return hour >= open && hour < close;
}

/**
 * Customer-facing note for a handoff that lands outside opening hours:
 * the order waits for the next opening instead of the customer
 * wondering why nobody answers. "hoy" when it's the small hours before
 * today's opening, "mañana" after closing.
 */
export function outOfHoursNotice(now: Date = new Date()): string {
  const { day, hour } = toEcuadorTime(now);
  const [openToday] = OPENING_HOURS[day];
  let when: string;
  if (hour < openToday) {
    when = `hoy a partir de las ${openToday}am`;
  } else {
    const [openTomorrow] = OPENING_HOURS[(day + 1) % 7];
    when = `mañana a partir de las ${openTomorrow}am`;
  }
  return (
    "En este momento estamos fuera de nuestro horario de atención " +
    "(lunes a sábado de 7am a 10pm, domingos de 8am a 10pm). " +
    `Su mensaje quedó registrado y le atenderemos ${when} 🙂`
  );
}

/**
 * Whole-word, accent-insensitive list of liquor terms. Deliberately
 * specific: generic words that only *sometimes* mean alcohol
 * ("cristal", "club", "pájaro") are left out so an ordinary grocery
 * item never gets refused.
 */
const ALCOHOL_TERMS = [
  "licor",
  "licores",
  "trago",
  "tragos",
  "cerveza",
  "cervezas",
  "chela",
  "chelas",
  "pilsener",
  "whisky",
  "whiskey",
  "wisky",
  "ron",
  "vodka",
  "tequila",
  "aguardiente",
  "zhumir",
  "vino",
  "vinos",
  "champagne",
  "champan",
  "espumante",
  "gin",
  "ginebra",
  "brandy",
  "cognac",
  "coñac",
  "mezcal",
  "pisco",
  "sangria",
];

export function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9ñ\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isAlcoholRequest(text: string): boolean {
  if (!text) return false;
  const words = new Set(normalizeForMatch(text).split(" "));
  return ALCOHOL_TERMS.some((term) => words.has(normalizeForMatch(term)));
}

export const ALCOHOL_REPLY =
  "Por este medio no podemos tomar pedidos de licores 🙏 " +
  `Puede encontrarlos y comprarlos en nuestra página web: ${STORE_WEBSITE_URL}\n\n` +
  "Si necesita algo más, con gusto lo anoto.";
