import { describe, expect, it } from "vitest";
import {
  isAlcoholRequest,
  isWithinBusinessHours,
  outOfHoursNotice,
} from "./store-policy";

// Ecuador is UTC-5, so 12:00Z is 07:00 in Cuenca.
const at = (iso: string) => new Date(iso);

describe("isWithinBusinessHours (Ecuador time)", () => {
  it("opens at 7am Monday-Saturday", () => {
    // 2026-09-28 is a Monday.
    expect(isWithinBusinessHours(at("2026-09-28T11:59:00Z"))).toBe(false); // 6:59
    expect(isWithinBusinessHours(at("2026-09-28T12:00:00Z"))).toBe(true); // 7:00
  });

  it("opens at 8am on Sunday", () => {
    // 2026-09-27 is a Sunday.
    expect(isWithinBusinessHours(at("2026-09-27T12:30:00Z"))).toBe(false); // 7:30
    expect(isWithinBusinessHours(at("2026-09-27T13:00:00Z"))).toBe(true); // 8:00
  });

  it("closes at 10pm", () => {
    expect(isWithinBusinessHours(at("2026-09-29T02:59:00Z"))).toBe(true); // Mon 21:59
    expect(isWithinBusinessHours(at("2026-09-29T03:00:00Z"))).toBe(false); // Mon 22:00
  });
});

describe("outOfHoursNotice", () => {
  it("says 'mañana' after closing, with the next day's opening hour", () => {
    // Saturday 23:00 → Sunday opens at 8am.
    expect(outOfHoursNotice(at("2026-09-27T04:00:00Z"))).toContain("mañana a partir de las 8am");
  });

  it("says 'hoy' in the small hours before opening", () => {
    // Monday 03:00.
    expect(outOfHoursNotice(at("2026-09-28T08:00:00Z"))).toContain("hoy a partir de las 7am");
  });
});

describe("isAlcoholRequest", () => {
  it("detects liquor terms as whole words, accent-insensitive", () => {
    expect(isAlcoholRequest("2 cervezas pilsener")).toBe(true);
    expect(isAlcoholRequest("una botella de ZHUMIR")).toBe(true);
    expect(isAlcoholRequest("un coñac")).toBe(true);
  });

  it("does not flag ordinary items that merely contain a term", () => {
    expect(isAlcoholRequest("2 libras de ronsón")).toBe(false);
    expect(isAlcoholRequest("vinagre blanco")).toBe(false);
    expect(isAlcoholRequest("pan de chocolate")).toBe(false);
  });
});
