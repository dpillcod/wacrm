import { describe, expect, it } from "vitest";
import { feedToProducts, normalizeSearch, parseCsv, parsePrice, searchWords, thumbnailUrl } from "./feed";

describe("parseCsv", () => {
  it("handles quotes, commas, doubled quotes and line breaks", () => {
    const csv = 'id,title\r\n1,"Pintura, blanca"\n2,"NUTRIMALTA 550CC "" INCLUIDO"\n3,"dos\nlíneas"\n';
    expect(parseCsv(csv)).toEqual([
      ["id", "title"],
      ["1", "Pintura, blanca"],
      ["2", 'NUTRIMALTA 550CC " INCLUIDO'],
      ["3", "dos\nlíneas"],
    ]);
  });
});

describe("parsePrice", () => {
  it("reads the feed's price format", () => {
    expect(parsePrice("1.25 USD")).toBe(1.25);
    expect(parsePrice("17.2 USD")).toBe(17.2);
    expect(parsePrice("")).toBeNull();
    expect(parsePrice("gratis")).toBeNull();
  });
});

describe("feedToProducts", () => {
  const header = ["id", "title", "description", "availability", "condition", "price", "link", "image_link", "brand", "inventory", "custom_label_0", "sale_price"];
  const row = (o: Record<string, string>) => header.map((h) => o[h] ?? "");
  it("maps rows, splits section / category and skips bad rows", () => {
    const products = feedToProducts([
      header,
      row({ id: "0012", title: "ARROBA DE ARROZ  MIL UNO", price: "17.25 USD", availability: "in stock", image_link: "https://shop.example.com/wp-content/uploads/2026/08/0012.jpg", custom_label_0: "Abarrotes / Granos y Cereales", sale_price: "15.00 USD" }),
      row({ id: "0012", title: "duplicado", price: "1.00 USD" }),
      row({ id: "", title: "sin código", price: "1.00 USD" }),
      row({ id: "9", title: "sin precio", price: "0.00 USD" }),
      row({ id: "10", title: "Agotado", price: "2.00 USD", availability: "out of stock", brand: "Bazar", image_link: "http://inseguro/x.jpg" }),
    ]);
    expect(products).toHaveLength(2);
    expect(products[0]).toMatchObject({
      sku: "0012",
      title: "ARROBA DE ARROZ MIL UNO",
      price: 17.25,
      sale_price: 15,
      department: "Abarrotes",
      category: "Granos y Cereales",
      in_stock: true,
    });
    expect(products[0].search_text).toContain("arroz");
    expect(products[1]).toMatchObject({ department: "Bazar", category: null, in_stock: false, image_url: null });
  });
  it("ignores a sale price that isn't lower", () => {
    const [p] = feedToProducts([header, row({ id: "1", title: "x", price: "2.00 USD", sale_price: "3.00 USD" })]);
    expect(p.sale_price).toBeNull();
  });
});

describe("search text", () => {
  it("is accent-free and the typed words are safe for LIKE", () => {
    expect(normalizeSearch("Atún  VAN CAMP'S 140GR")).toBe("atun van camp s 140gr");
    expect(searchWords("  Leche   NUTRI 100% ")).toEqual(["leche", "nutri", "100"]);
  });
});

describe("thumbnailUrl", () => {
  it("points WordPress photos at their 300x300 thumbnail", () => {
    expect(thumbnailUrl("https://shop.example.com/wp-content/uploads/2026/08/0012.jpg")).toBe(
      "https://shop.example.com/wp-content/uploads/2026/08/0012-300x300.jpg",
    );
    expect(thumbnailUrl("https://shop.example.com/wp-content/uploads/2026/08/a-600x600.png")).toBe(
      "https://shop.example.com/wp-content/uploads/2026/08/a-300x300.png",
    );
    expect(thumbnailUrl("https://otra.com/foto.jpg")).toBe("https://otra.com/foto.jpg");
    expect(thumbnailUrl(null)).toBeNull();
  });
});
