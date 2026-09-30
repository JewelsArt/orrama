/**
 * A statement's balance and totals must not depend on the order the export
 * lists rows in, and must not mix currencies or pockets.
 */
import { describe, expect, it } from "vitest";
import { parseStatement } from "../src/index.js";

const H = "Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance";
const row = (t: string, product: string, at: string, desc: string, amt: string, cur: string, bal: string) => `${t},${product},${at},${at},${desc},${amt},0.00,${cur},COMPLETED,${bal}`;

describe("statement ordering", () => {
  it("the closing balance is the day's LAST movement, in either export order", () => {
    const rows = [
      row("Card Payment", "Current", "2026-08-31 09:00:00", "Bakery", "-3.00", "EUR", "97.00"),
      row("Card Payment", "Current", "2026-08-31 18:30:00", "Groceries", "-20.00", "EUR", "77.00"),
      row("Topup", "Current", "2026-08-30 12:00:00", "Top-up", "100.00", "EUR", "100.00"),
    ];
    const oldestFirst = parseStatement([H, rows[2], rows[0], rows[1]].join("\n"));
    const newestFirst = parseStatement([H, rows[1], rows[0], rows[2]].join("\n"));
    for (const st of [oldestFirst, newestFirst]) {
      expect(st.balance).toBe(77);
      expect(st.balanceDate).toBe("2026-08-31");
      expect(st.openingBalance).toBe(100);
      expect(st.rows.map((r) => r.description)).toEqual(["Top-up", "Bakery", "Groceries"]);
    }
  });
});

describe("statement currency and pockets", () => {
  it("keeps to the currency most rows use, and counts the rest", () => {
    const st = parseStatement(
      [
        H,
        row("Card Payment", "Current", "2026-08-01 10:00:00", "Cafe", "-4.00", "EUR", "96.00"),
        row("Card Payment", "Current", "2026-08-02 10:00:00", "Books", "-16.00", "EUR", "80.00"),
        row("Card Payment", "Current", "2026-08-03 10:00:00", "NYC hotel", "-400.00", "USD", "600.00"),
      ].join("\n"),
    );
    expect(st.currency).toBe("EUR");
    expect(st.months).toEqual([{ month: "2026-08", spend: 20, fees: 0, refunds: 0, movedIn: 0, movedOut: 0 }]);
    expect(st.balance).toBe(80); // not the dollar pocket's 600
    expect(st.otherCurrency).toBe(1);
    expect(st.skipped).toBe(1);
    expect(st.rows.every((r) => r.currency === "EUR")).toBe(true);
  });

  it("reads the balance from the main pocket, not a Savings row that came last", () => {
    const st = parseStatement(
      [
        H,
        row("Card Payment", "Current", "2026-08-01 10:00:00", "Cafe", "-4.00", "EUR", "96.00"),
        row("Card Payment", "Current", "2026-08-02 10:00:00", "Books", "-16.00", "EUR", "80.00"),
        row("Transfer", "Savings", "2026-08-03 10:00:00", "To pocket", "50.00", "EUR", "1250.00"),
      ].join("\n"),
    );
    expect(st.balance).toBe(80);
    expect(st.balanceDate).toBe("2026-08-02");
  });
});
