import { describe, expect, it } from "vitest";
import {
  billingLine,
  FINAL_CONSUMER,
  greetingName,
  isFinalConsumer,
  isRefusal,
  looksLikePersonName,
  parseCustomerProfile,
  profileProblemText,
  validCedula,
  validRuc,
} from "./customer-profile";

describe("Ecuadorian ID numbers", () => {
  it("checks the cédula's province and check digit", () => {
    expect(validCedula("0102030400")).toBe(true);
    expect(validCedula("1700000001")).toBe(true);
    expect(validCedula("0102030401")).toBe(false);
    expect(validCedula("9902030400")).toBe(false);
    expect(validCedula("010203040")).toBe(false);
  });
  it("accepts a person's RUC (cédula + 001) and company RUCs", () => {
    expect(validRuc("0102030400001")).toBe(true);
    expect(validRuc("0102030401001")).toBe(false);
    expect(validRuc("0190012345001")).toBe(true);
    expect(validRuc("0102030400002")).toBe(false);
  });
});

describe("parseCustomerProfile", () => {
  it("reads the form", () => {
    const r = parseCustomerProfile({ fields: { nombre: "  juan carlos PÉREZ lópez ", cedula: "0102030400", correo: "Juan@Mail.com" } }, "593");
    expect(r).toEqual({ ok: true, profile: { name: "Juan Carlos Pérez López", idNumber: "0102030400", email: "juan@mail.com" } });
  });
  it("reads a typed message in any order", () => {
    const r = parseCustomerProfile({ text: "juan@mail.com\nCédula: 010203040-0\nNombre: Ana María Torres" }, "593");
    expect(r).toEqual({ ok: true, profile: { name: "Ana María Torres", idNumber: "0102030400", email: "juan@mail.com" } });
  });
  it("says what's wrong or still missing", () => {
    const bad = parseCustomerProfile({ text: "Ana Torres 0102030401 ana@mail.com" }, "593");
    expect(bad).toEqual({ ok: false, problem: "id", bad: "0102030401" });
    expect(profileProblemText(bad as never)).toContain("*0102030401* no es válida");
    expect(parseCustomerProfile({ text: "Ana Torres 0102030400" }, "593")).toEqual({ ok: false, problem: "missing", missing: ["email"] });
    expect(parseCustomerProfile({ text: "Ana 0102030400 ana@mail.com" }, "593")).toEqual({ ok: false, problem: "missing", missing: ["name"] });
    const onlyName = parseCustomerProfile({ text: "Luis Alberto Quito Peña" }, "593");
    expect(onlyName).toEqual({ ok: false, problem: "missing", missing: ["id", "email"] });
    expect(profileProblemText(onlyName as never)).toBe("Gracias 🙂 Me falta su cédula o RUC y su correo para la factura.");
    expect(parseCustomerProfile({ text: "" }, "593")).toEqual({ ok: false, problem: "missing", missing: ["name", "id", "email"] });
  });
  it("uses the latest data when it's typed again after a correction", () => {
    const text = "Ana María Torres ana@correo.com\nAna María Torres 0102030400 ana@correo.com";
    expect(parseCustomerProfile({ text }, "593")).toEqual({
      ok: true,
      profile: { name: "Ana María Torres", idNumber: "0102030400", email: "ana@correo.com" },
    });
    expect(parseCustomerProfile({ text: "Luis Alberto Quito Peña\n0102030400\nluis@correo.com" }, "593")).toEqual({
      ok: true,
      profile: { name: "Luis Alberto Quito Peña", idNumber: "0102030400", email: "luis@correo.com" },
    });
  });
  it("tells a refusal apart", () => {
    expect(isRefusal("No acepto")).toBe(true);
    expect(isRefusal("no")).toBe(true);
    expect(isRefusal("Noemí Torres 0102030400")).toBe(false);
  });
  it("takes 'consumidor final'", () => {
    expect(isFinalConsumer("Consumidor final")).toBe(true);
    expect(parseCustomerProfile({ text: "consumidor final" }, "593")).toEqual({
      ok: true,
      profile: { name: "", idNumber: FINAL_CONSUMER, email: "" },
    });
  });
});

describe("greetingName / billingLine", () => {
  it("greets by first name, or both given names in a four-part name", () => {
    expect(greetingName("Juan Carlos Pérez López")).toBe("Juan Carlos");
    expect(greetingName("Ana Torres")).toBe("Ana");
    expect(greetingName("María José Andrade")).toBe("María");
  });
  it("shows the invoice data on one line", () => {
    expect(billingLine({ name: "Ana Torres", idNumber: "0102030400", email: "a@b.co" })).toBe("Ana Torres · 0102030400 · a@b.co");
    expect(billingLine({ name: "", idNumber: FINAL_CONSUMER, email: "" })).toBe("Consumidor final");
  });
});

describe("the name among everything typed while registering", () => {
  it("keeps the name written next to the ID number (real case)", () => {
    const typed = [
      "Cucharás pequeñas",
      "No gafas",
      "Necesito 6 paquetes",
      "Solo 5 paquetes Perdon",
      "Pamela Gárate",
      "0106507981",
      "Cusnto sale ?",
      "Voy a psar viendo de su tienda",
      "pamelagarate1999@gmail.com",
    ].join("\n");
    const p = parseCustomerProfile({ text: typed }, "593");
    expect(p.ok && p.profile.name).toBe("Pamela Gárate");
  });

  it("tells names from sentences", () => {
    expect(looksLikePersonName("Pamela Gárate")).toBe(true);
    expect(looksLikePersonName("María de los Ángeles Pérez")).toBe(true);
    expect(looksLikePersonName("Voy a psar viendo de su tienda")).toBe(false);
    expect(looksLikePersonName("Solo 5 paquetes Perdon")).toBe(false);
    expect(looksLikePersonName("Cucharás pequeñas")).toBe(true); // two plain words: allowed, but…
  });

  it("…a name next to the ID beats a later two-word line", () => {
    const p = parseCustomerProfile({ text: "Juan Pérez 0102030400\nCucharas pequeñas\njuan@mail.com" }, "593");
    expect(p.ok && p.profile.name).toBe("Juan Pérez");
  });
});

describe("a shared location is not an ID number", () => {
  it("ignores coordinates while registering", () => {
    const p = parseCustomerProfile({ text: "-2.907023191452,-79.042709350586" }, "593");
    expect(p.ok).toBe(false);
    expect(!p.ok && p.problem).toBe("missing");
  });
});
