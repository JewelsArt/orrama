/**
 * The linear-time matcher behind `/regex/` life-area rules (audit INP-003):
 * the same answers as JavaScript's RegExp on the subset it accepts, in time
 * linear in the text on patterns that make RegExp backtrack for minutes.
 */
import { describe, expect, it } from "vitest";
import { compileSafeRegex, MAX_PROGRAM, type SafeRegex } from "../src/index.js";

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
  // Each with the character that makes a backtracking engine try every way of splitting the text.
  const EVIL: [string, string][] = [
    ["^([^~]+)+~", "a"],
    ["(a|a)*b", "a"],
    ["(a*)*b", "a"],
    ["(\\w+\\s?)+$", "a"],
    ["^(a+)+$", "a"],
    ["(x+x+)+y", "x"],
    ["(.*a){12}$", "a"],
  ];
  const clock = (r: SafeRegex, s: string) => {
    const t = performance.now();
    r.test(s);
    return performance.now() - t;
  };
  for (const [src, c] of EVIL) {
    it(`/${src}/ costs four times as much on four times the text`, () => {
      const mine = must(src);
      const text = (n: number) => `${c.repeat(n)}!`;
      // Exponential first, on a text short enough to end. These 26 characters keep a backtracking
      // engine busy for seconds and a linear one for a few milliseconds even on the slowest runner.
      expect(clock(mine, text(26))).toBeLessThan(500);
      // Then anything else worse than linear. A ratio, because a clock limit fails on a slow
      // Windows runner (286 ms against 200 on 9 Nov): a slow machine is slow on both sizes. Taken
      // in turns, best of three, since a pause only ever adds time; the first run warms the JIT.
      // Linear is 4, quadratic 16. Under 2 ms a ratio is only timer noise.
      const small = text(500);
      const large = text(2000);
      mine.test(large);
      let [best500, best2000] = [Infinity, Infinity];
      for (let k = 0; k < 3; k++) {
        best500 = Math.min(best500, clock(mine, small));
        best2000 = Math.min(best2000, clock(mine, large));
      }
      expect(best2000, `${best500.toFixed(2)} ms on 500 characters`).toBeLessThan(10 * Math.max(best500, 2));
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
