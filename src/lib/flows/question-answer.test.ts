import { describe, expect, it } from "vitest";
import { acceptOfferedProduct, looksLikeQuestion, parseFlowAnswer } from "./question-answer";

describe("looksLikeQuestion", () => {
  it.each([
    "Disculpe dispone de Grilon ?",
    "Tiene domicilio?",
    "hay cemento holcim",
    "buenas, hacen envíos a Baños?",
    "aceptan tarjeta",
    "a que hora cierran",
    "Hola buenos dias estimado de pronto tenga esta herramienta?",
  ])("is a question: %s", (t) => expect(looksLikeQuestion(t)).toBe(true));

  it.each(["2 coca cola", "1 libra de arroz", "detergente deja 1 kilo", "hola", "que tal", "listo", "2 panes ?"])(
    "is not a question: %s",
    (t) => expect(looksLikeQuestion(t)).toBe(false),
  );
});

describe("acceptOfferedProduct", () => {
  it("writes the offered product with the quantity given", () => {
    expect(acceptOfferedProduct("sí", "hilo grilón")).toBe("1 hilo grilón");
    expect(acceptOfferedProduct("Sí, 10 metros", "hilo grilón")).toBe("10 metros hilo grilón");
    expect(acceptOfferedProduct("ok 2", "foco LED")).toBe("2 foco LED");
    expect(acceptOfferedProduct("3 rollos", "cinta aislante")).toBe("3 rollos cinta aislante");
  });
  it("leaves anything else alone", () => {
    expect(acceptOfferedProduct("mejor una leche", "hilo grilón")).toBeNull();
    expect(acceptOfferedProduct("no gracias", "hilo grilón")).toBeNull();
  });
});

describe("parseFlowAnswer", () => {
  it("reads the reply and the offered product", () => {
    expect(parseFlowAnswer('{"reply":"Sí, lo manejamos 🙂 ¿Cuántos metros?","product":"hilo grilón"}')).toEqual({
      reply: "Sí, lo manejamos 🙂 ¿Cuántos metros?",
      product: "hilo grilón",
    });
    expect(parseFlowAnswer('{"reply":"Sí, hacemos envíos con motorizado.","product":null}')?.product).toBeNull();
    expect(parseFlowAnswer("hola")).toBeNull();
  });
});
