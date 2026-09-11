import { describe, expect, it } from "vitest";
import { advance, appendMoneyRow, monthlyTotals, nextCharge, parseSubscriptions } from "../src/subscriptions.js";

const NOTE = `---
title: Subscriptions
tags: [subscriptions]
---
# Subscriptions

What leaves the account every month.

| Service  | Amount  | Every     | Next       | Note        |
|----------|---------|-----------|------------|-------------|
| Spotify  | 10,99   | monthly   | 2026-09-14 | family plan |
| Adobe CC | €24.19  | monthly   | 2026-09-21 |             |
| Domain   | 14.00   | yearly    | 2027-02-03 |             |
| Gym      | $30     | weekly    | 2026-09-03 |             |

## Cancelled
- Netflix, stopped in June
`;

const TODAY = "2026-09-02";

describe("parseSubscriptions", () => {
  it("reads a hand-written table, symbols and both decimal conventions", () => {
    const subs = parseSubscriptions(NOTE, TODAY);
    expect(subs.map((s) => s.service)).toEqual(["Spotify", "Adobe CC", "Domain", "Gym"]);
    expect(subs[0]!.amount).toBe(10.99); // "10,99" — comma as decimal point
    expect(subs[1]!.amount).toBe(24.19);
    expect(subs[1]!.currency).toBe("EUR"); // from the € symbol
    expect(subs[3]!.currency).toBe("USD");
    expect(subs[0]!.note).toBe("family plan");
  });

  it("normalises every cadence to a monthly figure that can be summed", () => {
    const subs = parseSubscriptions(NOTE, TODAY);
    expect(subs[0]!.monthly).toBe(10.99); // monthly
    expect(subs[2]!.monthly).toBe(1.17); // 14 / 12
    expect(subs[3]!.monthly).toBe(130); // 30 * 52/12
  });

  it("keeps currencies apart rather than adding euros to dollars", () => {
    expect(monthlyTotals(parseSubscriptions(NOTE, TODAY))).toEqual([
      { currency: "USD", monthly: 130 },
      { currency: "EUR", monthly: 36.35 },
    ]);
  });

  it("matches columns by header name, so reordering them is safe", () => {
    const reordered = `| Next | Service | Every | Amount |
|---|---|---|---|
| 2026-09-14 | Spotify | monthly | 10.99 |`;
    const [s] = parseSubscriptions(reordered, TODAY);
    expect(s).toMatchObject({ service: "Spotify", amount: 10.99, next: "2026-09-14" });
  });

  it("ignores tables that are not subscriptions, and unreadable rows", () => {
    const other = `| Day | Weather |
|---|---|
| Mon | rain |

| Service | Amount |
|---|---|
| Spotify | 10.99 |
| Broken  | n/a   |`;
    expect(parseSubscriptions(other, TODAY).map((s) => s.service)).toEqual(["Spotify"]);
  });

  it("rolls a stale next date forward instead of showing a phantom overdue charge", () => {
    // Left untouched since May; the charge has kept happening.
    const stale = `| Service | Amount | Every | Next |
|---|---|---|---|
| Spotify | 10.99 | monthly | 2026-05-14 |`;
    expect(parseSubscriptions(stale, TODAY)[0]!.next).toBe("2026-09-14");
  });

  it("clamps a month-end charge instead of rolling it into the next month", () => {
    expect(advance("2026-01-31", "monthly")).toBe("2026-02-28");
    expect(advance("2026-03-31", "monthly")).toBe("2026-04-30");
    expect(advance("2026-12-15", "monthly")).toBe("2027-01-15");
  });

  it("leaves a future date alone and terminates on a far-past one", () => {
    expect(nextCharge("2027-01-01", "monthly", TODAY)).toBe("2027-01-01");
    // 2015-01-05 is a Monday; stepping by weeks stays on Mondays, and the
    // first one on or after 2026-09-02 is Monday 2026-09-07.
    expect(nextCharge("2015-01-05", "weekly", TODAY)).toBe("2026-09-07");
  });

  it("returns nothing for a note with no table", () => {
    expect(parseSubscriptions("# Subscriptions\n\nNone yet.\n", TODAY)).toEqual([]);
  });

  it("reads an income table, which names the same column differently", () => {
    const income = `| Source   | Amount | Every   | Next       |
|----------|--------|---------|------------|
| Scooperz | 2400   | monthly | 2026-09-25 |`;
    expect(parseSubscriptions(income, TODAY)[0]).toMatchObject({ service: "Scooperz", amount: 2400, monthly: 2400 });
  });
});

describe("appendMoneyRow", () => {
  const ROW = { service: "Netflix", amount: "13.99", cadence: "monthly", next: "2026-09-20", note: "" };

  it("appends after the last row of the table", () => {
    const out = appendMoneyRow(NOTE, ROW)!;
    const rows = out.split("\n").filter((l) => l.startsWith("| "));
    expect(rows[rows.length - 1]).toBe("| Netflix | 13.99 | monthly | 2026-09-20 |  |");
    // and the note around it is untouched
    expect(out).toContain("## Cancelled");
    expect(parseSubscriptions(out, TODAY)).toHaveLength(5);
  });

  it("fills an empty table that has only a header", () => {
    const empty = `# Subscriptions\n\n| Service | Amount | Every | Next | Note |\n|---|---|---|---|---|\n\n## Cancelled\n`;
    const out = appendMoneyRow(empty, ROW)!;
    expect(parseSubscriptions(out, TODAY)).toHaveLength(1);
    expect(out.trimEnd().endsWith("## Cancelled")).toBe(true);
  });

  it("writes cells in the table's own column order", () => {
    const reordered = `| Next | Service | Every | Amount |\n|---|---|---|---|\n| 2026-09-14 | Spotify | monthly | 10.99 |`;
    const out = appendMoneyRow(reordered, ROW)!;
    expect(out.split("\n").pop()).toBe("| 2026-09-20 | Netflix | monthly | 13.99 |");
  });

  it("escapes pipes and newlines so one field cannot become two", () => {
    const out = appendMoneyRow(NOTE, { ...ROW, service: "A | B", note: "line\nbreak" })!;
    const added = out.split("\n").find((l) => l.includes("A "))!;
    expect(added.split("|")).toHaveLength(7); // 5 cells + the two outer edges
    expect(parseSubscriptions(out, TODAY).some((x) => x.service === "A   B")).toBe(true);
  });

  it("refuses a note with no money table rather than inventing one", () => {
    expect(appendMoneyRow("# Notes\n\nNothing here.\n", ROW)).toBeNull();
  });

  it("does not touch a later, unrelated table", () => {
    const two = `| Service | Amount |\n|---|---|\n| Spotify | 10.99 |\n\n| Day | Weather |\n|---|---|\n| Mon | rain |`;
    const out = appendMoneyRow(two, ROW)!;
    expect(out.indexOf("Netflix")).toBeLessThan(out.indexOf("Weather"));
  });
});

describe("an explicit statement descriptor", () => {
  it("reads a Match column, comma-separated and lowercased", () => {
    const subs = parseSubscriptions(
      [
        "| Service | Amount | Every | Next | Match |",
        "|---|---|---|---|---|",
        "| Rent | 608.99 | monthly | 2026-09-02 | Stichting DUWO, DUWO |",
      ].join("\n"),
      "2026-09-01",
    );
    expect(subs[0]!.match).toEqual(["stichting duwo", "duwo"]);
  });

  it("accepts the column under any of its names, and defaults to empty", () => {
    for (const header of ["Match", "Matches", "On statement", "Descriptor"]) {
      const subs = parseSubscriptions(
        [`| Service | Amount | ${header} |`, "|---|---|---|", "| Adobe | 19.66 | ADOBE |"].join("\n"),
        "2026-09-01",
      );
      expect(subs[0]!.match).toEqual(["adobe"]);
    }
    const none = parseSubscriptions(
      ["| Service | Amount |", "|---|---|", "| Adobe | 19.66 |"].join("\n"),
      "2026-09-01",
    );
    expect(none[0]!.match).toEqual([]);
  });
});
