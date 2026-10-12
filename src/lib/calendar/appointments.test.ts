import { describe, expect, it } from "vitest";
import {
  addressFromNotes,
  appointmentKind,
  confirmationText,
  formatWhen,
  localToUtc,
  timeZoneFor,
} from "./appointments";
import { DEFAULT_BUSINESS_SETTINGS } from "../business/settings";

const biz = { ...DEFAULT_BUSINESS_SETTINGS, utcOffsetHours: -5 };

describe("appointments", () => {
  it("knows the kind of card", () => {
    expect(appointmentKind(biz.serviceBoard.pipelineName, biz, "Servicio N° S-0003 — Ana", null)).toBe("service");
    expect(appointmentKind("Pedidos", biz, "Pedido N° 0012 — Ana", "ENCARGO PASTELERÍA N° 0012 — Torta")).toBe("bakery");
    expect(appointmentKind("Pedidos", biz, "Pedido N° 0013 — Luis", "Lista: 2 leches")).toBe("order");
  });
  it("turns Ecuador local time into the instant and back into words", () => {
    const d = localToUtc("2026-10-18T15:00", -5)!;
    expect(d.toISOString()).toBe("2026-10-18T20:00:00.000Z");
    expect(timeZoneFor(biz)).toBe("America/Guayaquil");
    expect(formatWhen(d, biz)).toMatch(/domingo,? 18 de octubre, 15:00/);
    expect(localToUtc("mañana en la tarde", -5)).toBeNull();
  });
  it("finds the address in the card notes", () => {
    expect(addressFromNotes("Trabajo: fuga\nDirección: Av. Loja 1-23 y Remigio\nHorario: Mañana")).toBe("Av. Loja 1-23 y Remigio");
    expect(addressFromNotes("sin dirección aquí")).toBeUndefined();
  });
  it("writes the customer's confirmation", () => {
    const text = confirmationText("service", "Servicio N° S-0003 — Ana", "jueves 15 de octubre, 10:00");
    expect(text).toContain("*Servicio N° S-0003*");
    expect(text).toContain("la visita de nuestro técnico para el *jueves 15 de octubre, 10:00*");
    expect(text).toContain("escríbanos *OK*");
  });
});
