import { describe, expect, it } from "vitest";
import { parseMoney, parseMoneyWithCurrency } from "../src/money.js";
import { parseStatement } from "../src/statement.js";
import { parsePayslipTable } from "../src/payslip.js";
import { parseSubscriptions } from "../src/subscriptions.js";

describe("parseMoney", () => {
  it("reads both separator conventions (audit B4)", () => {
    expect(parseMoney("1,234.56")).toBe(1234.56);
    expect(parseMoney("1.234,56")).toBe(1234.56);
    expect(parseMoney("-1.234,56")).toBe(-1234.56);
    expect(parseMoney("-1,234.56")).toBe(-1234.56);
    expect(parseMoney("1234.56")).toBe(1234.56);
    expect(parseMoney("1234,56")).toBe(1234.56);
  });

  it("returns null rather than 0 for input it cannot read", () => {
    expect(parseMoney("abc")).toBeNull();
    expect(parseMoney("")).toBeNull();
    expect(parseMoney("—")).toBeNull();
  });

  it("keeps a repeated three-digit separator as grouping", () => {
    expect(parseMoney("1,234,567.89")).toBe(1234567.89);
    expect(parseMoney("1.234.567,89")).toBe(1234567.89);
    expect(parseMoney("1,234,567")).toBe(1234567);
    expect(parseMoney("1.234.567")).toBe(1234567);
  });

  it("keeps the sign that stripping non-digits would have thrown away", () => {
    expect(parseMoney("-€1.234,56")).toBe(-1234.56);
    expect(parseMoney("(1,234.56)")).toBe(-1234.56);
    // Parens that do not wrap the whole cell are not a sign.
    expect(parseMoney("Netflix (Family) 10,99")).toBe(10.99);
  });

  it("handles symbols, codes and spacing", () => {
    expect(parseMoney("€ 10,99")).toBe(10.99);
    expect(parseMoney("10.99 EUR")).toBe(10.99);
    expect(parseMoney("$12")).toBe(12);
  });

  it("carries the currency when asked", () => {
    expect(parseMoneyWithCurrency("€10,99")).toEqual({ amount: 10.99, currency: "EUR" });
    expect(parseMoneyWithCurrency("12.00 USD")).toEqual({ amount: 12, currency: "USD" });
    expect(parseMoneyWithCurrency("£9.99")).toEqual({ amount: 9.99, currency: "GBP" });
    expect(parseMoneyWithCurrency("9,99")).toEqual({ amount: 9.99, currency: "EUR" });
    expect(parseMoneyWithCurrency("free")).toBeNull();
  });
});

describe("the statement parser uses it (audit B4)", () => {
  const csv = [
    "Type,Completed Date,Description,Amount,Fee,Currency,State,Balance",
    'Card Payment,2026-01-05 10:00:00,Grouped dot,"-1,234.56",0,EUR,COMPLETED,"2,000.00"',
    'Card Payment,2026-01-06 10:00:00,Grouped comma,"-1.234,56",0,EUR,COMPLETED,"1.000,00"',
  ].join("\n");

  it("does not read a thousands-separated amount 1000x too small", () => {
    const s = parseStatement(csv);
    expect(s.rows.map((r) => r.amount)).toEqual([-1234.56, -1234.56]);
    expect(s.months[0]!.spend).toBe(2469.12);
  });

  it("reads balances at full size, so drift is not 1000x off", () => {
    const s = parseStatement(csv);
    expect(s.openingBalance).toBe(2000);
    expect(s.balance).toBe(1000);
  });

  it("skips a row whose amount is unreadable instead of counting it as zero", () => {
    const s = parseStatement(
      [
        "Type,Completed Date,Description,Amount,Fee,Currency,State,Balance",
        "Card Payment,2026-01-05 10:00:00,Fine,-10.00,0,EUR,COMPLETED,100.00",
        "Card Payment,2026-01-06 10:00:00,Garbled,abc,0,EUR,COMPLETED,90.00",
      ].join("\n"),
    );
    expect(s.rows).toHaveLength(1);
    expect(s.skipped).toBe(1);
  });

  it("treats an empty fee cell as no fee, not as unreadable", () => {
    const s = parseStatement(
      [
        "Type,Completed Date,Description,Amount,Fee,Currency,State,Balance",
        "Card Payment,2026-01-05 10:00:00,Fine,-10.00,,EUR,COMPLETED,100.00",
      ].join("\n"),
    );
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0]!.fee).toBe(0);
    expect(s.skipped).toBe(0);
  });
});

describe("the payslip ledger uses it (audit B4)", () => {
  const table = [
    "| Month | Gross | Net | Tax | Hours | Rate |",
    "| --- | --- | --- | --- | --- | --- |",
    "| 2026-01 | 1.057,06 | 900,50 | 156,56 | 80 | 13,25 |",
    "| 2026-02 | 1,057.06 | 900.50 | 156.56 | 80 | 13.25 |",
  ].join("\n");

  it("reads a hand-edited Dutch row the same as a plain one", () => {
    const rows = parsePayslipTable(table);
    expect(rows.map((r) => r.gross)).toEqual([1057.06, 1057.06]);
    expect(rows.map((r) => r.net)).toEqual([900.5, 900.5]);
    expect(rows.map((r) => r.tax)).toEqual([156.56, 156.56]);
    expect(rows.map((r) => r.rate)).toEqual([13.25, 13.25]);
    expect(rows.map((r) => r.effectiveNet)).toEqual([11.26, 11.26]);
  });
});

describe("the subscriptions ledger keeps the behaviour it already had", () => {
  it("still reads its own formats", () => {
    const table = [
      "| Service | Amount | Cadence | Next |",
      "| --- | --- | --- | --- |",
      "| Netflix | €10,99 | monthly | 2026-10-01 |",
      "| Backblaze | 99.00 USD | yearly | 2026-11-02 |",
    ].join("\n");
    const subs = parseSubscriptions(table, "2026-09-18");
    expect(subs.map((s) => [s.amount, s.currency])).toEqual([
      [10.99, "EUR"],
      [99, "USD"],
    ]);
  });
});
