import { describe, expect, it } from "vitest";
import { findRecurring, unclaimedRecurring } from "../src/recurring.js";
import type { StatementRow } from "../src/statement.js";

const row = (date: string, description: string, amount: number): StatementRow =>
  ({ date, description, amount, fee: 0, flow: "spend", type: "Card Payment", balance: null, currency: "EUR" }) as StatementRow;

/** A membership at the same price for n months from `from`. */
const run = (description: string, price: number, months: string[]) =>
  months.map((m) => row(`${m}-05`, description, -price));

describe("findRecurring", () => {
  it("finds a monthly charge that never changes", () => {
    const found = findRecurring(run("Buckaroo Stichting Derdengelden", 56.7, ["2026-07", "2026-08", "2026-09"]));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      merchant: "Buckaroo Stichting Derdengelden",
      amount: 56.7,
      everyMonths: 1,
      first: "2026-07",
      last: "2026-09",
      total: 170.1,
    });
  });

  it("separates a membership from drop-ins at the same gym", () => {
    // The exact case this exists for: one merchant, two very different things.
    const rows = [
      ...run("Bouldermuur", 57, ["2026-03", "2026-04", "2026-05"]),
      row("2026-03-11", "Bouldermuur", -9.45),
      row("2026-04-02", "Bouldermuur", -14.7),
      row("2026-05-19", "Bouldermuur", -9.45),
    ];
    const found = findRecurring(rows);
    expect(found.map((f) => f.amount)).toEqual([57]);
  });

  it("treats a price change as the end of one run and the start of another", () => {
    const found = findRecurring([
      ...run("To Stichting DUWO", 589.79, ["2026-01", "2026-02", "2026-03"]),
      ...run("To Stichting DUWO", 608.99, ["2026-04", "2026-05", "2026-06"]),
    ]);
    expect(found.map((f) => f.amount).sort((a, b) => a - b)).toEqual([589.79, 608.99]);
  });

  it("reads quarterly spacing as quarterly", () => {
    const found = findRecurring(run("Hogeschool", 780.3, ["2026-01", "2026-04", "2026-07"]));
    expect(found[0]!.everyMonths).toBe(3);
  });

  it("ignores an irregular run of identical amounts", () => {
    // The same sandwich, most months. A habit, not a standing order.
    expect(findRecurring(run("Albert Heijn", 1.47, ["2026-02", "2026-03", "2026-04", "2026-07"]))).toEqual([]);
  });

  it("needs three months; two of anything is a coincidence", () => {
    expect(findRecurring(run("Bouldermuur", 57, ["2026-04", "2026-05"]))).toEqual([]);
    expect(findRecurring(run("Bouldermuur", 57, ["2026-04", "2026-05"]), { minMonths: 2 })).toHaveLength(1);
  });

  it("never treats money coming in as a recurring charge", () => {
    const rows = ["2026-01", "2026-02", "2026-03"].map((m) => row(`${m}-25`, "SCOOPERZ", 500));
    expect(findRecurring(rows)).toEqual([]);
  });

  it("marks a run that stopped, allowing one period of grace", () => {
    const stopped = findRecurring(run("Chatgpt", 23, ["2026-01", "2026-02", "2026-03"]), { dataThrough: "2026-09-03" });
    expect(stopped[0]!.active).toBe(false);
    const running = findRecurring(run("Adobe", 19.66, ["2026-06", "2026-07", "2026-08"]), { dataThrough: "2026-09-03" });
    expect(running[0]!.active).toBe(true);
  });
});

describe("unclaimedRecurring", () => {
  it("hides what a ledger line already matches, and keeps the rest", () => {
    const found = findRecurring([
      ...run("Adobe", 19.66, ["2026-06", "2026-07", "2026-08"]),
      ...run("Buckaroo Stichting Derdengelden", 56.7, ["2026-06", "2026-07", "2026-08"]),
    ]);
    const left = unclaimedRecurring(found, ["adobe"]);
    expect(left.map((r) => r.merchant)).toEqual(["Buckaroo Stichting Derdengelden"]);
    expect(unclaimedRecurring(found, [])).toHaveLength(2);
  });
});
