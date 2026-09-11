import { describe, expect, it } from "vitest";
import { MIN_MONTHS, quantile, savingsPlan } from "../src/savings.js";

describe("quantile", () => {
  it("interpolates rather than picking the nearest sample", () => {
    // p25 of [0,1,2,3] sits between 0 and 1; nearest-rank would return 0 and
    // make every "good month" equal to the cheapest one on record.
    expect(quantile([0, 1, 2, 3], 0.25)).toBe(0.75);
    expect(quantile([0, 1, 2, 3], 0.5)).toBe(1.5);
  });
  it("survives empty and single-value input", () => {
    expect(quantile([], 0.5)).toBe(0);
    expect(quantile([42], 0.25)).toBe(42);
  });
});

const base = {
  spendMonths: [1000, 900, 1100, 1000],
  payslipNet: [1500, 1500, 1600],
  ledgerIncome: 0,
  drift: null as number | null,
};

describe("savingsPlan", () => {
  it("targets surplus plus proven headroom, not an invented rule", () => {
    const plan = savingsPlan({
      ...base,
      categories: [
        { category: "Groceries", totals: [400, 300, 500, 400], committed: false },
        { category: "Subscriptions", totals: [40, 40, 40, 40], committed: true },
      ],
    });
    // income p50 of [1500,1500,1600] = 1500; spend p50 of [900,1000,1000,1100] = 1000.
    expect(plan.incomeMonthly).toBe(1500);
    expect(plan.spendMonthly).toBe(1000);
    expect(plan.surplus).toBe(500);
    // Groceries: typical 400, good (p25) 375 -> 25 of headroom.
    expect(plan.headroom).toEqual([{ category: "Groceries", typical: 400, good: 375, save: 25 }]);
    expect(plan.trimmable).toBe(25);
    expect(plan.target).toBe(525);
    expect(plan.targetRate).toBe(35);
  });

  it("never counts a committed category as trimmable", () => {
    const plan = savingsPlan({
      ...base,
      categories: [{ category: "Subscriptions", totals: [10, 40, 40, 90], committed: true }],
    });
    expect(plan.headroom).toEqual([]);
    expect(plan.trimmable).toBe(0);
    expect(plan.committedMonthly).toBe(40);
    expect(plan.discretionaryMonthly).toBe(0);
  });

  it("ignores a category with too little history to quantile", () => {
    const plan = savingsPlan({
      ...base,
      categories: [{ category: "New thing", totals: [10, 90], committed: false }],
    });
    expect(base.spendMonths.length).toBeGreaterThanOrEqual(MIN_MONTHS);
    expect(plan.headroom).toEqual([]);
  });

  it("prefers the bank's own arithmetic: money in is spend plus balance drift", () => {
    // The payslips say 1500, but the balance is climbing 300 on top of 1000 of
    // spending, so 1300 actually landed. The payslip figure is the wrong one.
    const plan = savingsPlan({ ...base, drift: 300, categories: [] });
    expect(plan.incomeSource).toBe("balance");
    expect(plan.incomeMonthly).toBe(1300);
    expect(plan.surplus).toBe(300);
    expect(plan.surplus).toBe(plan.observed);
  });

  it("falls back to payslips only when the statement carries no balances", () => {
    const plan = savingsPlan({ ...base, drift: null, categories: [] });
    expect(plan.incomeSource).toBe("payslips");
    expect(plan.incomeMonthly).toBe(1500);
  });

  it("falls back to the income ledger when no payslips are filed", () => {
    const plan = savingsPlan({ ...base, payslipNet: [], ledgerIncome: 1200, categories: [] });
    expect(plan.incomeSource).toBe("ledger");
    expect(plan.incomeMonthly).toBe(1200);
  });

  it("reports no income rather than guessing one", () => {
    const plan = savingsPlan({ ...base, payslipNet: [], ledgerIncome: 0, categories: [] });
    expect(plan.incomeSource).toBe("none");
    expect(plan.incomeMonthly).toBe(0);
    expect(plan.targetRate).toBeNull();
  });

  it("floors the target at zero when spending outruns income", () => {
    const plan = savingsPlan({ ...base, payslipNet: [500], categories: [] });
    expect(plan.surplus).toBe(-500);
    expect(plan.target).toBe(0);
    expect(plan.monthsToFund).toBeNull();
  });

  it("sizes the emergency fund at three typical months", () => {
    const plan = savingsPlan({ ...base, categories: [] });
    expect(plan.emergencyFund).toBe(3000);
    expect(plan.monthsToFund).toBe(6);
  });

  it("passes the observed balance drift through for comparison", () => {
    expect(savingsPlan({ ...base, drift: 123.456, categories: [] }).observed).toBe(123.46);
    expect(savingsPlan({ ...base, drift: null, categories: [] }).observed).toBeNull();
  });
});
