import { describe, expect, it } from "vitest";
import { isShopKeyword } from "./engine";

describe("catalog name typed on its own", () => {
  const rapidito = { shopName: "RAPIDITO ⚡", shopButton: "⚡ RAPIDITO" };
  it("matches the catalog's name, with or without an article", () => {
    expect(isShopKeyword(rapidito, "rapidito")).toBe(true);
    expect(isShopKeyword(rapidito, "RAPIDITO")).toBe(true);
    expect(isShopKeyword(rapidito, "El rapidito")).toBe(true);
    expect(isShopKeyword(rapidito, "quiero ver el rapidito")).toBe(true);
  });
  it("takes the web's pre-filled message", () => {
    expect(isShopKeyword(rapidito, "Hola, quiero hacer un pedido RAPIDITO ⚡")).toBe(true);
    expect(isShopKeyword(rapidito, "Buenas tardes, quisiera pedir por rapidito")).toBe(true);
    expect(isShopKeyword(rapidito, "quiero hacer un pedido")).toBe(false);
  });
  it("doesn't take sentences or other words", () => {
    expect(isShopKeyword(rapidito, "rapidito por favor necesito arroz")).toBe(false);
    expect(isShopKeyword(rapidito, "hola")).toBe(false);
    expect(isShopKeyword(rapidito, "")).toBe(false);
  });
  it("works with the default name", () => {
    expect(isShopKeyword({ shopName: "Catálogo express", shopButton: "🛒 CATÁLOGO EXPRESS" }, "catalogo express")).toBe(true);
  });
});
