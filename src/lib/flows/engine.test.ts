import { describe, it, expect } from "vitest";
import {
  matchReplyId,
  matchesKeywordTrigger,
  isRestartCommand,
  isStaffCheckInText,
  checkInReply,
  extractValidInput,
  optionByNumber,
  parseOptionNumber,
  numberLines,
  textFallbackOf,
  isBotAddressableNonText,
  isAutoAdvancing,
  isSuspending,
  isTerminal,
  evaluateConditionPredicate,
  parseLeadingQuantity,
} from "./engine";

describe("matchReplyId", () => {
  it("returns null for nodes without options", () => {
    expect(
      matchReplyId({ node_type: "start", config: { next_node_key: "x" } }, "y"),
    ).toBeNull();
    expect(
      matchReplyId({ node_type: "send_message", config: {} }, "y"),
    ).toBeNull();
    expect(matchReplyId({ node_type: "end", config: {} }, "y")).toBeNull();
  });

  it("matches the buttons array on a send_buttons node", () => {
    const node = {
      node_type: "send_buttons",
      config: {
        text: "Pick one",
        buttons: [
          { reply_id: "yes", title: "Yes", next_node_key: "confirmed" },
          { reply_id: "no", title: "No", next_node_key: "declined" },
        ],
      },
    };
    expect(matchReplyId(node, "yes")).toBe("confirmed");
    expect(matchReplyId(node, "no")).toBe("declined");
  });

  it("returns null when no button reply_id matches", () => {
    const node = {
      node_type: "send_buttons",
      config: {
        text: "Pick",
        buttons: [
          { reply_id: "a", title: "A", next_node_key: "to_a" },
          { reply_id: "b", title: "B", next_node_key: "to_b" },
        ],
      },
    };
    expect(matchReplyId(node, "c")).toBeNull();
    expect(matchReplyId(node, "")).toBeNull();
  });

  it("searches across all sections in a send_list node", () => {
    const node = {
      node_type: "send_list",
      config: {
        text: "Pick an order",
        button_label: "View",
        sections: [
          {
            title: "Recent",
            rows: [
              { reply_id: "o1", title: "Order 1", next_node_key: "ord_1" },
            ],
          },
          {
            title: "Older",
            rows: [
              { reply_id: "o2", title: "Order 2", next_node_key: "ord_2" },
              { reply_id: "o3", title: "Order 3", next_node_key: "ord_3" },
            ],
          },
        ],
      },
    };
    expect(matchReplyId(node, "o1")).toBe("ord_1");
    expect(matchReplyId(node, "o2")).toBe("ord_2");
    expect(matchReplyId(node, "o3")).toBe("ord_3");
    expect(matchReplyId(node, "o99")).toBeNull();
  });

  it("returns null when send_list has no sections / empty sections", () => {
    expect(
      matchReplyId(
        { node_type: "send_list", config: { text: "x", sections: [] } },
        "x",
      ),
    ).toBeNull();
    expect(
      matchReplyId(
        {
          node_type: "send_list",
          config: { text: "x", sections: [{ rows: [] }] },
        },
        "x",
      ),
    ).toBeNull();
  });
});

describe("parseLeadingQuantity", () => {
  it("splits a leading number off the rest of the text", () => {
    expect(parseLeadingQuantity("2 cocas")).toEqual({
      quantity: "2",
      rest: "cocas",
    });
    expect(parseLeadingQuantity("10 panes blancos")).toEqual({
      quantity: "10",
      rest: "panes blancos",
    });
  });

  it("returns a null quantity when there's no leading number", () => {
    expect(parseLeadingQuantity("coca cola")).toEqual({
      quantity: null,
      rest: "coca cola",
    });
  });

  it("treats a bare number with nothing after it as having no rest to search", () => {
    // No product text follows the number — falls back to searching the
    // whole trimmed string rather than an empty query.
    expect(parseLeadingQuantity("2")).toEqual({ quantity: null, rest: "2" });
  });

  it("trims surrounding whitespace", () => {
    expect(parseLeadingQuantity("  3   leches  ")).toEqual({
      quantity: "3",
      rest: "leches",
    });
  });
});

describe("matchesKeywordTrigger", () => {
  it("returns false for empty text", () => {
    expect(matchesKeywordTrigger("", { keywords: ["hi"] })).toBe(false);
  });

  it("returns false when keywords array is empty", () => {
    expect(matchesKeywordTrigger("anything", { keywords: [] })).toBe(false);
  });

  it("default match_type='contains' does case-insensitive substring", () => {
    const cfg = { keywords: ["support"] };
    expect(matchesKeywordTrigger("I need SUPPORT please", cfg)).toBe(true);
    expect(matchesKeywordTrigger("Support is great", cfg)).toBe(true);
    expect(matchesKeywordTrigger("Help me", cfg)).toBe(false);
  });

  it("match_type='exact' compares the whole string case-insensitively", () => {
    const cfg = { keywords: ["help"], match_type: "exact" as const };
    expect(matchesKeywordTrigger("help", cfg)).toBe(true);
    expect(matchesKeywordTrigger("HELP", cfg)).toBe(true);
    expect(matchesKeywordTrigger("help me", cfg)).toBe(false);
  });

  it("case_sensitive=true preserves case", () => {
    const cfg = {
      keywords: ["Support"],
      case_sensitive: true,
    };
    expect(matchesKeywordTrigger("I need Support", cfg)).toBe(true);
    expect(matchesKeywordTrigger("I need support", cfg)).toBe(false);
  });

  it("matches any one of multiple keywords", () => {
    const cfg = { keywords: ["help", "support", "issue"] };
    expect(matchesKeywordTrigger("I have an issue", cfg)).toBe(true);
    expect(matchesKeywordTrigger("I need Help!", cfg)).toBe(true);
    expect(matchesKeywordTrigger("nothing to see here", cfg)).toBe(false);
  });

  it("skips empty strings in the keywords array", () => {
    const cfg = { keywords: ["", "support", ""] };
    expect(matchesKeywordTrigger("support center", cfg)).toBe(true);
    expect(matchesKeywordTrigger("nope", cfg)).toBe(false);
  });
});

describe("matchesKeywordTrigger — whole words, accent-insensitive", () => {
  const cfg = { keywords: ["hola", "menú", "buenas tardes"] };

  it("no longer matches a keyword buried inside another word", () => {
    expect(matchesKeywordTrigger("2 cholas", cfg)).toBe(false);
    expect(matchesKeywordTrigger("1 libra de menudencia", { keywords: ["menu"] })).toBe(false);
  });

  it("matches regardless of accents and punctuation", () => {
    expect(matchesKeywordTrigger("¡Hola!", cfg)).toBe(true);
    expect(matchesKeywordTrigger("menu", cfg)).toBe(true);
    expect(matchesKeywordTrigger("Buenas tardes, una consulta", cfg)).toBe(true);
  });
});

describe("isRestartCommand", () => {
  const cfg = { keywords: ["hola", "menu", "ayuda"] };

  it("restarts on a short message that is essentially the command", () => {
    expect(isRestartCommand("Hola", cfg)).toBe(true);
    expect(isRestartCommand("menú por favor", cfg)).toBe(true);
  });

  it("does not restart on an order line that happens to include a keyword", () => {
    expect(isRestartCommand("hola, también quiero 2 panes", cfg)).toBe(false);
    expect(isRestartCommand("necesito ayuda con una llave de paso", cfg)).toBe(false);
  });
});

describe("isBotAddressableNonText", () => {
  it("covers catalog carts and voice notes/videos, not stickers", () => {
    expect(
      isBotAddressableNonText({ kind: "order", items: [], text: "", meta_message_id: "m" }),
    ).toBe(true);
    expect(
      isBotAddressableNonText({ kind: "other", message_type: "audio", media_url: null, meta_message_id: "m" }),
    ).toBe(true);
    expect(
      isBotAddressableNonText({ kind: "other", message_type: "sticker", media_url: null, meta_message_id: "m" }),
    ).toBe(false);
    expect(
      isBotAddressableNonText({ kind: "text", text: "hola", meta_message_id: "m" }),
    ).toBe(false);
  });
});

describe("option numbers typed instead of tapped", () => {
  const list = {
    node_type: "send_list",
    config: {
      sections: [
        { rows: [{ reply_id: "pedido", title: "Hacer un pedido", next_node_key: "a" }] },
        {
          rows: [
            { reply_id: "asesor", title: "Hablar con un asesor", next_node_key: "b" },
            { reply_id: "horario", title: "Horario y ubicación", next_node_key: "c" },
          ],
        },
      ],
    },
  };

  it("parses bare option numbers only", () => {
    expect(parseOptionNumber("2")).toBe(1);
    expect(parseOptionNumber(" 3) ")).toBe(2);
    expect(parseOptionNumber("2 cocas")).toBeNull();
    expect(parseOptionNumber("4️⃣")).toBe(3);
  });

  it("maps the number across list sections in display order", () => {
    expect(optionByNumber(list, "3")).toEqual({ reply_id: "horario", title: "Horario y ubicación" });
    expect(optionByNumber(list, "9")).toBeNull();
  });

  it("works for buttons and ignores other node types", () => {
    const buttons = {
      node_type: "send_buttons",
      config: { buttons: [{ reply_id: "x", title: "Agregar más", next_node_key: "a" }] },
    };
    expect(optionByNumber(buttons, "1")?.reply_id).toBe("x");
    expect(optionByNumber({ node_type: "collect_input", config: {} }, "1")).toBeNull();
  });
});

describe("textFallbackOf", () => {
  it("reads text_fallback from both buttons and lists", () => {
    const tf = { var_key: "order_text", next_node_key: "n" };
    expect(textFallbackOf({ node_type: "send_list", config: { text_fallback: tf } })).toBe(tf);
    expect(textFallbackOf({ node_type: "send_buttons", config: { text_fallback: tf } })).toBe(tf);
    expect(textFallbackOf({ node_type: "collect_input", config: { text_fallback: tf } })).toBeUndefined();
  });
});

describe("numberLines", () => {
  it("numbers non-empty lines", () => {
    expect(numberLines("2 coca cola\n\n1 foco led ")).toBe("1. 2 coca cola\n2. 1 foco led");
  });
});

describe("extractValidInput", () => {
  const cedula = { validation: "regex" as const, regex: String.raw`\b(\d{13}|\d{10})\b` };

  it("passes any text through by default", () => {
    expect(extractValidInput({}, "lo que sea")).toBe("lo que sea");
    expect(extractValidInput({ validation: "any" }, "x")).toBe("x");
  });

  it("captures just the valid part of the reply", () => {
    expect(extractValidInput(cedula, "mi cédula es 0105280069 gracias")).toBe("0105280069");
    expect(extractValidInput(cedula, "RUC 0105280069001")).toBe("0105280069001");
  });

  it("rejects a reply with nothing valid in it", () => {
    expect(extractValidInput(cedula, "🛒 *Nuevo Pedido - Ferrotienda* Pedido 45632")).toBeNull();
  });

  it("never blocks the customer on a broken pattern", () => {
    expect(extractValidInput({ validation: "regex", regex: "(" }, "hola")).toBe("hola");
  });
});

describe("staff check-in", () => {
  it("recognizes the clock-in words, accent- and case-insensitive", () => {
    expect(isStaffCheckInText("turno")).toBe(true);
    expect(isStaffCheckInText("  Turno! ")).toBe(true);
    expect(isStaffCheckInText("activar avisos")).toBe(true);
    expect(isStaffCheckInText("hola")).toBe(false);
    expect(isStaffCheckInText("mañana tengo turno")).toBe(false);
  });

  it("says until when (Ecuador time) the alerts are on", () => {
    // 13:15Z = 08:15 in Cuenca → active until 08:15 the next day.
    expect(checkInReply(new Date("2026-09-29T13:15:00Z"))).toContain("hasta mañana a las 08:15");
  });
});

describe("node classification helpers", () => {
  it("isAutoAdvancing covers start + send_message + send_media + send_cta_url + send_template + condition + set_tag", () => {
    expect(isAutoAdvancing("start")).toBe(true);
    expect(isAutoAdvancing("send_message")).toBe(true);
    expect(isAutoAdvancing("send_media")).toBe(true);
    expect(isAutoAdvancing("send_cta_url")).toBe(true);
    expect(isAutoAdvancing("send_template")).toBe(true);
    expect(isAutoAdvancing("condition")).toBe(true);
    expect(isAutoAdvancing("set_tag")).toBe(true);
    expect(isAutoAdvancing("send_buttons")).toBe(false);
    expect(isAutoAdvancing("send_list")).toBe(false);
    expect(isAutoAdvancing("collect_input")).toBe(false);
    expect(isAutoAdvancing("handoff")).toBe(false);
    expect(isAutoAdvancing("end")).toBe(false);
  });

  it("isSuspending covers the input-requiring nodes", () => {
    expect(isSuspending("send_buttons")).toBe(true);
    expect(isSuspending("send_list")).toBe(true);
    expect(isSuspending("collect_input")).toBe(true);
    expect(isSuspending("start")).toBe(false);
    expect(isSuspending("send_message")).toBe(false);
    expect(isSuspending("condition")).toBe(false);
    expect(isSuspending("set_tag")).toBe(false);
    expect(isSuspending("handoff")).toBe(false);
    expect(isSuspending("end")).toBe(false);
  });

  it("isTerminal covers handoff + end", () => {
    expect(isTerminal("handoff")).toBe(true);
    expect(isTerminal("end")).toBe(true);
    expect(isTerminal("start")).toBe(false);
    expect(isTerminal("send_buttons")).toBe(false);
    expect(isTerminal("condition")).toBe(false);
  });

  it("the three classifications are mutually exclusive for known node types", () => {
    const types = [
      "start",
      "send_message",
      "send_buttons",
      "send_list",
      "send_media",
      "send_cta_url",
      "send_template",
      "collect_input",
      "condition",
      "set_tag",
      "handoff",
      "end",
    ];
    for (const t of types) {
      const flags = [isAutoAdvancing(t), isSuspending(t), isTerminal(t)];
      // Exactly one of the three should be true for every known node.
      expect(flags.filter(Boolean).length).toBe(1);
    }
  });
});

describe("evaluateConditionPredicate", () => {
  it("present: true when subject has a value", () => {
    expect(
      evaluateConditionPredicate({
        operator: "present",
        subjectValue: "alice@example.com",
        configValue: undefined,
      }),
    ).toBe(true);
  });

  it("present: false when subject is undefined or empty", () => {
    expect(
      evaluateConditionPredicate({
        operator: "present",
        subjectValue: undefined,
        configValue: undefined,
      }),
    ).toBe(false);
    expect(
      evaluateConditionPredicate({
        operator: "present",
        subjectValue: "",
        configValue: undefined,
      }),
    ).toBe(false);
  });

  it("absent: inverse of present", () => {
    expect(
      evaluateConditionPredicate({
        operator: "absent",
        subjectValue: undefined,
        configValue: undefined,
      }),
    ).toBe(true);
    expect(
      evaluateConditionPredicate({
        operator: "absent",
        subjectValue: "x",
        configValue: undefined,
      }),
    ).toBe(false);
  });

  it("equals: exact string comparison; case-sensitive", () => {
    expect(
      evaluateConditionPredicate({
        operator: "equals",
        subjectValue: "VIP",
        configValue: "VIP",
      }),
    ).toBe(true);
    expect(
      evaluateConditionPredicate({
        operator: "equals",
        subjectValue: "vip",
        configValue: "VIP",
      }),
    ).toBe(false);
  });

  it("equals: undefined subject never matches (even against empty)", () => {
    expect(
      evaluateConditionPredicate({
        operator: "equals",
        subjectValue: undefined,
        configValue: "",
      }),
    ).toBe(false);
  });

  it("contains: substring match", () => {
    expect(
      evaluateConditionPredicate({
        operator: "contains",
        subjectValue: "support@example.com",
        configValue: "@example.com",
      }),
    ).toBe(true);
    expect(
      evaluateConditionPredicate({
        operator: "contains",
        subjectValue: "support@other.com",
        configValue: "@example.com",
      }),
    ).toBe(false);
  });

  it("contains: undefined subject never matches", () => {
    expect(
      evaluateConditionPredicate({
        operator: "contains",
        subjectValue: undefined,
        configValue: "anything",
      }),
    ).toBe(false);
  });
});
