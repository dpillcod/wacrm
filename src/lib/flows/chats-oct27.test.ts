import { describe, expect, it } from "vitest";
import { isFormalQuoteRequest, isHelpNudge, isOrderCancel, isWebsiteChatGreeting, isSharedLocation, isVendorPitch } from "./engine";
import { acceptOfferedProduct, looksLikeQuestion } from "./question-answer";

// Phrases from the conversations of Oct 21-27.
describe("conversations of Oct 21-27", () => {
  it("reads requests worded as hopes as questions, not products", () => {
    expect(looksLikeQuestion("Tal vez dispongan de un cortador de espama flex")).toBe(true);
    expect(looksLikeQuestion("Veci talvez me pueda ayudar con una entrega a domicilio")).toBe(true);
    expect(looksLikeQuestion("Me confirma")).toBe(true);
    // An order with the same openers stays an order.
    expect(looksLikeQuestion("Veci de pronto pernos para sujertar el lavamanos y el Pedestal")).toBe(false);
    expect(looksLikeQuestion("2 libras de arroz")).toBe(false);
  });

  it("'me confirma' / 'sí, por favor' accept the product just offered", () => {
    expect(acceptOfferedProduct("Me confirma", "cable flexible AWG 16")).toBe("1 cable flexible AWG 16");
    expect(acceptOfferedProduct("Sí, por favor", "cable flexible AWG 16")).toBe("1 cable flexible AWG 16");
    expect(acceptOfferedProduct("sí, 8 metros", "cable flexible AWG 16")).toBe("8 metros cable flexible AWG 16");
  });

  it("drops the order on 'ya no necesito'", () => {
    expect(isOrderCancel("Gracias ya no necesito")).toBe(true);
    expect(isOrderCancel("olvídelo")).toBe(true);
    expect(isOrderCancel("como no me respondieron ya me fui a comprar")).toBe(true);
    expect(isOrderCancel("ya no hay leche?")).toBe(false);
    expect(isOrderCancel("2 cubetas de huevos")).toBe(false);
  });

  it("recognizes a shared location", () => {
    expect(isSharedLocation("https://maps.google.com/?q=-2.9063575267792,-79.041221618652")).toBe(true);
    expect(isSharedLocation("Cantón Chordeleg, Cuenca, Ecuador - https://maps.google.com/?q=-2.905189,-79.044715")).toBe(true);
    expect(isSharedLocation("le mando la ubicación")).toBe(false);
  });

  it("a quote for a building job goes to a person", () => {
    expect(isFormalQuoteRequest("Necesito cotizar un pedido para una obra que tengo en Pacha")).toBe(true);
    expect(isFormalQuoteRequest("Si me puede enviar una proforma")).toBe(true);
    expect(isFormalQuoteRequest("quiero cotizar")).toBe(false);
    expect(isFormalQuoteRequest("Hola Ferrotienda 🏢 quiero cotizar canastas navideñas para mi empresa")).toBe(true);
  });

  it("a salesperson offering a bot is a vendor, not a customer", () => {
    expect(
      isVendorPitch("Hola, buen día 👋 Soy Nicolay, de Atlántida Soluciones. Vi que atienden a sus clientes por WhatsApp y quería contarles de un asistente que estamos probando"),
    ).toBe(true);
    expect(isVendorPitch("Buenas tardes, quisiera saber si tienen tablas de 20")).toBe(false);
  });

  it("'¿me puede ayudar?' after asking a price is still waiting", () => {
    expect(isHelpNudge("Me puede ayudar?")).toBe(true);
    expect(isHelpNudge("Hola?")).toBe(true);
    expect(isHelpNudge("hola")).toBe(false);
    expect(isHelpNudge("me puede ayudar con 2 libras de arroz")).toBe(false);
  });

  it("the website chat button's own text is a greeting", () => {
    expect(isWebsiteChatGreeting("Hola *ferrotiendaec.com*! Necesito más información sobre ferrotiendaec.com https://ferrotiendaec.com/")).toBe(true);
    expect(
      isWebsiteChatGreeting("Hola *ferrotiendaec.com*! Necesito más información sobre Resultados de la búsqueda de «planchas de policarbonato» https://ferrotiendaec.com/"),
    ).toBe(false);
  });
});
