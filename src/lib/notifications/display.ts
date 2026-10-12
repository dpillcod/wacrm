// ============================================================
// How a notification is shown. The assignment trigger (migration 027)
// stores a fixed English text; it's put in the app's language here.
// When the bot assigns a conversation (no actor), the flow engine also
// sends its own, richer notification for the same conversation (the
// order or service), so the generic one is left out of the list and
// makes no sound.
// ============================================================

import type { Notification } from "@/types";

const GENERIC_TITLE = "New conversation assigned";
const GENERIC_BODY = /^(.*) assigned you a conversation with (.*)$/;
const PAIR_WINDOW_MS = 5 * 60_000;

/** The trigger's own "New conversation assigned" notification. */
export function isGenericAssignment(n: Pick<Notification, "title">): boolean {
  return n.title === GENERIC_TITLE;
}

/** Generic, assigned by the bot (no actor): the engine's notification covers it. */
export function isSystemGenericAssignment(n: Pick<Notification, "title" | "actor_user_id">): boolean {
  return isGenericAssignment(n) && !n.actor_user_id;
}

/** Drop generic bot assignments that have a richer notification for the same conversation. */
export function withoutRedundant(list: Notification[]): Notification[] {
  return list.filter(
    (n) =>
      !isSystemGenericAssignment(n) ||
      !list.some(
        (m) =>
          m.id !== n.id &&
          m.conversation_id === n.conversation_id &&
          !isGenericAssignment(m) &&
          Math.abs(Date.parse(m.created_at) - Date.parse(n.created_at)) < PAIR_WINDOW_MS,
      ),
  );
}

type Translate = (key: string, values?: Record<string, string>) => string;

/** Title and body in the app's language (keys under NotificationsPage). */
export function localizedText(n: Pick<Notification, "title" | "body">, t: Translate): { title: string; body?: string } {
  if (!isGenericAssignment(n)) return { title: n.title, body: n.body };
  const m = (n.body ?? "").match(GENERIC_BODY);
  const actor = m && m[1] !== "Someone" ? m[1] : t("someone");
  const contact = m && m[2] !== "a contact" ? m[2] : t("aContact");
  return { title: t("assignedTitle"), body: t("assignedBody", { actor, contact }) };
}
