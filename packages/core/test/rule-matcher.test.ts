/**
 * ruleFor folds each rules set once and remembers each description (audit
 * FIN-015). It must still answer exactly what the one-pass version did —
 * longest term wins, `=exact` scored +100, pinned +1000, short terms only as
 * a whole description, the earlier term on a tie — so this compares the two on
 * random rules and descriptions.
 */
import { describe, expect, it } from "vitest";
import { matchesTerms, ruleFor, type CategoryRule } from "../src/spending.js";

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
/** The matcher as it was before the cache, verbatim in behaviour. */
function reference(description: string, rules: CategoryRule[]): CategoryRule | null {
  const hay = fold(description).trim();
  let best: CategoryRule | null = null;
  let bestLen = 0;
  for (const rule of rules) {
    for (const raw of rule.matches) {
      const exact = raw.startsWith("=");
      const m = fold(exact ? raw.slice(1) : raw).trim();
      if (!m) continue;
      const score = (exact ? m.length + 100 : m.length) + (rule.pinned ? 1000 : 0);
      if (score <= bestLen) continue;
      if (exact ? hay === m : m.length >= 3 && hay.includes(m)) {
        best = rule;
        bestLen = score;
      }
    }
  }
  return best;
}

/** A small deterministic PRNG, so a failure reproduces. */
function rng(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
}

describe("ruleFor with folded, remembered rules (FIN-015)", () => {
  it("answers exactly what the one-pass matcher did", () => {
    const rand = rng(42);
    const words = ["ns", "uber", "uber eats", "döner", "doner", "pathé", "ah", "albert heijn", "eats", "bar", "café", "zalando", " "];
    const pick = () => words[Math.floor(rand() * words.length)]!;
    for (let round = 0; round < 200; round++) {
      const rules: CategoryRule[] = Array.from({ length: 1 + Math.floor(rand() * 6) }, (_, i) => ({
        category: `C${i}`,
        colour: null,
        pinned: rand() < 0.2,
        matches: Array.from({ length: 1 + Math.floor(rand() * 3) }, () => (rand() < 0.2 ? `=${pick()}` : pick())),
      }));
      for (let q = 0; q < 20; q++) {
        const description = rand() < 0.3 ? pick().toUpperCase() : `${pick()} ${pick()}`.toUpperCase();
        expect(ruleFor(description, rules)?.category ?? null).toBe(reference(description, rules)?.category ?? null);
        // Asked twice, from the memo this time.
        expect(ruleFor(description, rules)?.category ?? null).toBe(reference(description, rules)?.category ?? null);
      }
    }
  });

  it("matchesTerms reads the same terms array the same way every time", () => {
    const terms = ["pathe", "=ns"];
    expect(matchesTerms("PATHÉ AMSTERDAM", terms)).toBe(true);
    expect(matchesTerms("NS", terms)).toBe(true);
    expect(matchesTerms("HANS EN GRIETJE", terms)).toBe(false);
    expect(matchesTerms("PATHÉ AMSTERDAM", ["netflix"])).toBe(false);
  });
});
