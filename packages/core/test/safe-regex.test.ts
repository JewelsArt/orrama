/**
 * The linear-time matcher behind `/regex/` life-area rules (audit INP-003):
 * the same answers as JavaScript's RegExp on the subset it accepts, in time
 * linear in the text on patterns that make RegExp backtrack for minutes.
 */
import { describe, expect, it } from "vitest";
import { compileSafeRegex, MAX_PROGRAM } from "../src/index.js";

const must = (src: string, flags = "") => {
  const r = compileSafeRegex(src, flags);
  if (!r) throw new Error(`refused /${src}/`);
  return r;
};

describe("agrees with RegExp", () => {
  const CASES: [string, string[]][] = [
    ["\\blaw\\b", ["company law.md", "lawn party", "law", "by-law", "outlaw"]],
    ["^01-me/", ["01-me/journal.md", "x/01-me/", "01-ME/a"]],
    ["\\.md$", ["a.md", "a.mdx", "md"]],
    ["ch(apter){1,2}", ["chapter", "chapterapter", "chap", "ch"]],
    ["colou?r", ["color", "colour", "colr"]],
    ["[a-c]+x", ["abcx", "dx", "x", "aax"]],
    ["[^a-z ]", ["abc def", "abc1", ""]],
    ["thesis|resit|exam", ["my resit.md", "examples", "the thesis", "nope"]],
    ["(?:04-projects|school)/\\w+", ["04-projects/thesis", "school/", "04-projects/ x"]],
    ["(?<year>20\\d\\d)-\\d{2}", ["2026-10", "1999-10", "2026-1"]],
    ["a.c", ["abc", "a\nc", "ac"]],
    ["\\d{3,}", ["12", "123", "a1234"]],
    ["x{2,}?", ["x", "xx"]],
    ["\\Bcat", ["concat", "cat", "a cat"]],
    ["[\\w-]+@", ["a-b@", "@", " @"]],
    ["a{", ["a{", "a"]],
    ["[]a]", ["a", "]"]],
    ["[^]", ["", "x"]],
    ["\\x41\\u0042", ["ab", "AB", "a b"]],
    ["\\/agents", ["/agents", "agents"]],
    ["", ["", "x"]],
  ];
  for (const [src, inputs] of CASES) {
    it(`/${src}/i`, () => {
      const mine = must(src);
      const native = new RegExp(src, "i");
      for (const s of inputs) expect(mine.test(s), JSON.stringify(s)).toBe(native.test(s));
    });
  }

  it("on random patterns and texts", () => {
    let seed = 7;
    const r = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const TOKENS = ["a", "b", "c", "A", "1", " ", "/", "-", ".", "\\b", "\\B", "\\d", "\\w", "\\s", "\\W", "[ab]", "[^a]", "[a-c]", "^", "$", "(", "(?:", ")", "|", "*", "+", "?", "{2}", "{1,2}", "{0,}", "*?"];
    const TEXT = "abcA1 /-_";
    let compared = 0;
    for (let n = 0; n < 4000; n++) {
      let src = "";
      const len = 1 + Math.floor(r() * 8);
      for (let i = 0; i < len; i++) src += TOKENS[Math.floor(r() * TOKENS.length)];
      let native: RegExp;
      try {
        native = new RegExp(src, "i");
      } catch {
        continue;
      }
      const mine = compileSafeRegex(src);
      expect(mine, `/${src}/ refused`).not.toBeNull();
      for (let k = 0; k < 6; k++) {
        let s = "";
        const sl = Math.floor(r() * 7);
        for (let i = 0; i < sl; i++) s += TEXT[Math.floor(r() * TEXT.length)];
        expect(mine!.test(s), `/${src}/ on ${JSON.stringify(s)}`).toBe(native.test(s));
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(5000);
  });
});

describe("runs in linear time", () => {
  const EVIL = ["^([^~]+)+~", "(a|a)*b", "(a*)*b", "(\\w+\\s?)+$", "^(a+)+$", "(x+x+)+y", "(.*a){12}"];
  for (const src of EVIL) {
    it(`/${src}/ on a long text`, () => {
      const mine = must(src);
      const text = `${"a".repeat(2000)}!`;
      const t = performance.now();
      mine.test(text);
      mine.test(`01-me/journal/2026-10-04 a long realistic path name.md ${"x".repeat(200)}`);
      expect(performance.now() - t).toBeLessThan(200);
    });
  }
});

describe("refuses what it cannot run safely", () => {
  it("backreferences, lookaround and \\p", () => {
    for (const src of ["(a)\\1", "a(?=b)", "a(?!b)", "(?<=a)b", "(?<!a)b", "\\k<x>(?<x>a)", "\\p{L}"]) {
      expect(compileSafeRegex(src, src.includes("\\p") ? "u" : ""), src).toBeNull();
    }
  });

  it("what JavaScript refuses", () => {
    for (const src of ["(", "a**", "[b-a]", "*a"]) expect(compileSafeRegex(src), src).toBeNull();
    expect(compileSafeRegex("a", "q")).toBeNull();
  });

  it("a pattern too large to run cheaply", () => {
    expect(compileSafeRegex(`a{${MAX_PROGRAM}}`)).toBeNull();
    expect(compileSafeRegex("(a{30}){30}")).toBeNull();
    expect(must("a{100}").size).toBeLessThanOrEqual(MAX_PROGRAM);
  });
});

describe("flags", () => {
  it("is always case-insensitive and drops g and y", () => {
    const r = must("scooperz", "gy");
    expect(String(r)).toBe("/scooperz/i");
    expect([1, 2, 3, 4].map(() => r.test("04-projects/scooperz/x.md"))).toEqual([true, true, true, true]);
    expect(must("[^a]").test("A")).toBe(false);
  });
});
