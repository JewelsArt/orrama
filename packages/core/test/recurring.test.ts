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

describe("findRecurring reads weekly rhythms and own accounts (audit FIN-012)", () => {
  const every = (description: string, price: number, from: string, days: number, n: number) =>
    Array.from({ length: n }, (_, i) => row(new Date(Date.parse(`${from}T00:00:00Z`) + i * days * 86_400_000).toISOString().slice(0, 10), description, -price));

  it("reports a weekly class as weekly, with what it really cost", () => {
    const [yoga] = findRecurring(every("YOGA STUDIO", 12, "2026-07-07", 7, 13));
    expect(yoga).toMatchObject({ cadence: "weekly", charges: 13, total: 156, everyMonths: 0, first: "2026-07", last: "2026-09" });
  });

  it("keeps a weekly class weekly across a skipped week", () => {
    const dates = every("YOGA STUDIO", 12, "2026-07-07", 7, 10).filter((_, i) => i !== 4);
    expect(findRecurring(dates)[0]).toMatchObject({ cadence: "weekly", charges: 9, total: 108 });
  });

  it("reads biweekly and 4-weekly from the days between charges", () => {
    expect(findRecurring(every("CLEANER", 40, "2026-06-05", 14, 7))[0]).toMatchObject({ cadence: "biweekly", charges: 7, total: 280 });
    expect(findRecurring(every("SALARY ADMIN", 25, "2026-01-01", 28, 13))[0]).toMatchObject({ cadence: "4-weekly", charges: 13 });
  });

  it("says monthly, quarterly in the ledger's words and counts every charge", () => {
    expect(findRecurring(run("Adobe", 19.66, ["2026-06", "2026-07", "2026-08"]))[0]).toMatchObject({ cadence: "monthly", charges: 3, total: 58.98 });
    expect(findRecurring(run("Hogeschool", 780.3, ["2026-01", "2026-04", "2026-07"]))[0]!.cadence).toBe("quarterly");
    expect(findRecurring(run("Odd", 5, ["2026-01", "2026-05", "2026-09"]))[0]).toMatchObject({ cadence: null, everyMonths: 4 });
  });

  it("does not call a habit that lands several times a month a monthly standing order", () => {
    const coffee = ["2026-06-03", "2026-06-17", "2026-06-20", "2026-07-02", "2026-07-25", "2026-08-09", "2026-08-11"].map((d) => row(d, "COFFEE BAR", -3.2));
    expect(findRecurring(coffee)).toEqual([]);
  });

  it("never lists a deposit into an own account", () => {
    const deposits = run("CAPITAL.COM", 200, ["2026-06", "2026-07", "2026-08"]).map((r) => ({ ...r, own: "Capital.com" }));
    expect(findRecurring(deposits)).toEqual([]);
  });

  it("a weekly run that stopped is marked so after a period of grace", () => {
    expect(findRecurring(every("YOGA STUDIO", 12, "2026-07-07", 7, 6), { dataThrough: "2026-08-20" })[0]!.active).toBe(true);
    expect(findRecurring(every("YOGA STUDIO", 12, "2026-07-07", 7, 6), { dataThrough: "2026-09-20" })[0]!.active).toBe(false);
  });
});
