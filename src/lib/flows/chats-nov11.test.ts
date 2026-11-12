import { describe, expect, it } from "vitest";
import { anyModelNote, isVendorPitch, pointsAtPhoto } from "./engine";
import { looksLikeQuestion } from "./question-answer";
import { findSeasonalReply } from "../business/seasonal-replies";

describe("chats of Nov 11", () => {
  it("waits for the photo a question points at", () => {
    expect(pointsAtPhoto("POR FAVOR NECESITO SABER SI DISPONE DE ESTAS BASES")).toBe(true);
    expect(pointsAtPhoto("Buenas tardes\nPor favor una consulta talvez disponen de este tipo de malla")).toBe(true);
    expect(pointsAtPhoto("¿Tienen algo así?")).toBe(true);
    expect(pointsAtPhoto("¿Cuánto está el arroz?")).toBe(false);
    expect(pointsAtPhoto("¿Está abierto hoy?")).toBe(false);
    expect(pointsAtPhoto("¿Tienen cemento?")).toBe(false);
  });

  it("'cualquiera' is a note for the advisor, not an ok", () => {
    expect(anyModelNote("CUALQUIERA")).toBe("cualquier modelo");
    expect(anyModelNote("cualquiera está bien")).toBe("cualquier modelo");
    expect(anyModelNote("el que tenga nomás")).toBe("cualquier modelo");
    expect(anyModelNote("el más barato por favor")).toBe("el más económico");
    expect(anyModelNote("ok")).toBeNull();
    expect(anyModelNote("2 libras de arroz")).toBeNull();
  });

  it("a supplier's video caption is a pitch", () => {
    expect(
      isVendorPitch("Chatbot/Agentes IA que venden 24/7 por WhatsApp Business. CRM para negocios/PYMES que saben que optimizar tiempo y recursos vale ORO"),
    ).toBe(true);
  });

  it("'necesito saber si dispone…' is a question", () => {
    expect(looksLikeQuestion("POR FAVOR NECESITO SABER SI DISPONE DE ESTAS BASES")).toBe(true);
  });

  it("'árbol de navidad' is a product, not the baskets", () => {
    const rules = [{ keywords: ["canasta", "canastas", "navidad", "navideñas"], reply: "🎄 canastas", until: "2026-11-30" }];
    expect(findSeasonalReply(rules, "una base para arbol de navidad", "2026-11-12")).toBeNull();
    expect(findSeasonalReply(rules, "tienen luces navideñas?", "2026-11-12")).toBeNull();
    expect(findSeasonalReply(rules, "que tienen para navidad?", "2026-11-12")?.index).toBe(0);
    expect(findSeasonalReply(rules, "quiero la canasta para el arbol de navidad", "2026-11-12")?.index).toBe(0);
  });
});
