import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOrderLinkToken, orderLinkUrl, readOrderLinkToken } from "./order-link";

const link = {
  accountId: "4411c277-8310-4d2c-a950-ceff579396a2",
  contactId: "11111111-2222-3333-4444-555555555555",
  conversationId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  expiresAt: Math.floor(new Date("2026-10-10T12:00:00Z").getTime() / 1000),
};

describe("order link token", () => {
  beforeEach(() => vi.stubEnv("ORDER_LINK_SECRET", "secreto-de-prueba"));
  afterEach(() => vi.unstubAllEnvs());

  it("round-trips and stays short enough for a WhatsApp button", () => {
    const token = createOrderLinkToken(link);
    expect(token.length).toBeLessThan(100);
    expect(readOrderLinkToken(token, new Date("2026-10-10T11:00:00Z"))).toEqual({ ok: true, link });
  });

  it("refuses an expired, edited or foreign token", () => {
    const token = createOrderLinkToken(link);
    expect(readOrderLinkToken(token, new Date("2026-10-10T12:00:01Z"))).toEqual({ ok: false, reason: "expired" });
    const edited = (token[0] === "A" ? "B" : "A") + token.slice(1);
    expect(readOrderLinkToken(edited, new Date("2026-10-10T11:00:00Z"))).toEqual({ ok: false, reason: "invalid" });
    vi.stubEnv("ORDER_LINK_SECRET", "otro-secreto");
    expect(readOrderLinkToken(token, new Date("2026-10-10T11:00:00Z"))).toEqual({ ok: false, reason: "invalid" });
    expect(readOrderLinkToken("basura", new Date())).toEqual({ ok: false, reason: "invalid" });
  });

  it("builds the link only on an https base", () => {
    expect(orderLinkUrl("https://crm.example.com/", "abc")).toBe("https://crm.example.com/pedir/abc");
    expect(orderLinkUrl("http://inseguro.com", "abc")).toBeNull();
    expect(orderLinkUrl("", "abc")).toBeNull();
  });
});
