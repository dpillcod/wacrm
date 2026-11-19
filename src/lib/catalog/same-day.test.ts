import { describe, expect, it } from "vitest";
import { sameDayLine } from "./same-day";

describe("same-day delivery line", () => {
  it("counts down to the cut-off in local time", () => {
    // 15:45 in Ecuador (UTC-5)
    expect(sameDayLine(new Date("2026-11-18T20:45:00Z"), -5, 18)).toEqual({ today: true, text: "Pida en 2 h 15 min y le llega HOY" });
    expect(sameDayLine(new Date("2026-11-18T22:20:00Z"), -5, 18)).toEqual({ today: true, text: "Pida en 40 min y le llega HOY" });
    expect(sameDayLine(new Date("2026-11-18T12:00:00Z"), -5, 18)?.text).toBe("Pida en 11 h y le llega HOY");
  });

  it("after the cut-off it's tomorrow; 0 turns it off", () => {
    expect(sameDayLine(new Date("2026-11-18T23:00:00Z"), -5, 18)).toEqual({ today: false, text: "Pida ahora y le llega mañana temprano" });
    expect(sameDayLine(new Date("2026-11-18T20:45:00Z"), -5, 0)).toBeNull();
  });
});
