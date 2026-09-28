import { describe, it, expect } from "vitest";
import crypto from "crypto";
import { capItemsSummary, isValidWooCommerceSignature } from "./route";

function sign(body: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(body, "utf8").digest("base64");
}

describe("isValidWooCommerceSignature", () => {
  const secret = "test-secret-123";
  const body = JSON.stringify({ id: 42, total: "10.00" });

  it("accepts a correctly-signed body", () => {
    expect(isValidWooCommerceSignature(body, sign(body, secret), secret)).toBe(
      true,
    );
  });

  it("rejects a signature computed with the wrong secret", () => {
    expect(
      isValidWooCommerceSignature(body, sign(body, "wrong-secret"), secret),
    ).toBe(false);
  });

  it("rejects a signature for a different body (tampered payload)", () => {
    const otherBody = JSON.stringify({ id: 42, total: "999.00" });
    expect(
      isValidWooCommerceSignature(body, sign(otherBody, secret), secret),
    ).toBe(false);
  });

  it("rejects a missing signature", () => {
    expect(isValidWooCommerceSignature(body, null, secret)).toBe(false);
  });

  it("rejects a malformed/short signature without throwing", () => {
    expect(isValidWooCommerceSignature(body, "not-base64-hmac", secret)).toBe(
      false,
    );
  });
});

describe("capItemsSummary", () => {
  it("leaves a normal order untouched", () => {
    expect(capItemsSummary("2x Coca-Cola 3 litros, 1x Pan")).toBe("2x Coca-Cola 3 litros, 1x Pan");
  });

  it("cuts a very long order at an item boundary", () => {
    const long = Array.from({ length: 100 }, (_, i) => `1x Producto número ${i}`).join(", ");
    const capped = capItemsSummary(long);
    expect(capped.length).toBeLessThan(700);
    expect(capped).toMatch(/Producto número \d+… \(ver pedido completo en la web\)$/);
  });
});
