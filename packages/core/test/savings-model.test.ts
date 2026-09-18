/**
 * The two arithmetic errors in the savings model (audit).
 *
 * Both are the same kind of mistake: a figure assembled out of pieces that
 * never coexisted. Income came from SPEND rather than from everything that
 * left the account, and headroom was a sum of per-category quantiles drawn
 * from months that never happened together.
 */
import { describe, expect, it } from "vitest";
import { savingsPlan } from "../src/savings.js";

const MONTHS = ["2026-01", "2026-02", "2026-03", "2026-04"];

describe("income comes from everything that left, not just what was spent", () => {
  /**
   * €1,400 of card spending and a €600 standing transfer to savings, every
   * month, with the balance flat. €2,000 must have landed for that to be true.
   */
  const plan = (outflowMonths?: number[]) =>
    savingsPlan({
      categories: [{ category: "Groceries", totals: [1400, 1400, 1400, 1400], committed: false }],
      months: MONTHS,
      spendMonths: [1400, 1400, 1400, 1400],
      outflowMonths,
      payslipNet: [],
      ledgerIncome: 0,
      drift: 0,
    });

  it("counts the standing transfer as money out", () => {
    const s = plan([2000, 2000, 2000, 2000]);
    expect(s.incomeSource).toBe("balance");
    expect(s.incomeMonthly).toBe(2000);
    expect(s.outflowMonthly).toBe(2000);
  });

  it("reported €1,400 when €600 a month was leaving by transfer", () => {
    // Without the outflow series it can only fall back to spend, which is the
    // number the audit found: understated by every euro transferred out.
    const s = plan(undefined);
    expect(s.incomeMonthly).toBe(1400);
  });

  it("keeps surplus equal to the balance trend, which is the model's own claim", () => {
    for (const drift of [0, 331, -200]) {
      const s = savingsPlan({
        categories: [{ category: "Groceries", totals: [1400, 1400, 1400, 1400], committed: false }],
        months: MONTHS,
        spendMonths: [1400, 1400, 1400, 1400],
        outflowMonths: [2000, 2000, 2000, 2000],
        payslipNet: [],
        ledgerIncome: 0,
        drift,
      });
      expect(s.surplus).toBe(drift);
      expect(s.observed).toBe(drift);
    }
  });
});

describe("headroom is one real month against another", () => {
  /**
   * The audit's case. Two categories alternate; every month costs exactly
   * €500, so there is no headroom at all. Σ of per-category quantiles claimed
   * €300 of it.
   */
  const alternating = savingsPlan({
    categories: [
      { category: "A", totals: [500, 0, 500, 0], committed: false },
      { category: "B", totals: [0, 500, 0, 500], committed: false },
    ],
    months: MONTHS,
    spendMonths: [500, 500, 500, 500],
    outflowMonths: [500, 500, 500, 500],
    payslipNet: [],
    ledgerIncome: 0,
    drift: 0,
  });

  it("finds no headroom in months that all cost the same", () => {
    expect(alternating.trimmable).toBe(0);
  });

  it("names the two months it compared", () => {
    expect(MONTHS).toContain(alternating.typicalMonth);
    expect(MONTHS).toContain(alternating.goodMonth);
  });

  it("adds up: the rows are the difference between those two months", () => {
    const s = savingsPlan({
      categories: [
        { category: "Eating out", totals: [300, 120, 260, 200], committed: false },
        { category: "Shopping", totals: [400, 100, 150, 250], committed: false },
        { category: "Rent", totals: [900, 900, 900, 900], committed: true },
      ],
      months: MONTHS,
      spendMonths: [1600, 1120, 1310, 1350],
      outflowMonths: [1600, 1120, 1310, 1350],
      payslipNet: [],
      ledgerIncome: 0,
      drift: 0,
    });
    // Discretionary totals by month: Jan 700, Feb 220, Mar 410, Apr 450.
    // Ranked ascending that is Feb, Mar, Apr, Jan — the median rank is Apr and
    // the 25th-percentile rank is Mar. Both are months that happened.
    expect(s.typicalMonth).toBe("2026-04");
    expect(s.goodMonth).toBe("2026-03");
    expect(s.trimmable).toBe(40);
    expect(Math.round(s.headroom.reduce((a, h) => a + h.save, 0) * 100) / 100).toBe(s.trimmable);
    // A committed category never appears: only a cancellation moves it.
    expect(s.headroom.map((h) => h.category)).not.toContain("Rent");
  });

  it("never claims headroom a month has not actually shown", () => {
    const s = savingsPlan({
      categories: [
        { category: "A", totals: [1000, 0, 0, 0], committed: false },
        { category: "B", totals: [0, 1000, 0, 0], committed: false },
        { category: "C", totals: [0, 0, 1000, 0], committed: false },
        { category: "D", totals: [0, 0, 0, 1000], committed: false },
      ],
      months: MONTHS,
      spendMonths: [1000, 1000, 1000, 1000],
      outflowMonths: [1000, 1000, 1000, 1000],
      payslipNet: [],
      ledgerIncome: 0,
      drift: 0,
    });
    expect(s.trimmable).toBe(0);
    expect(s.target).toBe(0);
  });
});
