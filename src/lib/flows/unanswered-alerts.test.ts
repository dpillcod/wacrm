import { describe, expect, it } from "vitest";
import { needsAnswer } from "./unanswered-alerts";
import { catalogHasProduct, withoutGreeting, withoutStockClaim } from "./question-answer";
import { isPlainGreeting } from "./engine";

describe("chats of Nov 9", () => {
  it("repeats only alerts that promised the customer a person", () => {
    expect(needsAnswer("📄 Archivo del cliente — MAKTUB💜")).toBe(true);
    expect(needsAnswer("⚠️ Ayuda al cliente: Eduardo (0982407883)")).toBe(true);
    expect(needsAnswer("⏳ Pedido sin datos: Ronny")).toBe(true);
    expect(needsAnswer("💬 Cliente escribiendo: Ana")).toBe(false);
    expect(needsAnswer("⚠️ Turno vencido: Diego")).toBe(false);
    expect(needsAnswer("⏰ SIN RESPUESTA (12 min): Eduardo")).toBe(false);
  });

  it("reads a stretched 'vecino' as a call-out", () => {
    expect(isPlainGreeting("Vecinooo")).toBe(true);
    expect(isPlainGreeting("Veci")).toBe(true);
    expect(isPlainGreeting("Holaaa vecina")).toBe(true);
    expect(isPlainGreeting("vecino tiene clavos")).toBe(false);
  });

  it("doesn't greet twice", () => {
    expect(withoutGreeting("¡Hola Eduardo! 👋 Sí, manejamos adhesivos.")).toBe("Sí, manejamos adhesivos.");
    expect(withoutGreeting("Buenos días, disculpe que no veo grava en el catálogo.")).toBe("Disculpe que no veo grava en el catálogo.");
    expect(withoutGreeting("Buenas tardes 🙂 Sí, manejamos chapas.")).toBe("Sí, manejamos chapas.");
    expect(withoutGreeting("Le anoto 2 fundas 🙂")).toBe("Le anoto 2 fundas 🙂");
  });

  it("drops a 'sí, tenemos' with nothing in the catalog behind it", () => {
    expect(withoutStockClaim("Sí, manejamos chapas. ¿Para dormitorio, baño o puerta principal?")).toBe(
      "Un asesor le confirma si lo tenemos 🙂 ¿Para dormitorio, baño o puerta principal?",
    );
    expect(
      withoutStockClaim("Sí, manejamos adhesivos y pegamentos en general. ¿Cuál tipo necesita? Le anoto la cantidad y un asesor le confirma si lo tenemos 🙂"),
    ).toBe("¿Cuál tipo necesita? Le anoto la cantidad y un asesor le confirma si lo tenemos 🙂");
    expect(withoutStockClaim("¡Sí! Manejamos dulces de guayaba. ¿Cuántos necesita?")).toBe(
      "Un asesor le confirma si lo tenemos 🙂 ¿Cuántos necesita?",
    );
    expect(withoutStockClaim("No lo veo en el catálogo, pero se lo anoto.")).toBe("No lo veo en el catálogo, pero se lo anoto.");
  });

  it("backs 'sí, tenemos' with a catalog name", () => {
    expect(catalogHasProduct("arroz", ["ARROZ FLOR 5 LB", "ATUN REAL"])).toBe(true);
    expect(catalogHasProduct("chapas", ["CERRADURA NOVA DORMITORIO"])).toBe(true);
    expect(catalogHasProduct("dulces de guayaba", ["DULCE DE GUAYABA"])).toBe(true);
    expect(catalogHasProduct("afix", ["AKFIX 705 SPRAY"])).toBe(false);
  });
});
