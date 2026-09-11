import { describe, expect, it } from "vitest";
import { parseCsv, parseStatement, splitFixed, subscriptionTerms, usefulTerms } from "../src/statement.js";

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

describe("splitFixed", () => {
  it("matches a card descriptor against a subscription name", () => {
    const { fixed, variable, matched } = splitFixed(parseStatement(CSV).rows, ["Netflix", "Revolut Metal Plan"]);
    // "NETFLIX.COM 866-579" matches on the name itself. The plan fee reads
    // "Metal plan fee" and never says Revolut, so it is caught by the
    // distinctive word "metal" — which is why matching is not just first-word.
    expect(matched).toEqual(expect.arrayContaining(["netflix", "revolut metal plan"]));
    expect(fixed).toBe(32.98); // 13.99 Netflix + 18.99 plan fee
    expect(variable).toBe(25.5); // 1.00 + 24.50 of ordinary card spend
  });

  it("does not let a generic word in a subscription name match everything", () => {
    // "Family" alone would hit any merchant with the word in its descriptor.
    const { fixed } = splitFixed(parseStatement(CSV).rows, ["Youtube Family"]);
    expect(fixed).toBe(0);
  });

  it("puts everything in variable when nothing is known to be fixed", () => {
    const { fixed, variable } = splitFixed(parseStatement(CSV).rows, []);
    expect(fixed).toBe(0);
    expect(variable).toBe(58.48);
  });

  it("ignores subscription names too short to match safely", () => {
    // "Go" would hit half the merchants on any statement.
    const { fixed } = splitFixed(parseStatement(CSV).rows, ["Go"]);
    expect(fixed).toBe(0);
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
