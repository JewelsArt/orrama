import { parseLedger } from "@basalt/core/subscriptions";
import type { MonthDetail, Recurring } from "@basalt/schema/responses";
import { describe, expect, it } from "vitest";
import { monthName, monthShort } from "./format.js";
import { cadenceOf, monthByCategory, monthStep, recurringRow, shopsOf } from "./model.js";
import { paletteFor } from "./palette.js";

const rules = ["Rent", "Groceries", "Eating out", "Transport", "Subscriptions", "Shopping", "Going out", "Health"].map((category) => ({ category, colour: null }));

describe("category colours", () => {
  it("are the five categorical colours in the note's order, then other", () => {
    const c = paletteFor([...rules, { category: "Subscriptions", colour: "purple" }]);
    expect(["Rent", "Groceries", "Eating out", "Transport", "Subscriptions"].map(c)).toEqual(["var(--c1)", "var(--c2)", "var(--c3)", "var(--c4)", "var(--c5)"]);
    // The sixth and later, what no rule caught, and a name no rule has: other, never a sixth hue.
    expect([c("Shopping"), c("Health"), c("Other"), c("Nowhere")]).toEqual(Array(4).fill("var(--c-other)"));
  });

  it("ignore the note's old colour names; a repeated category keeps its first place", () => {
    const c = paletteFor([{ category: "Groceries", colour: "pink" }, { category: "Other", colour: null }, { category: "Groceries", colour: "cyan" }, { category: "Shopping", colour: null }]);
    expect([c("Groceries"), c("Shopping")]).toEqual(["var(--c1)", "var(--c2)"]);
  });
});

describe("this month by category", () => {
  const forecast = [
    { category: "Subscriptions", typical: 812 },
    { category: "Groceries", typical: 342.6 },
    { category: "Eating out", typical: 77.94 },
    { category: "Shopping", typical: 68.31 },
    { category: "Transport", typical: 36.99 },
    { category: "Going out", typical: 20.8 },
    { category: "Health", typical: 16.65 },
    { category: "Education", typical: 0 },
  ] as Parameters<typeof monthByCategory>[1]["forecast"];
  const byCategory = { Subscriptions: 776.65, "Eating out": 12.95, Groceries: 66.48, Transport: 14.59, Health: 12.75, "Going out": 25.88, Shopping: 22.82, Other: 4.1 };

  it("lists the coloured categories in the note's order and gathers the rest into Other", () => {
    const rows = monthByCategory(byCategory, { rules, forecast });
    expect(rows.map((r) => r.category)).toEqual(["Groceries", "Eating out", "Transport", "Subscriptions", "Other"]);
    expect(rows.at(-1)!.members).toEqual(["Health", "Going out", "Shopping"]);
    expect(rows.at(-1)!.colour).toBe("var(--c-other)");
  });

  it("adds up to the month: nothing dropped, only gathered", () => {
    const rows = monthByCategory(byCategory, { rules, forecast });
    const sum = Math.round(rows.reduce((a, r) => a + r.amount, 0) * 100) / 100;
    expect(sum).toBe(Math.round(Object.values(byCategory).reduce((a, v) => a + v, 0) * 100) / 100);
  });

  it("leaves out a category with nothing this month and no typical month", () => {
    const rows = monthByCategory({ Groceries: 10 }, { rules, forecast: [{ category: "Groceries", typical: 300 } as (typeof forecast)[number]] });
    expect(rows.map((r) => r.category)).toEqual(["Groceries"]);
  });
});

describe("shops in a month", () => {
  const t = (description: string, amount: number, extra: Partial<MonthDetail["transactions"][number]> = {}) => ({
    date: "2026-09-12",
    description,
    amount,
    refund: false,
    moved: false,
    type: "Card Payment",
    balance: null,
    category: "Groceries",
    ...extra,
  });

  it("takes a refund as already off its purchase, counts purchases only, and adds up to the month", () => {
    // The server sends the purchase at what it cost after the refund (€23.10 − €6.40), and the
    // refund row besides, which costs nothing: counting it again would take it off twice.
    const d = { total: 34.6, transactions: [t("ALBERT HEIJN", 16.7), t("ALBERT HEIJN", 6.4, { refund: true }), t("JUMBO", 9.85), t("LIDL", 8.05)] };
    const { shops, adds } = shopsOf(d);
    expect(shops).toEqual([
      { name: "ALBERT HEIJN", total: 16.7, count: 1 },
      { name: "JUMBO", total: 9.85, count: 1 },
      { name: "LIDL", total: 8.05, count: 1 },
    ]);
    expect(adds).toBe(true);
  });

  it("leaves out money that only moved, and says when the shops disagree with the total", () => {
    const d = { total: 10, transactions: [t("SHOP", 10), t("To SAVINGS", 100, { moved: true })] };
    expect(shopsOf(d)).toEqual({ shops: [{ name: "SHOP", total: 10, count: 1 }], adds: true });
    expect(shopsOf({ ...d, total: 12 }).adds).toBe(false);
  });
});

describe("a charge that looks recurring, written down", () => {
  const r: Recurring = { merchant: "BASIC-FIT", amount: 29.99, months: ["2026-07", "2026-08", "2026-09"], cadence: "monthly", everyMonths: 1, charges: 3, first: "2026-07", last: "2026-09", total: 89.97, active: true };

  it("is a row the ledger reads back as that charge, dated from its last charge", () => {
    const row = recurringRow(r, "2026-09-20")!;
    expect(row).toEqual({ service: "BASIC-FIT", amount: "29.99", cadence: "monthly", next: "2026-09-20", note: "" });
    const note = `| Service | Amount | Every | Next | Note |\n|---|---|---|---|---|\n| ${row.service} | ${row.amount} | ${row.cadence} | ${row.next} | |\n`;
    const read = parseLedger(note, "2026-10-11");
    expect(read.unreadable).toEqual([]);
    expect(read.items[0]).toMatchObject({ service: "BASIC-FIT", amount: 29.99, cadence: "monthly", anchor: "2026-09-20", next: "2026-10-20" });
  });

  it("names a month spacing the ledger knows, and refuses one it doesn't", () => {
    expect(cadenceOf({ cadence: null, everyMonths: 3 })).toBe("quarterly");
    expect(cadenceOf({ cadence: null, everyMonths: 5 })).toBeNull();
    expect(cadenceOf({ cadence: "fortnightly-ish", everyMonths: 0 })).toBeNull();
    expect(recurringRow({ ...r, cadence: null, everyMonths: 5 }, null)).toBeNull();
  });
});

describe("words", () => {
  it("writes a month as Sep 2026, never Sep 26", () => {
    expect(monthName("2026-09")).toBe("Sep 2026");
    expect(monthShort("2026-09")).toBe("Sep");
  });

  it("steps the month with ← and → only when the key is the page's", () => {
    const k = (key: string, o: Partial<{ metaKey: boolean; shiftKey: boolean; defaultPrevented: boolean }> = {}) => ({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, defaultPrevented: false, ...o });
    expect(monthStep(k("ArrowLeft"), false, false)).toBe(-1);
    expect(monthStep(k("ArrowRight"), false, false)).toBe(1);
    expect(monthStep(k("ArrowLeft", { metaKey: true }), false, false)).toBeNull(); // ⌘← is Back
    expect(monthStep(k("ArrowLeft"), true, false)).toBeNull();
    expect(monthStep(k("ArrowLeft"), false, true)).toBeNull();
    expect(monthStep(k("ArrowLeft", { defaultPrevented: true }), false, false)).toBeNull();
    expect(monthStep(k("a"), false, false)).toBeNull();
  });
});
