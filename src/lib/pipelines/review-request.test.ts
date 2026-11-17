import { describe, expect, it } from "vitest";
import { reviewDecision } from "./review-request";
import { csatThanks } from "./order-stages";
import { DEFAULT_BUSINESS_SETTINGS, sanitizeSettings } from "../business/settings";
import { escalates, needsAnswer } from "../flows/unanswered-alerts";
import { purchaseEvent, sha256 } from "../marketing/meta-conversions";

const base = {
  deliveredAt: new Date("2026-11-17T15:00:00Z"),
  now: new Date("2026-11-17T17:30:00Z"),
  delayHours: 2,
  reviewUrl: "https://g.page/r/x/review",
  open: true,
  hasConversation: true,
  askedRecently: false,
  windowOpen: true,
};

describe("review request after delivery (C4)", () => {
  it("asks everyone 2 h after delivery", () => {
    expect(reviewDecision(base)).toBe("send");
    expect(reviewDecision({ ...base, now: new Date("2026-11-17T16:00:00Z") })).toBe("wait");
  });
  it("once every 90 days, only in the free window, in opening hours", () => {
    expect(reviewDecision({ ...base, askedRecently: true })).toBe("skip");
    expect(reviewDecision({ ...base, windowOpen: false })).toBe("skip");
    expect(reviewDecision({ ...base, open: false })).toBe("wait");
    expect(reviewDecision({ ...base, delayHours: 0 })).toBe("wait");
    expect(reviewDecision({ ...base, reviewUrl: "" })).toBe("wait");
  });
  it("never sends the review link only to happy customers", () => {
    const biz = sanitizeSettings({ googleReviewUrl: "https://g.page/r/x/review" });
    expect(csatThanks("excelente", biz)).not.toContain("g.page");
    const old = sanitizeSettings({ googleReviewUrl: "https://g.page/r/x/review", orderBoard: { csatExcellent: "Gracias ⭐\n{resena}" } });
    expect(csatThanks("excelente", old)).toBe(old.orderBoard.csatGood);
    expect(DEFAULT_BUSINESS_SETTINGS.orderBoard.reviewRequest).toContain("{resena}");
  });
});

describe("escalation", () => {
  it("escalates promised-a-person alerts and new orders", () => {
    expect(escalates("🧾 Pedido N° 0041 — Ana")).toBe(true);
    expect(escalates("⚠️ 🧾 Pedido N° 0041 sigue sin atender")).toBe(true);
    expect(escalates("⚠️ Ayuda al cliente: Eduardo")).toBe(true);
    expect(escalates("✏️ Cotización: el cliente quiere cambiar algo — Ana")).toBe(true);
    expect(needsAnswer("✏️ Cotización: el cliente quiere cambiar algo — Ana")).toBe(true);
    expect(escalates("⏰ SIN RESPUESTA (12 min): Eduardo")).toBe(false);
    expect(escalates("🔴 ESCALADO (25 min sin respuesta): Eduardo")).toBe(false);
    expect(escalates("🧾 Comprobante de pago")).toBe(false);
    expect(escalates("💬 Cliente escribiendo: Ana")).toBe(false);
    expect(escalates("✅ Cotización aceptada: Ana")).toBe(false);
  });
});

describe("sales to Meta", () => {
  const e = { dealId: "d1", value: 45.5, currency: "USD", wabaId: "w1", clickId: null as string | null, pageId: "", phone: "+593 99 000 0831", eventTime: 1 };
  it("uses the ad's click id", () => {
    const ev = purchaseEvent({ ...e, clickId: "clid" })!;
    expect(ev.user_data).toEqual({ whatsapp_business_account_id: "w1", ctwa_clid: "clid" });
    expect(ev.custom_data).toEqual({ currency: "USD", value: 45.5 });
    expect(ev.action_source).toBe("business_messaging");
  });
  it("falls back to the hashed phone with a page id, else nothing", () => {
    expect(purchaseEvent(e)).toBeNull();
    const ev = purchaseEvent({ ...e, pageId: "123" })!;
    expect(ev.user_data).toEqual({ whatsapp_business_account_id: "w1", page_id: "123", ph: [sha256("593990000831")] });
  });
});
