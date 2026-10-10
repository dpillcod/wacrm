import { describe, expect, it } from "vitest";
import { cleanItems, usualFromLists } from "./carts";

describe("cleanItems", () => {
  it("keeps valid items once, capped", () => {
    expect(cleanItems([{ sku: "a", qty: 2 }, { sku: "a", qty: 3 }, { sku: "", qty: 1 }, { sku: "b", qty: 0 }, { sku: "c", qty: 5000 }, null, "x"])).toEqual([
      { sku: "a", qty: 3 },
      { sku: "c", qty: 999 },
    ]);
    expect(cleanItems("nope")).toEqual([]);
  });
});

describe("usualFromLists", () => {
  it("ranks catalog products by how many orders had them, then by recency", () => {
    const newest = "2 × LECHE NUTRI · $0,99 c/u (cód. 786)\n1 libra de queso\n3 × PAN · $0,22 c/u (cód. pan)";
    const older = "1 × LECHE NUTRI · $0,99 c/u (cód. 786)\n1 × ATUN · $1,30 c/u (cód. 722)";
    expect(usualFromLists([newest, older])).toEqual([
      { sku: "786", orders: 2, lastQty: 2 },
      { sku: "pan", orders: 1, lastQty: 3 },
      { sku: "722", orders: 1, lastQty: 1 },
    ]);
  });
  it("ignores typed lines", () => {
    expect(usualFromLists(["2 panes\n1 leche"])).toEqual([]);
  });
});
