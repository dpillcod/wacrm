import { describe, expect, it } from "vitest";
import type { Notification } from "@/types";
import { localizedText, withoutRedundant } from "./display";

const base = { account_id: "a", user_id: "u", type: "conversation_assigned" as const };
const n = (over: Partial<Notification>): Notification => ({
  ...base,
  id: Math.random().toString(36),
  title: "x",
  created_at: "2026-10-11T10:00:00Z",
  ...over,
});

describe("withoutRedundant", () => {
  it("drops the bot's generic assignment when the order notification is there", () => {
    const generic = n({ title: "New conversation assigned", conversation_id: "c1" });
    const order = n({ title: "🧾 Pedido N° 0012 — Ana", conversation_id: "c1", created_at: "2026-10-11T10:00:02Z" });
    expect(withoutRedundant([order, generic])).toEqual([order]);
  });
  it("keeps a generic assignment made by a person, or one without a richer twin", () => {
    const byPerson = n({ title: "New conversation assigned", conversation_id: "c1", actor_user_id: "p" });
    const alone = n({ title: "New conversation assigned", conversation_id: "c2" });
    const order = n({ title: "🧾 Pedido", conversation_id: "c1" });
    expect(withoutRedundant([order, byPerson, alone])).toHaveLength(3);
  });
});

describe("localizedText", () => {
  const t = (key: string, values?: Record<string, string>) =>
    ({
      someone: "Alguien",
      aContact: "un contacto",
      assignedTitle: "Conversación asignada",
      assignedBody: `${values?.actor} le asignó una conversación con ${values?.contact}`,
    })[key] ?? key;
  it("translates the trigger's English text", () => {
    expect(localizedText({ title: "New conversation assigned", body: "Someone assigned you a conversation with Diego" }, t)).toEqual({
      title: "Conversación asignada",
      body: "Alguien le asignó una conversación con Diego",
    });
  });
  it("leaves other notifications as they are", () => {
    expect(localizedText({ title: "🧾 Pedido N° 0012", body: "Lista" }, t)).toEqual({ title: "🧾 Pedido N° 0012", body: "Lista" });
  });
});
