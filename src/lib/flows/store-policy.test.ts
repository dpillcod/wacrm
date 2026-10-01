import { describe, expect, it } from "vitest";
import {
  formatHour,
  hoursInWords,
  isBlockedProduct,
  isWithinBusinessHours,
  outOfHoursNotice,
} from "./store-policy";
import { DEFAULT_BUSINESS_SETTINGS } from "../business/settings";
import { DEMO_STORE } from "../business/__fixtures__/demo-store";

// Ecuador is UTC-5, so 12:00Z is 07:00 in Cuenca.
const at = (iso: string) => new Date(iso);

describe("isWithinBusinessHours (Ecuador time)", () => {
  it("opens at 7am Monday-Saturday", () => {
    // 2026-09-28 is a Monday.
    expect(isWithinBusinessHours(DEMO_STORE, at("2026-09-28T11:59:00Z"))).toBe(false); // 6:59
    expect(isWithinBusinessHours(DEMO_STORE, at("2026-09-28T12:00:00Z"))).toBe(true); // 7:00
  });

  it("opens at 8am on Sunday", () => {
    // 2026-09-27 is a Sunday.
    expect(isWithinBusinessHours(DEMO_STORE, at("2026-09-27T12:30:00Z"))).toBe(false); // 7:30
    expect(isWithinBusinessHours(DEMO_STORE, at("2026-09-27T13:00:00Z"))).toBe(true); // 8:00
  });

  it("closes at 10pm", () => {
    expect(isWithinBusinessHours(DEMO_STORE, at("2026-09-29T02:59:00Z"))).toBe(true); // Mon 21:59
    expect(isWithinBusinessHours(DEMO_STORE, at("2026-09-29T03:00:00Z"))).toBe(false); // Mon 22:00
  });
});

describe("outOfHoursNotice", () => {
  it("says 'mañana' after closing, with the next day's opening hour", () => {
    // Saturday 23:00 → Sunday opens at 8am.
    expect(outOfHoursNotice(DEMO_STORE, at("2026-09-27T04:00:00Z"))).toContain("mañana a partir de las 8am");
  });

  it("says 'hoy' in the small hours before opening", () => {
    // Monday 03:00.
    expect(outOfHoursNotice(DEMO_STORE, at("2026-09-28T08:00:00Z"))).toContain("hoy a partir de las 7am");
  });
});

describe("isBlockedProduct (default liquor terms)", () => {
  it("detects liquor terms as whole words, accent-insensitive", () => {
    expect(isBlockedProduct(DEMO_STORE, "2 cervezas pilsener")).toBe(true);
    expect(isBlockedProduct(DEMO_STORE, "una botella de WHISKY")).toBe(true);
    expect(isBlockedProduct(DEMO_STORE, "un coñac")).toBe(true);
  });

  it("does not flag ordinary items that merely contain a term", () => {
    expect(isBlockedProduct(DEMO_STORE, "2 libras de ronsón")).toBe(false);
    expect(isBlockedProduct(DEMO_STORE, "vinagre blanco")).toBe(false);
    expect(isBlockedProduct(DEMO_STORE, "pan de chocolate")).toBe(false);
  });
});

describe("configurable hours", () => {
  it("describes the week in words, grouping equal days", () => {
    expect(hoursInWords(DEMO_STORE)).toBe("lunes a sábado de 7am a 10pm, domingo de 8am a 10pm");
    expect(formatHour(12)).toBe("12pm");
  });

  it("is always open when no hours are set", () => {
    expect(isWithinBusinessHours(DEFAULT_BUSINESS_SETTINGS, at("2026-09-28T08:00:00Z"))).toBe(true);
  });

  it("skips closed days when saying when it reopens", () => {
    const closedSunday = { ...DEMO_STORE, openingHours: [null, ...DEMO_STORE.openingHours.slice(1)] };
    // Saturday 23:00 → Sunday closed → Monday 7am.
    expect(outOfHoursNotice(closedSunday, at("2026-09-27T04:00:00Z"))).toContain("el lunes a partir de las 7am");
  });
});
