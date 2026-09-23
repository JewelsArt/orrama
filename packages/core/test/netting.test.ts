/**
 * Three arithmetic leaks the audit found in the spending pipeline.
 */
import { describe, expect, it } from "vitest";
import { advance, nextCharge } from "../src/subscriptions.js";
import { costOf, forecast, merchantsByCategory, monthlyByCategory, settleRefunds, type CategoryRule } from "../src/spending.js";
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

describe("a refund comes off the purchase it refunds", () => {
  const bought = row({});
  const returned = row({ date: "2026-01-20", type: "Card Refund", amount: 799, flow: "refund" });
  const settled = (...rows: StatementRow[]) => settleRefunds(rows);

  it("nets to zero when the thing goes back", () => {
    const [b, r] = settled(bought, returned);
    expect(costOf(b!, RULES)).toBe(0);
    expect(costOf(r!, RULES)).toBe(0);
    const months = monthlyByCategory([b!, r!], RULES);
    expect(months).toEqual([]); // nothing was spent
    expect(bought.amount).toBe(-799); // the bank's figure is not rewritten
  });

  it("keeps a returned purchase out of the category's typical month", () => {
    // Without netting, January reads 799 and becomes the middle of what
    // Shopping "usually" costs for the next year.
    const other = (date: string, amount: number) => row({ date, amount: -amount });
    const months = monthlyByCategory(settled(bought, returned, other("2026-02-10", 100), other("2026-03-10", 120)), RULES);
    expect(months.map((m) => m.byCategory["Shopping"] ?? 0)).toEqual([100, 120]);
    expect(forecast(months, 2).find((f) => f.category === "Shopping")!.typical).toBe(110);
  });

  it("nets the merchant it was bought from, not some other one", () => {
    // Same price, and MORE recent than the MediaMarkt purchase, so only the
    // merchant can tell the refund which one it belongs to.
    const elsewhere = row({ description: "COOLBLUE", date: "2026-01-15", amount: -799 });
    const rows = settled(bought, elsewhere, returned);
    expect(costOf(rows[0]!, RULES)).toBe(0); //   the MediaMarkt purchase is the one refunded
    expect(costOf(rows[1]!, RULES)).toBe(799); // the Coolblue one still cost 799
    expect(merchantsByCategory(rows, RULES)["Shopping"]?.find((m) => m.name === "MEDIAMARKT")).toBeUndefined();
  });

  it("still keeps a fee, which no refund gives back", () => {
    const [, r] = settled(bought, row({ date: "2026-01-20", type: "Card Refund", amount: 799, fee: 2.5, flow: "refund" }));
    expect(costOf(r!, RULES)).toBe(2.5);
  });

  it("leaves money arriving that is NOT a refund alone", () => {
    // A topup is money from your own account, not a return. It must not show
    // up as negative spending.
    expect(costOf(row({ type: "Topup", amount: 500, flow: "moved" }), RULES)).toBe(0);
  });

  // The real case: a EUR 583.30 Rakuten refund on 7 January, for something
  // bought in December, before the statement starts. Netted where it arrived,
  // it made January's category -EUR 472.34.
  it("a refund whose purchase is not in the data is money back, not negative spending", () => {
    const jan = settled(
      row({ description: "RAKUTEN", date: "2026-01-07", type: "Card Refund", amount: 583.3, flow: "refund" }),
      row({ date: "2026-01-12", amount: -110.96 }),
    );
    const months = monthlyByCategory(jan, RULES);
    expect(months[0]!.total).toBe(110.96);
  });

  it("comes off the purchase's month, not the month the money came back", () => {
    const march = row({ date: "2026-03-10", amount: -799 });
    const aprilRefund = row({ date: "2026-04-02", type: "Card Refund", amount: 799, flow: "refund" });
    const aprilOther = row({ date: "2026-04-15", amount: -60 });
    const months = monthlyByCategory(settled(march, aprilRefund, aprilOther), RULES);
    expect(months.map((m) => [m.month, m.total])).toEqual([["2026-04", 60]]); // March: nothing; April: only what was spent
  });

  it("refunds at most what was bought; the rest is not spending", () => {
    const [p] = settled(row({ amount: -50 }), row({ date: "2026-01-20", type: "Card Refund", amount: 80, flow: "refund" }));
    expect(p!.refunded).toBe(50);
    expect(costOf(p!, RULES)).toBe(0);
  });

  it("does not refund a purchase made after the refund", () => {
    const [r, p] = settled(row({ date: "2026-01-05", type: "Card Refund", amount: 30, flow: "refund" }), row({ date: "2026-01-09", amount: -30 }));
    expect(costOf(r!, RULES)).toBe(0);
    expect(costOf(p!, RULES)).toBe(30);
  });

  it("prefers the purchase of exactly the refunded amount", () => {
    const [exact, other] = settled(
      row({ date: "2026-01-02", amount: -79 }),
      row({ date: "2026-01-08", amount: -20 }),
      row({ date: "2026-01-20", type: "Card Refund", amount: 79, flow: "refund" }),
    );
    expect(costOf(exact!, RULES)).toBe(0);
    expect(costOf(other!, RULES)).toBe(20);
  });

  it("never lets a category month go negative, and conserves what it refunds (1,000 seeded rounds)", () => {
    let seed = 11;
    const rand = (n: number) => {
      seed = (seed + 0x6d2b79f5) >>> 0;
      let t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) % n;
    };
    for (let round = 0; round < 1000; round++) {
      const rows: StatementRow[] = [];
      for (let i = 0, n = 1 + rand(12); i < n; i++) {
        const date = `2026-0${1 + rand(4)}-${String(1 + rand(28)).padStart(2, "0")}`;
        const merchant = ["MEDIAMARKT", "COOLBLUE"][rand(2)]!;
        rows.push(
          rand(3) === 0
            ? row({ date, description: merchant, type: "Card Refund", amount: 1 + rand(200), flow: "refund" })
            : row({ date, description: merchant, amount: -(1 + rand(200)) }),
        );
      }
      const out = settleRefunds(rows);
      for (const m of monthlyByCategory(out, [])) for (const v of Object.values(m.byCategory)) expect(v, `round ${round}`).toBeGreaterThanOrEqual(0);
      const spent = rows.filter((r) => r.amount < 0).reduce((s, r) => s - r.amount, 0);
      const refundedTotal = out.reduce((s, r) => s + (r.refunded ?? 0), 0);
      const refundsTotal = rows.filter((r) => r.flow === "refund").reduce((s, r) => s + r.amount, 0);
      expect(refundedTotal, `round ${round}`).toBeLessThanOrEqual(refundsTotal + 1e-9);
      const costs = out.reduce((s, r) => s + costOf(r, []), 0);
      expect(Math.round(costs * 100) / 100, `round ${round}`).toBe(Math.round((spent - refundedTotal) * 100) / 100);
    }
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
