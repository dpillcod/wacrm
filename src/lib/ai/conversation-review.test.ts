import { describe, expect, it, vi } from "vitest";

vi.mock("./config", () => ({ loadAiConfig: vi.fn() }));
vi.mock("./usage", () => ({ logAiUsage: vi.fn() }));

import { lastSession, parseReview, transcript, type ReviewMessage } from "./conversation-review";

const at = (h: number, m = 0) => new Date(Date.UTC(2026, 9, 15, h, m)).toISOString();
const msg = (sender_type: ReviewMessage["sender_type"], text: string, created_at: string): ReviewMessage => ({
  sender_type,
  content_type: "text",
  content_text: text,
  created_at,
});

describe("lastSession", () => {
  it("starts after the customer's last long silence", () => {
    const s = lastSession([
      msg("customer", "hola (ayer)", at(1)),
      msg("bot", "menú", at(1, 1)),
      msg("customer", "buenos días", at(13)),
      msg("bot", "menú", at(13, 1)),
      msg("customer", "2 panes", at(13, 5)),
    ]);
    expect(s.map((m) => m.content_text)).toEqual(["buenos días", "menú", "2 panes"]);
  });
  it("is empty without customer messages", () => {
    expect(lastSession([msg("bot", "hola", at(1))])).toEqual([]);
  });
});

describe("transcript / parseReview", () => {
  it("labels who said what", () => {
    expect(transcript([msg("customer", "hola", at(1)), msg("agent", "buenas", at(1, 2))])).toBe("CLIENTE: hola\nASESOR (persona): buenas");
  });
  it("reads the AI's verdict and keeps at most 5 problems", () => {
    const raw = `Aquí va: {"veredicto":"mal","resumen":"Quería tortillas y se fue","problemas":[${Array(7)
      .fill('{"gravedad":"alta","mensaje_cliente":"x","que_paso":"no respondió","sugerencia":"responder"}')
      .join(",")}]}`;
    const r = parseReview(raw)!;
    expect(r.verdict).toBe("mal");
    expect(r.summary).toBe("Quería tortillas y se fue");
    expect(r.problems).toHaveLength(5);
  });
  it("defaults to 'bien' and survives junk", () => {
    expect(parseReview('{"problemas":[]}')!.verdict).toBe("bien");
    expect(parseReview("sin json")).toBeNull();
  });
});
