import { describe, expect, it } from "vitest";
import { installableLine, listAsksInstallation } from "./install-offer";

describe("installableLine", () => {
  it("finds the first product usually installed", () => {
    expect(installableLine("1. 2 panes\n2. 1 chapa Yale para puerta")).toBe("1 chapa Yale para puerta");
    expect(installableLine("1. 1 llave de lavabo cromada")).toBe("1 llave de lavabo cromada");
    expect(installableLine("1. 2 tomacorrientes dobles\n2. 1 foco")).toBe("2 tomacorrientes dobles");
    expect(installableLine("1. 1 galón de pintura blanca")).toBe("1 galón de pintura blanca");
    expect(installableLine("1. 1 calefón a gas")).toBe("1 calefón a gas");
  });

  it("leaves out tools and things with the same name", () => {
    expect(installableLine("1. 1 llave inglesa\n2. 1 juego de llaves allen")).toBeNull();
    expect(installableLine("1. 1 caja de pinturas de colores")).toBeNull();
    expect(installableLine("1. 1 lámpara de escritorio")).toBeNull();
    expect(installableLine("1. 3 llaveros")).toBeNull();
    expect(installableLine("1. 2 leches\n2. 1 detergente")).toBeNull();
  });

  it("skips a line that already asks for installation", () => {
    expect(installableLine("1. 1 chapa con instalación")).toBeNull();
    expect(listAsksInstallation("1. 1 chapa\n2. con instalación")).toBe(true);
  });
});
