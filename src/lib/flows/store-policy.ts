/**
 * Business rules the bot applies everywhere — opening hours and
 * products that can't be ordered over WhatsApp — read from the
 * account's business settings (Settings → My business; see
 * lib/business/settings.ts), not hard-coded per store.
 *
 * Hours use a fixed UTC offset per business (no DST): exact for the
 * store's market (Ecuador, UTC-5) and most of Latin America.
 *
 * Blocked products: Meta's Commerce Policy forbids buying/selling
 * alcohol over WhatsApp, and repeated violations get the number
 * restricted — so the default settings already block liquor terms.
 */

import { renderText, type BusinessSettings } from "../business/settings";

const DAY_NAMES = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

function localTime(now: Date, utcOffsetHours: number): { day: number; hour: number } {
  const shifted = new Date(now.getTime() + utcOffsetHours * 3_600_000);
  return { day: shifted.getUTCDay(), hour: shifted.getUTCHours() };
}

/** Hours for a weekday; undefined = not configured (always open), null = closed. */
function hoursFor(biz: BusinessSettings, day: number): [number, number] | null | undefined {
  if (biz.openingHours.length === 0) return undefined;
  return biz.openingHours.at(day) ?? null;
}

export function isWithinBusinessHours(biz: BusinessSettings, now: Date = new Date()): boolean {
  const { day, hour } = localTime(now, biz.utcOffsetHours);
  const hours = hoursFor(biz, day);
  if (hours === undefined) return true;
  if (hours === null) return false;
  return hour >= hours[0] && hour < hours[1];
}

/** 7 → "7am", 22 → "10pm", 12 → "12pm". */
export function formatHour(h: number): string {
  if (h === 0 || h === 24) return "12am";
  if (h === 12) return "12pm";
  return h < 12 ? `${h}am` : `${h - 12}pm`;
}

/** "lunes a sábado de 7am a 10pm, domingo de 8am a 10pm" — consecutive equal days grouped. */
export function hoursInWords(biz: BusinessSettings): string {
  if (biz.openingHours.length === 0) return "todos los días";
  const order = [1, 2, 3, 4, 5, 6, 0]; // Monday first
  const parts: string[] = [];
  let i = 0;
  while (i < order.length) {
    const h = biz.openingHours.at(order.at(i)!) ?? null;
    let j = i;
    while (j + 1 < order.length) {
      const next = biz.openingHours.at(order.at(j + 1)!) ?? null;
      if (JSON.stringify(next) !== JSON.stringify(h)) break;
      j += 1;
    }
    if (h) {
      const days =
        i === j ? DAY_NAMES.at(order.at(i)!)! : `${DAY_NAMES.at(order.at(i)!)} a ${DAY_NAMES.at(order.at(j)!)}`;
      parts.push(`${days} de ${formatHour(h[0])} a ${formatHour(h[1])}`);
    }
    i = j + 1;
  }
  return parts.join(", ") || "sin horario configurado";
}

/**
 * Customer-facing note for a handoff that lands outside opening hours:
 * the order waits for the next opening instead of the customer
 * wondering why nobody answers. "hoy" when it's the small hours before
 * today's opening, "mañana" / the weekday after closing.
 */
export function outOfHoursNotice(biz: BusinessSettings, now: Date = new Date()): string {
  const { day, hour } = localTime(now, biz.utcOffsetHours);
  const today = hoursFor(biz, day);
  let cuando = "en cuanto abramos";
  if (today && hour < today[0]) {
    cuando = `hoy a partir de las ${formatHour(today[0])}`;
  } else {
    for (let ahead = 1; ahead <= 7; ahead += 1) {
      const h = hoursFor(biz, (day + ahead) % 7);
      if (!h) continue;
      const which = ahead === 1 ? "mañana" : `el ${DAY_NAMES.at((day + ahead) % 7)}`;
      cuando = `${which} a partir de las ${formatHour(h[0])}`;
      break;
    }
  }
  return renderText(biz.texts.outOfHours, { cuando, horario: hoursInWords(biz) });
}

export function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9ñ\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Whole-word, accent-insensitive match against the blocked terms. */
export function isBlockedProduct(biz: BusinessSettings, text: string): boolean {
  if (!text) return false;
  const words = new Set(normalizeForMatch(text).split(" "));
  return biz.blockedProducts.terms.some((term) => words.has(normalizeForMatch(term)));
}
