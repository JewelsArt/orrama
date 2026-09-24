/**
 * Own accounts: money moved to a broker or savings pot is not spending, and
 * money coming back is principal first and gain only above what went in.
 */
import { describe, expect, it } from "vitest";
import { markOwnAccounts, ownSavedByMonth, parseOwnAccounts } from "../src/ownAccounts.js";
import { costOf, monthlyByCategory, outflowByMonth, parseCategoryRules, settleRefunds } from "../src/spending.js";
import type { StatementRow } from "../src/statement.js";

const OWN = parseOwnAccounts(`
| Account     | Matches                  |
|-------------|--------------------------|
| Capital.com | capital.com, capital com |
| Empty       |                          |
`);

let seq = 0;
const row = (date: string, type: string, description: string, amount: number, fee = 0): StatementRow => ({
  key: `row-${++seq}`,
  date,
  type,
  description,
  amount,
  fee,
  currency: "EUR",
  balance: null,
  flow: type === "Card Payment" ? "spend" : type === "Card Refund" ? "refund" : "moved",
});

describe("parseOwnAccounts", () => {
  it("reads accounts and their comma-separated terms, skipping rows with none", () => {
    expect(OWN).toEqual([{ account: "Capital.com", matches: ["capital.com", "capital com"] }]);
  });
});

describe("a deposit into an own account", () => {
  const rows = markOwnAccounts(
    [row("2021-01-04", "Card Payment", "CAPITAL.COM", -500, 1.5), row("2021-01-05", "Card Payment", "LIDL", -20)],
    OWN,
  );

  it("is moved, not spent — the bank calls it a card payment", () => {
    expect(rows[0]).toMatchObject({ flow: "moved", own: "Capital.com" });
    expect(costOf(rows[0]!)).toBe(1.5); // the fee is still a cost
    expect(rows[1]!.own).toBeUndefined();
  });

  it("stays out of spending even when a category rule also names it", () => {
    const rules = parseCategoryRules("| Category | Matches |\n|---|---|\n| Investing | capital.com |\n| Groceries | lidl |");
    const [jan] = monthlyByCategory(rows, rules);
    expect(jan!.byCategory).toEqual({ Investing: 1.5, Groceries: 20 });
  });

  it("is not outflow either — the savings plan counts it as saved instead", () => {
    expect(outflowByMonth(rows)).toEqual([{ month: "2021-01", outflow: 21.5 }]);
    expect(ownSavedByMonth(rows).get("2021-01")).toBe(500);
  });
});

describe("money coming back", () => {
  it("is principal until everything put in has come back, and gain after", () => {
    const rows = markOwnAccounts(
      [
        // Deliberately out of order: the split is decided by date, not by position.
        row("2021-03-01", "Transfer", "From CAPITAL.COM", 900),
        row("2021-01-04", "Card Payment", "CAPITAL.COM", -1000),
        row("2021-02-01", "Transfer", "From CAPITAL.COM", 300),
      ],
      OWN,
    );
    expect(rows.map((r) => r.gain)).toEqual([200, undefined, 0]);
    const saved = ownSavedByMonth(rows);
    expect([saved.get("2021-01"), saved.get("2021-02"), saved.get("2021-03")]).toEqual([1000, -300, -700]);
  });

  it("is not netted off the deposit when the bank files it as a card refund", () => {
    const rows = settleRefunds(
      markOwnAccounts(
        [row("2021-01-04", "Card Payment", "CAPITAL.COM", -500), row("2021-02-04", "Card Refund", "CAPITAL.COM", 200)],
        OWN,
      ),
    );
    expect(rows[0]!.refunded).toBeUndefined();
    expect(rows[1]).toMatchObject({ flow: "moved", gain: 0 });
    expect(ownSavedByMonth(rows).get("2021-02")).toBe(-200);
  });
});

it("changes nothing without a list", () => {
  const rows = [row("2021-01-04", "Card Payment", "CAPITAL.COM", -500)];
  expect(markOwnAccounts(rows, [])).toBe(rows);
});
