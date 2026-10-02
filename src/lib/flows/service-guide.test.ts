import { describe, expect, it } from "vitest";
import { parseGuideStep } from "./service-guide";

describe("parseGuideStep", () => {
  it("reads a question, a tip and a summary", () => {
    expect(
      parseGuideStep(
        'Listo: {"question":"¿Es en el baño o en la cocina?","tip":"Mientras tanto, cierre la llave de paso.","summary":"Fuga en llave de lavabo"}',
      ),
    ).toEqual({
      question: "¿Es en el baño o en la cocina?",
      tip: "Mientras tanto, cierre la llave de paso.",
      summary: "Fuga en llave de lavabo",
    });
  });

  it("treats null or empty fields as absent", () => {
    expect(parseGuideStep('{"question":null,"tip":"","summary":"Torta de chocolate para 20 personas, sábado 15h"}')).toEqual({
      question: null,
      tip: null,
      summary: "Torta de chocolate para 20 personas, sábado 15h",
    });
  });

  it("accepts a question before there is a summary", () => {
    expect(parseGuideStep('```json\n{"question":"¿Para cuándo?","tip":null,"summary":null}\n```')).toEqual({
      question: "¿Para cuándo?",
      tip: null,
      summary: "",
    });
  });

  it("rejects a reply with neither question nor summary, or without JSON", () => {
    expect(parseGuideStep('{"question":null,"summary":null}')).toBeNull();
    expect(parseGuideStep("no sé")).toBeNull();
    expect(parseGuideStep("{roto")).toBeNull();
  });
});

describe("price questions for services and bakery orders", () => {
  it("recognises how customers ask what a job costs", async () => {
    const { isPriceQuestion } = await import("./price-question");
    expect(isPriceQuestion("¿cuánto me cobran?")).toBe(true);
    expect(isPriceQuestion("cual es el costo de pintar")).toBe(true);
    expect(isPriceQuestion("que precio tiene la torta")).toBe(true);
    expect(isPriceQuestion("se me dañó la llave")).toBe(false);
  });
});
