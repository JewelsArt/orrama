import { describe, expect, it } from "vitest";
import { rollUpYears } from "../src/spending.js";

const m = (month: string, groceries: number, home = 0) => ({
  month,
  byCategory: { Groceries: groceries, ...(home ? { Home: home } : {}) },
  total: groceries + home,
});

describe("rollUpYears", () => {
  const months = [m("2020-09", 10), m("2020-12", 20), m("2021-01", 5, 600), m("2021-12", 5, 600), m("2022-03", 7)];

  it("sums each calendar year's months, oldest first", () => {
    const years = rollUpYears(months, "2020-09", "2022-03");
    expect(years.map((y) => [y.year, y.total])).toEqual([["2020", 30], ["2021", 1210], ["2022", 7]]);
    expect(years[1]!.byCategory).toEqual({ Groceries: 10, Home: 1200 });
  });

  it("marks a year partial when the statements start after January or stop before a complete December", () => {
    const years = rollUpYears(months, "2020-09", "2022-03");
    expect(years.map((y) => [y.year, y.partial])).toEqual([["2020", true], ["2021", false], ["2022", true]]);
  });

  it("treats the latest year as partial until its December is complete", () => {
    expect(rollUpYears([m("2021-01", 1), m("2021-12", 1)], "2021-01", "2021-11").at(-1)!.partial).toBe(true);
    expect(rollUpYears([m("2021-01", 1), m("2021-12", 1)], "2021-01", "2021-12").at(-1)!.partial).toBe(false);
  });

  it("rounds to cents so a year of floats does not drift", () => {
    const years = rollUpYears([m("2021-01", 0.1), m("2021-02", 0.2)], "2021-01", "2021-12");
    expect(years[0]!.total).toBe(0.3);
  });
});
