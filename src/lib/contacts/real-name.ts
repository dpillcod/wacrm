/**
 * Whether a contact already has a name worth keeping — anything with
 * letters, as opposed to empty or a phone number. Inbound messages only
 * fill in the WhatsApp profile name when there isn't one, so a name the
 * team typed or the customer gave (their invoice name) isn't replaced
 * by the profile name on every message.
 */
export function hasRealName(name: string | null | undefined): boolean {
  return typeof name === "string" && /\p{L}/u.test(name);
}
