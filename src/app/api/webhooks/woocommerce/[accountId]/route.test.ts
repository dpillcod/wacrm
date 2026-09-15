import { describe, it, expect } from "vitest";
import crypto from "crypto";
import { isValidWooCommerceSignature } from "./route";

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
