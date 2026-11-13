import { describe, expect, it } from "vitest";
import {
  bigQuantityLine,
  claimsWrittenDown,
  deliveryDestination,
  isAboutToSendData,
  isPhotoOfProductRequest,
  isQuoteOnly,
  offeredLine,
} from "./engine";
import { matchingAsked } from "./model-options";
import { isPriceQuestion } from "./price-question";

describe("chats of Nov 12", () => {
  it("only a quote is not a change to the list", () => {
    expect(isQuoteOnly("solo necesito una cotizacion")).toBe(true);
    expect(isQuoteOnly("Es solo una cotización")).toBe(true);
    expect(isQuoteOnly("solo quiero saber el precio")).toBe(true);
    expect(isQuoteOnly("necesito un presupuesto")).toBe(true);
    expect(isQuoteOnly("2 sacos de cemento")).toBe(false);
    expect(isQuoteOnly("Quisiera saber cotización de baldes 5 galones llanos blancos")).toBe(false);
  });

  it("knows when the AI said it wrote the product down", () => {
    expect(claimsWrittenDown("Buenas tardes, claro que sí. Le anoto el pedido: 200 sacos de cemento Holcim.")).toBe(true);
    expect(claimsWrittenDown("Perfecto, anotamos comida para perro adulto, el formato más grande.")).toBe(true);
    expect(claimsWrittenDown("Sí, lo manejamos 🙂 ¿Se lo anoto?")).toBe(false);
    expect(claimsWrittenDown("Sí, hacemos envíos con motorizado.")).toBe(false);
  });

  it("keeps the customer's quantity on the noted line", () => {
    expect(offeredLine("me puede ayudar cotizando 200 sacos de cemento holcim ?", "cemento Holcim")).toBe("200 sacos de cemento Holcim");
    expect(offeredLine("el buen can de funda amarilla", "comida para perro adulto")).toBe("comida para perro adulto");
    expect(offeredLine("baldes 5 galones blancos", "baldes de 5 galones blancos")).toBe("baldes de 5 galones blancos");
    expect(offeredLine("quiero 3 fundas", "fundas de basura")).toBe("3 fundas de basura");
  });

  it("flags a big order", () => {
    expect(bigQuantityLine("200 sacos de cemento Holcim")).toBe("200 sacos de cemento Holcim");
    expect(bigQuantityLine("1 leche\n100 baldes de 5 galones")).toBe("100 baldes de 5 galones");
    expect(bigQuantityLine("3500 gramos de carne molida")).toBeNull();
    expect(bigQuantityLine("10 panes")).toBeNull();
  });

  it("reads where to deliver", () => {
    expect(deliveryDestination("a domicilio, pero fuera de cuenca")).toEqual({ note: "fuera de Cuenca", outside: true });
    expect(deliveryDestination("es para enviar a Guayaquil")).toEqual({ note: "fuera de Cuenca (Guayaquil)", outside: true });
    expect(deliveryDestination("Azogues")).toEqual({ note: "fuera de Cuenca (Azogues)", outside: true });
    expect(deliveryDestination("a domicilio")).toEqual({ note: "a domicilio", outside: false });
    expect(deliveryDestination("2 colas")).toBeNull();
    expect(deliveryDestination("cemento holcim")).toBeNull();
  });

  it("'¿qué valor tendrían?' is a price question", () => {
    expect(isPriceQuestion("Las 100 unidades que valor tendrían")).toBe(true);
  });

  it("a request for a photo of the model", () => {
    expect(isPhotoOfProductRequest("Me puede enviar una foto del modelo que dispone")).toBe(true);
    expect(isPhotoOfProductRequest("mándeme una fotito")).toBe(true);
    expect(isPhotoOfProductRequest("2 borlas blancas")).toBe(false);
  });

  it("'te mando los datos' means wait", () => {
    expect(isAboutToSendData("Te mando los fatos")).toBe(true);
    expect(isAboutToSendData("un momento por favor")).toBe(true);
    expect(isAboutToSendData("Juan Pacheco 0104845359")).toBe(false);
  });

  it("models fit the size and color asked", () => {
    const names = ["BALDE 5 GALONES AMARILLO", "BALDE 02 GALONES C/TAPA CLARIFICADA REYPLAST", "BALDE 5 GALONES BLANCO", "BALDE 5 GALONES"];
    expect(matchingAsked("100 baldes de 5 galones blancos lisos", names)).toEqual(["BALDE 5 GALONES BLANCO", "BALDE 5 GALONES"]);
    expect(matchingAsked("1 cerradura de dormitorio", ["CERRADURA NOVA", "CERRADURA KWIKSET"])).toEqual(["CERRADURA NOVA", "CERRADURA KWIKSET"]);
  });
});
