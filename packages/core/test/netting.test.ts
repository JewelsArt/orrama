/**
 * Three arithmetic leaks the audit found in the spending pipeline.
 */
import { describe, expect, it } from "vitest";
import { advance, nextCharge } from "../src/subscriptions.js";
import { costOf, forecast, merchantsByCategory, monthlyByCategory, type CategoryRule } from "../src/spending.js";
import type { StatementRow } from "../src/statement.js";

const RULES: CategoryRule[] = [{ category: "Shopping", matches: ["mediamarkt"], pinned: false, colour: null }];

let seq = 0;
const row = (over: Partial<StatementRow>): StatementRow => ({
  key: `row-${++seq}`, // each helper row is its own transaction
  date: "2026-01-10",
  type: "Card Payment",
  description: "MEDIAMARKT",
  amount: -799,
  fee: 0,
  currency: "EUR",
  balance: null,
  flow: "spend",
  ...over,
});

describe("a refund reduces what the category cost", () => {
  const bought = row({});
  const returned = row({ date: "2026-01-20", type: "Card Refund", amount: 799, flow: "refund" });

  it("nets to zero when the thing goes back", () => {
    expect(costOf(bought, RULES)).toBe(799);
    expect(costOf(returned, RULES)).toBe(-799);
    const months = monthlyByCategory([bought, returned], RULES);
    expect(months[0]!.byCategory["Shopping"]).toBe(0);
    expect(months[0]!.total).toBe(0);
  });

  it("keeps a returned purchase out of the category's typical month", () => {
    // Without netting, January reads 799 and becomes the middle of what
    // Shopping "usually" costs for the next year.
    const other = (date: string, amount: number) => row({ date, amount: -amount });
    const months = monthlyByCategory(
      [bought, returned, other("2026-02-10", 100), other("2026-03-10", 120)],
      RULES,
    );
    expect(months.map((m) => m.byCategory["Shopping"] ?? 0)).toEqual([0, 100, 120]);
    expect(forecast(months).find((f) => f.category === "Shopping")!.typical).toBe(100);
  });

  it("nets the merchant it was bought from, not some other one", () => {
    const merchants = merchantsByCategory([bought, returned], RULES);
    expect(merchants["Shopping"]?.find((m) => m.name === "MEDIAMARKT")?.total).toBe(0);
  });

  it("still keeps a fee, which no refund gives back", () => {
    expect(costOf(row({ type: "Card Refund", amount: 799, fee: 2.5, flow: "refund" }), RULES)).toBe(-796.5);
  });

  it("leaves money arriving that is NOT a refund alone", () => {
    // A topup is money from your own account, not a return. It must not show
    // up as negative spending.
    expect(costOf(row({ type: "Topup", amount: 500, flow: "moved" }), RULES)).toBe(0);
  });
});

describe("a month-end subscription keeps its anchor", () => {
  it("does not drift to the 28th forever after one short month", () => {
    // Rent on the 31st. February can only hold the 28th; March must go back to
    // the 31st. Chaining the clamp loses the anchor and never recovers it.
    expect(nextCharge("2026-01-31", "monthly", "2026-02-01")).toBe("2026-02-28");
    expect(nextCharge("2026-01-31", "monthly", "2026-03-01")).toBe("2026-03-31");
    expect(nextCharge("2026-01-31", "monthly", "2026-04-01")).toBe("2026-04-30");
    expect(nextCharge("2026-01-31", "monthly", "2026-05-01")).toBe("2026-05-31");
    expect(nextCharge("2026-01-31", "monthly", "2027-01-01")).toBe("2027-01-31");
  });

  it("keeps the single-step clamp, which was always right", () => {
    expect(advance("2026-01-31", "monthly")).toBe("2026-02-28");
    expect(advance("2026-03-31", "monthly")).toBe("2026-04-30");
    expect(advance("2026-12-15", "monthly")).toBe("2027-01-15");
  });

  it("never returns a date in the past, however stale the note is", () => {
    // 800 weekly steps is about fifteen years, so this used to answer 2015.
    expect(nextCharge("2000-01-01", "weekly", "2026-09-12") >= "2026-09-12").toBe(true);
    expect(nextCharge("1990-01-31", "monthly", "2026-09-12")).toBe("2026-09-30");
    expect(nextCharge("1990-03-15", "yearly", "2026-09-12")).toBe("2027-03-15");
    expect(nextCharge("1990-02-28", "quarterly", "2026-09-12") >= "2026-09-12").toBe(true);
  });

  it("leaves a future date alone", () => {
    expect(nextCharge("2027-01-01", "monthly", "2026-09-12")).toBe("2027-01-01");
  });

  it("stays on the same weekday for a weekly charge", () => {
    // 2015-01-05 is a Monday.
    expect(nextCharge("2015-01-05", "weekly", "2026-09-02")).toBe("2026-09-07");
  });
});
