import { describe, expect, it } from "vitest";
import { isPurchaseOnly, parseGuideStep, purchaseItemFrom } from "./service-guide";

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

describe("isPurchaseOnly / purchaseItemFrom", () => {
  it("recognises a customer who only wants to buy (the real case)", () => {
    for (const t of [
      "Solo comprar la herramienta",
      "Solo necesito el destornillador",
      "Solo necesito el el destornillador",
      "quiero comprar un taladro",
      "no necesito técnico, solo la broca",
      "No quiero que vengan, es para comprar",
      "nomás eso",
    ]) {
      expect(isPurchaseOnly(t), t).toBe(true);
    }
  });
  it("does not take a job for a purchase", () => {
    for (const t of [
      "Necesito un destornillador torx tr9",
      "Solo necesito que un técnico revise el breaker",
      "quiero comprar pintura y que me pinten la sala",
      "se me daña la llave del baño",
      "listo",
    ]) {
      expect(isPurchaseOnly(t), t).toBe(false);
    }
  });
  it("takes the product from the phrase when it names one", () => {
    expect(purchaseItemFrom("Solo necesito el destornillador")).toBe("destornillador");
    expect(purchaseItemFrom("quiero comprar un taladro")).toBe("un taladro");
    expect(purchaseItemFrom("Solo comprar la herramienta")).toBe("");
    expect(purchaseItemFrom("nomás eso")).toBe("");
  });
});

describe("parseGuideStep with a purchase", () => {
  it("returns the purchase and no question", () => {
    expect(parseGuideStep('{"question":null,"tip":null,"summary":"","purchase":"1 destornillador Torx T9"}')).toEqual({
      question: null,
      summary: "",
      tip: null,
      purchase: "1 destornillador Torx T9",
    });
  });
});
