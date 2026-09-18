import { describe, expect, it } from "vitest";
import { forecast, typicalMonth, type CategoryMonth } from "../src/spending.js";

/**
 * Four months in which two categories alternate. Every month totals €500, so
 * "a typical month" can only honestly be €500 — but no category sits at its own
 * median in any month, which is exactly where sum-of-medians goes wrong.
 */
const ALTERNATING: CategoryMonth[] = [
  { month: "2026-01", byCategory: { A: 500, B: 0 }, total: 500 },
  { month: "2026-02", byCategory: { A: 0, B: 500 }, total: 500 },
  { month: "2026-03", byCategory: { A: 500, B: 0 }, total: 500 },
  { month: "2026-04", byCategory: { A: 0, B: 500 }, total: 500 },
];

describe("typicalMonth", () => {
  it("is a month that happened, not a sum of per-category medians", () => {
    expect(typicalMonth(ALTERNATING)).toBe(500);
    // What the dashboard and the Finance tab used to do, for contrast.
    const sumOfMedians = forecast(ALTERNATING).reduce((a, f) => a + f.typical, 0);
    expect(sumOfMedians).toBe(500); // ← two categories at 250 each, by luck
  });

  it("disagrees with sum-of-medians whenever the categories do not move together", () => {
    const months: CategoryMonth[] = [
      { month: "2026-01", byCategory: { A: 900, B: 100 }, total: 1000 },
      { month: "2026-02", byCategory: { A: 100, B: 900 }, total: 1000 },
      { month: "2026-03", byCategory: { A: 900, B: 100 }, total: 1000 },
      { month: "2026-04", byCategory: { A: 100, B: 900 }, total: 1000 },
      { month: "2026-05", byCategory: { A: 900, B: 100 }, total: 1000 },
    ];
    // Every month cost exactly 1000, so that is the only honest answer.
    expect(typicalMonth(months)).toBe(1000);
    // Σ median(A) + median(B) = 900 + 100 = 1000 here too; make the gap bite
    // with an odd count per category instead.
    const skewed: CategoryMonth[] = [
      { month: "2026-01", byCategory: { A: 1000 }, total: 1000 },
      { month: "2026-02", byCategory: { B: 1000 }, total: 1000 },
      { month: "2026-03", byCategory: { C: 1000 }, total: 1000 },
    ];
    expect(typicalMonth(skewed)).toBe(1000);
    expect(forecast(skewed).reduce((a, f) => a + f.typical, 0)).toBe(0); // ← every median is 0
  });

  it("says null rather than 0 when there is not enough history", () => {
    expect(typicalMonth(ALTERNATING.slice(0, 2))).toBeNull();
    expect(typicalMonth([])).toBeNull();
    // The old sum-of-medians answered €0 to the same question.
    expect(forecast(ALTERNATING.slice(0, 2)).reduce((a, f) => a + f.typical, 0)).toBe(0);
  });

  it("narrows to one category, counting an absent month as zero", () => {
    expect(typicalMonth(ALTERNATING, "A")).toBe(250);
    expect(typicalMonth(ALTERNATING, "B")).toBe(250);
    expect(typicalMonth(ALTERNATING, "Nothing")).toBe(0);
  });

  it("rounds to cents", () => {
    const months: CategoryMonth[] = [
      { month: "2026-01", byCategory: {}, total: 1006.63 },
      { month: "2026-02", byCategory: {}, total: 1072.69 },
      { month: "2026-03", byCategory: {}, total: 1500 },
    ];
    expect(typicalMonth(months)).toBe(1072.69);
  });
});
