import { describe, expect, it } from "vitest";
import { catalogOrderLines, keepCatalogLines, listTotal, money, totalLine } from "./order-lines";

const products = new Map([
  ["722008000218", { sku: "722008000218", title: "ATUN VANCAMPS  140GR", price: 1.3, salePrice: null }],
  ["0012", { sku: "0012", title: "ARROBA DE ARROZ MIL UNO", price: 17.25, salePrice: 15 }],
]);

describe("catalogOrderLines", () => {
  it("builds lines from the server's prices, with codes, and a total", () => {
    const r = catalogOrderLines(
      [{ sku: "722008000218", qty: 2 }, { sku: "0012", qty: 1 }, { sku: "nope", qty: 1 }, { sku: "0012", qty: 5 }, { sku: "722008000218", qty: 0 }],
      products,
    );
    expect(r.lines).toEqual([
      "2 × ATUN VANCAMPS 140GR · $1,30 c/u (cód. 722008000218)",
      "1 × ARROBA DE ARROZ MIL UNO · $15,00 c/u (cód. 0012)",
    ]);
    expect(r.total).toBe(17.6);
    expect(r.missing).toEqual(["nope"]);
  });
  it("caps silly quantities", () => {
    const r = catalogOrderLines([{ sku: "0012", qty: 1e9 }], products);
    expect(r.lines[0].startsWith("999 ×")).toBe(true);
  });
});

describe("listTotal / totalLine", () => {
  it("adds the priced lines and counts the typed ones", () => {
    const list = [
      "2 × ATUN VANCAMPS 140GR · $1,30 c/u (cód. 722008000218)",
      "3 × ARROBA DE ARROZ MIL UNO · $15,00 c/u (cód. 0012)",
      "1 libra de queso fresco",
    ].join("\n");
    expect(listTotal(list)).toEqual({ total: 47.6, priced: 2, unpriced: 1 });
    expect(totalLine(list)).toContain("Total estimado: $47,60");
    expect(totalLine(list)).toContain("+ 1 producto por confirmar");
  });
  it("shows nothing when no line has a price", () => {
    expect(totalLine("2 panes\n1 leche")).toBe("");
  });
  it("formats money the local way", () => {
    expect(money(1234.5)).toBe("$1234,50");
  });
});

describe("keepCatalogLines", () => {
  const before = [
    "1 × FOCO LED 12W SYLVANIA · $2,50 c/u (cód. 0012)",
    "2 × ATÚN VANCAMPS 140GR · $1,30 c/u (cód. 722008000218)",
    "1 libra de queso",
  ];
  it("puts back price and code on lines the AI reworded, with the new quantity", () => {
    expect(keepCatalogLines(before, ["1 Foco LED 12W Sylvania", "3 Atun Vancamps 140gr", "1 libra de queso", "2 Pilas AA"])).toEqual([
      "1 × FOCO LED 12W SYLVANIA · $2,50 c/u (cód. 0012)",
      "3 × ATÚN VANCAMPS 140GR · $1,30 c/u (cód. 722008000218)",
      "1 libra de queso",
      "2 Pilas AA",
    ]);
  });
  it("keeps untouched lines, drops removed ones, and leaves typed lists alone", () => {
    expect(keepCatalogLines(before, [before[1], "2 Pilas AA"])).toEqual([before[1], "2 Pilas AA"]);
    expect(keepCatalogLines(["2 panes"], ["3 panes"])).toEqual(["3 panes"]);
  });
  it("matches by code too", () => {
    expect(keepCatalogLines(before, ["5 del código 0012"])[0]).toBe("5 × FOCO LED 12W SYLVANIA · $2,50 c/u (cód. 0012)");
  });
});
