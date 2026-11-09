/**
 * Products someone usually has installed (a lock, a faucet, a socket):
 * when an order carries one, the closing message offers a technician
 * instead of the usual promotion — right after buying is when people
 * think "¿y quién me lo pone?".
 */

import { normalizeForMatch } from "./store-policy";

// Normalized (no accents), singular and plural. "Llave" alone also means
// a key, but in a hardware order it's almost always a faucet valve.
const INSTALLABLE =
  /\b(chapas?|cerraduras?|candados? de seguridad|llaves? (de agua|de paso|de lavabo|de lavamanos|de ducha|de fregadero|mezcladora|monomando)|llaves?|grifos?|griferias?|mezcladoras?|duchas?|calefon(es)?|inodoros?|sanitarios?|lavamanos|lavabos?|fregaderos?|sifon(es)?|tuberias?|tomacorrientes?|enchufes?|interruptor(es)?|breakers?|tableros? electricos?|lamparas?|apliques?|ventiladores? de techo|reflectores?|pinturas?|cielo raso|ceramicas?|porcelanatos?)\b/;
// Same words, other things: wrenches, school paints, desk lamps, keyrings.
const NOT_INSTALLABLE =
  /\b(llaves? (inglesa|de tubo|de pico|mixtas?|hexagonal(es)?|allen|torx|de boca|de corona|francesa|stilson|de cruz|para tubo)|juego de llaves|pinturas? (de colores|escolar(es)?|acrilicas?|de dedos|para ninos|para unas|de unas)|lamparas? (de escritorio|de mesa|recargables?|de mano|solar(es)?)|llaveros?)\b/;

/** The first order line with an installable product ("1 chapa Yale"), or null. */
export function installableLine(list: string): string | null {
  for (const raw of list.split("\n")) {
    const line = raw.replace(/^\s*\d+\.\s*/, "").trim();
    if (!line || /instal/i.test(line)) continue;
    const said = normalizeForMatch(line);
    if (INSTALLABLE.test(said) && !NOT_INSTALLABLE.test(said)) return line;
  }
  return null;
}

/** "Con instalación" already asked for anywhere in the list: nothing to offer. */
export function listAsksInstallation(list: string): boolean {
  return /instal/i.test(list);
}
