import { describe, expect, it } from "vitest";
import { csvDelimiter, parseCsv, parseStatement, parseStatementTable, subscriptionTerms, usefulTerms } from "../src/statement.js";

/** Revolut's export shape, with the four traps the real file contains. */
const CSV = `Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance
Card Payment,Current,2025-12-31 11:55:28,2026-01-01 06:00:46,RELAY,-1.00,0.00,EUR,COMPLETED,857.15
Card Payment,Current,2026-01-04 09:00:00,2026-01-04 09:00:01,"BAR, RESTAURANT",-24.50,0.00,EUR,COMPLETED,832.65
Charge,Current,2026-01-06 00:00:00,2026-01-06 00:00:00,Metal plan fee,0.00,18.99,EUR,COMPLETED,813.66
Transfer,Current,2026-01-08 00:00:00,2026-01-08 00:00:00,To savings,-500.00,0.00,EUR,COMPLETED,313.66
Topup,Current,2026-01-09 00:00:00,2026-01-09 00:00:00,Payment from bank,1000.00,0.00,EUR,COMPLETED,1313.66
Card Payment,Current,2026-01-10 00:00:00,,PENDING SHOP,-85.78,0.00,EUR,PENDING,
Card Payment,Current,2026-01-11 00:00:00,,FAILED SHOP,-49.79,0.00,EUR,REVERTED,
Card Refund,Current,2026-01-12 00:00:00,2026-01-12 00:00:00,RELAY,1.00,0.00,EUR,COMPLETED,1314.66
Card Payment,Current,2026-02-02 00:00:00,2026-02-02 00:00:00,NETFLIX.COM 866-579,-13.99,0.00,EUR,COMPLETED,1300.67
`;

describe("parseCsv", () => {
  it("keeps a quoted comma inside one field", () => {
    // The trap: split(",") turns "BAR, RESTAURANT" into two fields and shifts
    // every column after it, so the amount is read from the wrong place.
    const rows = parseCsv(CSV);
    const bar = rows.find((r) => r[4]?.startsWith("BAR"))!;
    expect(bar[4]).toBe("BAR, RESTAURANT");
    expect(bar[5]).toBe("-24.50");
  });

  it("handles escaped quotes, CRLF and a BOM", () => {
    const rows = parseCsv('﻿a,b\r\n"say ""hi""",2\r\n');
    expect(rows).toEqual([
      ["a", "b"],
      ['say "hi"', "2"],
    ]);
  });
});

describe("parseStatement", () => {
  it("drops rows that never settled", () => {
    const s = parseStatement(CSV);
    expect(s.skipped).toBe(2); // one PENDING, one REVERTED
    expect(s.rows.some((r) => r.description.includes("PENDING"))).toBe(false);
  });

  it("dates a row by when the money moved, not when it started", () => {
    // Started 2025-12-31, completed 2026-01-01 → January.
    const s = parseStatement(CSV);
    expect(s.rows[0]!.date).toBe("2026-01-01");
    expect(s.months.map((m) => m.month)).toEqual(["2026-01", "2026-02"]);
  });

  it("counts a fee as spending even though Amount is zero", () => {
    const jan = parseStatement(CSV).months[0]!;
    // 1.00 + 24.50 card, plus an 18.99 fee that appears in no Amount.
    expect(jan.fees).toBe(18.99);
    expect(jan.spend).toBe(44.49);
  });

  it("keeps transfers and topups out of spending entirely", () => {
    const jan = parseStatement(CSV).months[0]!;
    expect(jan.movedOut).toBe(500);
    expect(jan.movedIn).toBe(1000);
    // The 500 out and 1000 in touch neither spend nor income.
    expect(jan.spend).toBe(44.49);
  });

  it("takes the balance from the last settled row, not by summing", () => {
    const s = parseStatement(CSV);
    expect(s.balance).toBe(1300.67);
    expect(s.balanceDate).toBe("2026-02-02");
  });

  it("tracks refunds separately from spending", () => {
    expect(parseStatement(CSV).months[0]!.refunds).toBe(1);
  });

  it("survives an empty or headerless file", () => {
    expect(parseStatement("").rows).toEqual([]);
    expect(parseStatement("just some text\n").rows).toEqual([]);
  });
});

describe("usefulTerms", () => {
  const merchants = [
    "ALBERT HEIJN",
    "BCK BE BOULDER AMSTERDAM",
    "BEEST BOULDERS ADAM",
    "AMSTERDAM BIJLMER",
    "LS PANTOPIA AMSTERDAM",
    "ADOBE",
    "METAL PLAN FEE",
  ];

  it("drops a term that matches many merchants", () => {
    // The real bug: "Amsterdam University of Applied Sciences" contributed the
    // word "amsterdam", which claimed three unrelated merchants.
    expect(usefulTerms(["amsterdam"], merchants)).toEqual([]);
  });

  it("keeps a term that resolves to a single merchant", () => {
    expect(usefulTerms(["adobe", "metal"], merchants)).toEqual(["adobe", "metal"]);
  });

  it("drops a term that matches nothing on this statement", () => {
    // A subscription paid by transfer never appears among card merchants.
    expect(usefulTerms(["netflix"], merchants)).toEqual([]);
  });

  it("filters the terms a subscription name generates", () => {
    const terms = subscriptionTerms("Amsterdam University of Applied Sciences");
    expect(terms).toContain("amsterdam");
    expect(usefulTerms(terms, merchants)).toEqual([]);
  });
});

describe("statements the parser used to store and ignore (audit FIN-007)", () => {
  const plain = [
    "Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance",
    "Card Payment,Current,2026-06-10 10:00:00,2026-06-10 10:00:00,ALBERT HEIJN,-300.00,0.00,EUR,COMPLETED,700.00",
    'Card Payment,Current,2026-07-10 10:00:00,2026-07-10 10:00:00,"BAR, RESTAURANT",-12.50,0.00,EUR,COMPLETED,687.50',
  ];

  it("reads a CSV Excel saved with semicolons and decimal commas", () => {
    const excel = [
      "Type;Product;Started Date;Completed Date;Description;Amount;Fee;Currency;State;Balance",
      "Card Payment;Current;2026-06-10 10:00:00;2026-06-10 10:00:00;ALBERT HEIJN;-300,00;0,00;EUR;COMPLETED;700,00",
      'Card Payment;Current;2026-07-10 10:00:00;2026-07-10 10:00:00;"BAR; RESTAURANT";-12,50;0,00;EUR;COMPLETED;687,50',
    ].join("\n");
    expect(csvDelimiter(excel)).toBe(";");
    const s = parseStatement(excel);
    expect(s.rows.map((r) => [r.description, r.amount])).toEqual([
      ["ALBERT HEIJN", -300],
      ["BAR; RESTAURANT", -12.5],
    ]);
    expect(s.balance).toBe(687.5);
    expect(s.problem).toBeNull();
  });

  it("still reads a comma CSV whose descriptions hold semicolons", () => {
    const s = parseStatement([...plain, "Card Payment,Current,2026-07-11 10:00:00,2026-07-11 10:00:00,A;B;C;D,-1.00,0.00,EUR,COMPLETED,686.50"].join("\n"));
    expect(s.rows).toHaveLength(3);
  });

  it("reads the day-month-year dates Excel writes back under a Dutch locale", () => {
    const s = parseStatement(
      [
        "Type;Completed Date;Description;Amount;Currency;State;Balance",
        "Card Payment;10-6-2026 10:00;ALBERT HEIJN;-300,00;EUR;COMPLETED;700,00",
        "Card Payment;1-7-2026 09:05;JUMBO;-20,00;EUR;COMPLETED;680,00",
      ].join("\n"),
    );
    expect(s.rows.map((r) => [r.date, r.at])).toEqual([
      ["2026-06-10", "2026-06-10 10:00:00"],
      ["2026-07-01", "2026-07-01 09:05:00"],
    ]);
  });

  it("takes a workbook's numbers as numbers", () => {
    const s = parseStatementTable([
      ["Type", "Completed Date", "Description", "Amount", "Fee", "Currency", "State", "Balance"],
      ["Card Payment", "2026-06-10 10:00:00", "ALBERT HEIJN", -1.234, 0, "EUR", "COMPLETED", 1000],
    ]);
    expect(s.rows[0]!.amount).toBe(-1.234);
    expect(s.balance).toBe(1000);
  });

  it("says why nothing could be read", () => {
    expect(parseStatement("Date;Omschrijving;Bedrag\n2026-06-10;AH;-3,00").problem).toBe("its header has no Amount column");
    expect(parseStatement("").problem).toBe("it has no rows");
    expect(parseStatement("Completed Date,Description,Amount,State\n6/10/2026,AH,-3.00,COMPLETED").problem).toMatch(/none of its 1 rows/);
    expect(parseStatement(plain.join("\n")).problem).toBeNull();
  });
});
