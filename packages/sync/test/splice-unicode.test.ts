/**
 * Audit STO-001. `diffSplice` compares UTF-16 code units, and every emoji in
 * U+1F400–U+1F7FF starts with the same high surrogate (\uD83D). Swapping 🔴
 * for 🟢 made the common prefix stop BETWEEN the two halves of the pair; Yjs
 * will not split a surrogate pair and turns both halves into U+FFFD, and that
 * text was what `write()` put in the vault. These tests hold the splice to
 * whole code points, emoji by emoji and on random text.
 */
import { describe, expect, it } from "vitest";
import { createNoteDoc, diffSplice, docContent, SpliceMismatchError, updateDocContent } from "../src/index.js";

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/** The doc, spliced from `from` to `to`, must read exactly `to`. */
const roundTrip = (from: string, to: string) => {
  const doc = createNoteDoc(from);
  updateDocContent(doc, to);
  return docContent(doc);
};

/** A splice that starts or ends inside a surrogate pair, on either side. */
const cutsAPair = (oldStr: string, newStr: string): boolean => {
  const d = diffSplice(oldStr, newStr);
  if (!d) return false;
  const inside = (s: string, i: number) => i > 0 && i < s.length && isHigh(s.charCodeAt(i - 1)) && isLow(s.charCodeAt(i));
  const endNew = d.index + d.insert.length;
  return inside(oldStr, d.index) || inside(oldStr, d.index + d.deleteCount) || inside(newStr, d.index) || inside(newStr, endNew);
};

// Exhaustive and seeded property runs: ~0.5 s on a Mac, ~10 s on the CI runner,
// past vitest's 5 s default.
const HEAVY = 60_000;

describe("splices never cut a surrogate pair (STO-001)", () => {
  it("swaps a status dot, a priority marker and a face", () => {
    expect(roundTrip("Status: 🔴 blocked\n", "Status: 🟢 blocked\n")).toBe("Status: 🟢 blocked\n");
    expect(roundTrip("- [ ] submit chapter 🔼\n", "- [ ] submit chapter 🔽\n")).toBe("- [ ] submit chapter 🔽\n");
    expect(roundTrip("mood 😀 today\n", "mood 😃 today\n")).toBe("mood 😃 today\n");
  });

  it("round-trips every emoji from U+1F300 to U+1FAFF against its neighbours", () => {
    // Neighbours one apart share the high surrogate (the prefix side); 0x400
    // apart they share the low one (the suffix side).
    const bad: string[] = [];
    for (let cp = 0x1f300; cp <= 0x1faff; cp++) {
      const a = String.fromCodePoint(cp);
      for (const other of [cp + 1, cp + 0x400]) {
        const b = String.fromCodePoint(other);
        const cases: [string, string][] = [
          [`x ${a} y`, `x ${b} y`], // replace
          [`x ${a} y`, `x ${b}${a} y`], // insert before
          [`x ${a} y`, `x ${a}${b} y`], // insert after
          [`x ${a}${b} y`, `x ${b} y`], // delete the first of two
          [`x ${b}${a} y`, `x ${b} y`], // delete the second of two
        ];
        for (const [from, to] of cases) {
          if (cutsAPair(from, to) || roundTrip(from, to) !== to) bad.push(`${JSON.stringify(from)} → ${JSON.stringify(to)}`);
        }
      }
    }
    expect(bad.slice(0, 5)).toEqual([]);
  }, HEAVY);

  it("round-trips random edits of text full of pairs, CRLF and a BOM (3,000 seeded rounds)", () => {
    let seed = 0x5eed;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const alphabet = ["a", "é", "\r\n", "\n", "\uFEFF", "🔴", "🟢", "🟡", "😀", "😃", "📅", "🚀", "𝔸", "👍🏽"];
    const text = (n: number) => Array.from({ length: n }, () => alphabet[rand(alphabet.length)]).join("");
    for (let round = 0; round < 3000; round++) {
      const from = text(rand(12));
      // Edit one random code-point-aligned region of it.
      const units = [...from];
      const at = rand(units.length + 1);
      const del = rand(Math.min(3, units.length - at) + 1);
      const to = [...units.slice(0, at), text(rand(3)), ...units.slice(at + del)].join("");
      expect(cutsAPair(from, to), `${JSON.stringify(from)} → ${JSON.stringify(to)}`).toBe(false);
      expect(roundTrip(from, to)).toBe(to);
    }
  }, HEAVY);

  it("throws instead of leaving a doc that reads other than the requested text", () => {
    // An embed counts as one position but prints as nothing, so a splice
    // computed on the string lands one place off — the shape of any future
    // splice bug. The backstop must refuse it, not return as if it worked.
    const doc = createNoteDoc("abc");
    doc.getText("content").insertEmbed(1, { x: 1 });
    expect(() => updateDocContent(doc, "abXc")).toThrow(SpliceMismatchError);
  });
});
