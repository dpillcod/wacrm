import { describe, expect, it } from "vitest";
import { adLineOf, parseWebServiceRequest, sanitizeAdLines } from "./ad-lines";

const lines = sanitizeAdLines([
  { key: "juguetes", words: ["juguete", "juguetes", "muñeca"], reply: "¿Para qué edad?", photoTag: "juguetes" },
  { key: "fiestas", words: ["fiesta", "cumpleaños", "globos"], notWords: ["torta", "pastel"], reply: "¿Qué celebra?", toPerson: true },
  { key: "", words: ["x"], reply: "sin clave" },
]);

describe("campaign lines", () => {
  it("keeps valid lines, folded", () => {
    expect(lines.map((l) => l.key)).toEqual(["juguetes", "fiestas"]);
    expect(lines[0].words).toContain("muneca");
    expect(lines[0].toPerson).toBe(true);
  });
  it("finds the line in the first message or the ad", () => {
    expect(adLineOf(lines, "Hola, quiero ver juguetes 🎁")?.key).toBe("juguetes");
    expect(adLineOf(lines, "Info", { headline: "Todo para tu cumpleaños" })?.key).toBe("fiestas");
    expect(adLineOf(lines, "hola")).toBeNull();
    expect(adLineOf(lines, "quiero una torta para un cumpleaños")).toBeNull();
    expect(adLineOf(lines, "jugueteria")).toBeNull();
  });
  it("a long list is an order, not a campaign hello", () => {
    expect(adLineOf(lines, "quiero 2 leches, 1 pan, 3 huevos, una funda de globos, arroz, azúcar, sal y aceite por favor")).toBeNull();
  });
});

describe("web technician request", () => {
  it("parses the form summary", () => {
    const r = parseWebServiceRequest(
      "Hola, pedí un técnico en la web (SW-0007)\nServicio: Plomería — Fuga en el baño\nNombre: Ana Pérez\nSector: Totoracocha\nDía: 21/11/2026, mañana\nDetalle: gotea bajo el lavabo\nMi foto del trabajo te la mando aquí 👇",
    );
    expect(r).toEqual({
      code: "SW-0007",
      service: "Plomería",
      job: "Fuga en el baño",
      name: "Ana Pérez",
      sector: "Totoracocha",
      when: "21/11/2026, mañana",
      detail: "gotea bajo el lavabo",
    });
  });
  it("ignores anything else", () => {
    expect(parseWebServiceRequest("necesito un técnico")).toBeNull();
    expect(parseWebServiceRequest("Hola, pedi un tecnico en la web (S-0012)")?.code).toBe("S-0012");
  });
});
