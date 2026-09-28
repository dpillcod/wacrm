import { describe, expect, it } from "vitest";
import {
  extractJson,
  hintQuery,
  parseApplyResponse,
  parseDuplicatesResponse,
  parseEditResponse,
  parseReviewResponse,
  replaceTrailingLines,
} from "./order-clarify";

describe("extractJson", () => {
  it("finds the JSON object even with text around it", () => {
    expect(extractJson('Claro:\n{"lines": ["a"], "question": null}\nListo')).toEqual({
      lines: ["a"],
      question: null,
    });
  });

  it("returns null for non-JSON output", () => {
    expect(extractJson("no sé")).toBeNull();
    expect(extractJson("{roto")).toBeNull();
  });
});

describe("parseReviewResponse", () => {
  it("accepts one line per input line plus an optional question", () => {
    const raw = JSON.stringify({
      lines: ["1 Coca-Cola grande", "10 panes de agua"],
      question: "¿La Coca-Cola la desea de 2 o de 3 litros?",
    });
    expect(parseReviewResponse(raw, 2)).toEqual({
      lines: ["1 Coca-Cola grande", "10 panes de agua"],
      question: "¿La Coca-Cola la desea de 2 o de 3 litros?",
    });
  });

  it("treats an empty question as no question", () => {
    expect(parseReviewResponse('{"lines": ["1 arroz"], "question": " "}', 1)?.question).toBeNull();
  });

  it("rejects a response that drops or merges lines — an item could be lost", () => {
    expect(parseReviewResponse('{"lines": ["1 coca y 1 pan"], "question": null}', 2)).toBeNull();
  });
});

describe("parseApplyResponse", () => {
  it("allows the answer to add items but never to lose any", () => {
    expect(parseApplyResponse('{"lines": ["a", "b", "c"]}', 2)).toEqual(["a", "b", "c"]);
    expect(parseApplyResponse('{"lines": ["a"]}', 2)).toBeNull();
  });
});

describe("replaceTrailingLines", () => {
  it("swaps only the last batch of lines", () => {
    expect(replaceTrailingLines("1 arroz\n1 coca grande\n1 foco", 2, ["1 Coca-Cola 3 litros", "1 foco LED 12W"]))
      .toBe("1 arroz\n1 Coca-Cola 3 litros\n1 foco LED 12W");
  });

  it("handles a batch covering the whole list", () => {
    expect(replaceTrailingLines("1 coca", 1, ["1 Coca-Cola 2 litros"])).toBe("1 Coca-Cola 2 litros");
  });
});

describe("hintQuery", () => {
  it("drops the quantity and vague size words before searching the catalog", () => {
    expect(hintQuery("1 coca cola grande")).toBe("coca cola");
    expect(hintQuery("una leche de funda")).toBe("leche funda");
  });

  it("falls back to the raw line if nothing meaningful is left", () => {
    expect(hintQuery("2 grandes")).toBe("2 grandes");
  });
});

describe("parseEditResponse", () => {
  it("accepts an edited list, which may be shorter or longer", () => {
    expect(parseEditResponse('{"lines": ["1 Coca-Cola de 3 litros", "12 panes"], "understood": true}'))
      .toEqual(["1 Coca-Cola de 3 litros", "12 panes"]);
  });

  it("returns null when the model didn't understand the change", () => {
    expect(parseEditResponse('{"lines": ["a"], "understood": false}')).toBeNull();
    expect(parseEditResponse('{"lines": [], "understood": true}')).toBeNull();
  });
});

describe("parseDuplicatesResponse", () => {
  it("returns the question, or null when there are no duplicates", () => {
    expect(parseDuplicatesResponse('{"question": "¿Suma el queso?"}')).toBe("¿Suma el queso?");
    expect(parseDuplicatesResponse('{"question": null}')).toBeNull();
  });
});
