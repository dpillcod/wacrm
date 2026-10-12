import { describe, expect, it } from "vitest";
import en from "../../messages/en.json";
import es from "../../messages/es.json";

// Every dictionary must have exactly the keys of en.json, and each text the
// same variables ({count}, {name}…) and tags (<bold>…) — a new English text
// without its translation fails here instead of showing up in English.

type Tree = { [key: string]: string | Tree };

function flatten(tree: Tree, prefix = "", out: Record<string, string> = {}): Record<string, string> {
  for (const [k, v] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") out[path] = v;
    else flatten(v, path, out);
  }
  return out;
}

/** Top-level ICU argument names ({count}, {name}; the words inside plural branches are translated). */
function argNames(text: string): string {
  const names: string[] = [];
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") {
      if (depth === 0) {
        const m = text.slice(i).match(/^\{+\s*([^{},\s]+)/);
        if (m) names.push(m[1]);
      }
      depth++;
    } else if (text[i] === "}") {
      depth = Math.max(0, depth - 1);
    }
  }
  return names.sort().join("|");
}

const tags = (text: string) => (text.match(/<\/?[a-zA-Z]+/g) ?? []).sort().join("|");

const english = flatten(en as Tree);

describe.each([["es", es]])("messages/%s.json", (_locale, dict) => {
  const translated = flatten(dict as Tree);

  it("has every key of en.json and nothing else", () => {
    expect(Object.keys(translated).sort()).toEqual(Object.keys(english).sort());
  });

  it("keeps each text's variables and tags", () => {
    const broken = Object.keys(english).filter(
      (k) => k in translated && (argNames(english[k]) !== argNames(translated[k]) || tags(english[k]) !== tags(translated[k])),
    );
    expect(broken).toEqual([]);
  });
});
