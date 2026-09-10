import { describe, it, expect } from "vitest";
import { isGeneralQuestion } from "./general-question";

describe("isGeneralQuestion", () => {
  it("detects schedule questions", () => {
    expect(isGeneralQuestion("cual son sus horarios de atencion")).toBe(true);
    expect(isGeneralQuestion("¿A qué hora abren?")).toBe(true);
    expect(isGeneralQuestion("hasta que hora atienden")).toBe(true);
    expect(isGeneralQuestion("atienden los domingos?")).toBe(true);
  });

  it("detects location questions", () => {
    expect(isGeneralQuestion("donde estan ubicados")).toBe(true);
    expect(isGeneralQuestion("cual es su direccion")).toBe(true);
  });

  it("detects general product-range questions", () => {
    expect(isGeneralQuestion("que productos tienen")).toBe(true);
    expect(isGeneralQuestion("que areas manejan")).toBe(true);
  });

  it("is accent/case insensitive", () => {
    expect(isGeneralQuestion("CUÁL ES SU HORARIO")).toBe(true);
    expect(isGeneralQuestion("Cuál Es Su Dirección")).toBe(true);
  });

  it("does not misfire on normal order items", () => {
    expect(isGeneralQuestion("1 libra de queso")).toBe(false);
    expect(isGeneralQuestion("2 cocas de 2 litros")).toBe(false);
    expect(isGeneralQuestion("leche nutro roja")).toBe(false);
    expect(isGeneralQuestion("eso es todo")).toBe(false);
    expect(isGeneralQuestion("")).toBe(false);
  });
});
