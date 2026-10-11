import { describe, expect, it } from "vitest";
import { advance, advanceBy, appendMoneyRow, chargeDates, monthlyTotals, nextCharge, parseLedger, parseSubscriptions, readCadence } from "../src/subscriptions.js";

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

describe("chargeDates counts every charge from the note's own date (audit FIN-003)", () => {
  it("keeps a 31st on the 31st after a 30-day month and after February", () => {
    expect(chargeDates("2026-08-31", "monthly", "2026-09-01", "2027-03-31")).toEqual([
      "2026-09-30",
      "2026-10-31",
      "2026-11-30",
      "2026-12-31",
      "2027-01-31",
      "2027-02-28",
      "2027-03-31",
    ]);
    expect(chargeDates("2026-08-31", "quarterly", "2026-09-01", "2027-06-30")).toEqual(["2026-11-30", "2027-02-28", "2027-05-31"]);
  });

  it("draws the note's own date in its own month, and walks back from it too", () => {
    expect(chargeDates("2026-10-31", "monthly", "2026-10-01", "2026-10-31")).toEqual(["2026-10-31"]);
    expect(chargeDates("2026-10-31", "monthly", "2026-08-01", "2026-08-31")).toEqual(["2026-08-31"]);
    expect(chargeDates("2026-10-31", "monthly", "2027-03-01", "2027-03-31")).toEqual(["2027-03-31"]);
    expect(chargeDates("2026-11-30", "quarterly", "2027-05-01", "2027-05-31")).toEqual(["2027-05-30"]);
    expect(chargeDates("2028-02-29", "yearly", "2032-02-01", "2032-02-29")).toEqual(["2032-02-29"]);
  });

  it("finds the charges before the note's date that a range asks about", () => {
    expect(chargeDates("2026-11-01", "monthly", "2026-09-01", "2026-10-31")).toEqual(["2026-09-01", "2026-10-01"]);
    expect(chargeDates("2026-10-05", "weekly", "2026-09-21", "2026-10-04")).toEqual(["2026-09-21", "2026-09-28"]);
  });

  it("returns nothing for a range that is empty or a date that is not one", () => {
    expect(chargeDates("2026-10-05", "weekly", "2026-10-10", "2026-10-01")).toEqual([]);
    expect(chargeDates("soon", "monthly", "2026-10-01", "2026-10-31")).toEqual([]);
  });

  it("carries the note's date on every line, unrolled", () => {
    const [rent] = parseSubscriptions("| Service | Amount | Every | Next |\n|---|---|---|---|\n| Rent | 609 | monthly | 2026-08-31 |", "2026-09-15");
    expect(rent!.next).toBe("2026-09-30");
    expect(rent!.anchor).toBe("2026-08-31");
  });
});

describe("cadences beyond the four, and no silent monthly (audit FIN-006)", () => {
  const table = (rows: string) => `| Service | Amount | Every | Next |\n|---|---|---|---|\n${rows}`;

  it("reads half-yearly, per semester, biweekly and 4-weekly at their true monthly rate", () => {
    const subs = parseSubscriptions(
      table(
        "| Car insurance | 300 | half-yearly | 2027-01-01 |\n| Tuition | 1300 | per semester | 2027-02-01 |\n| Cleaner | 40 | biweekly | 2026-10-09 |\n| Salary | 1200 | 4-weekly | 2026-10-23 |",
      ),
      "2026-10-02",
    );
    expect(subs.map((s) => [s.service, s.cadence, s.monthly])).toEqual([
      ["Car insurance", "half-yearly", 50],
      ["Tuition", "half-yearly", 216.67],
      ["Cleaner", "biweekly", 86.67],
      ["Salary", "4-weekly", 1300],
    ]);
  });

  it("knows the ways people write them", () => {
    expect(readCadence("every 2 weeks")).toBe("biweekly");
    expect(readCadence("Fortnightly")).toBe("biweekly");
    expect(readCadence("4-wekelijks")).toBe("4-weekly");
    expect(readCadence("every 4 weeks")).toBe("4-weekly");
    expect(readCadence("every 6 months")).toBe("half-yearly");
    expect(readCadence("semi-annual")).toBe("half-yearly");
    expect(readCadence("every 3 months")).toBe("quarterly");
    expect(readCadence("per kwartaal")).toBe("quarterly");
    expect(readCadence("every 2 months")).toBe("2-monthly");
    expect(readCadence("every year")).toBe("yearly");
    expect(readCadence("jaarlijks")).toBe("yearly");
    expect(readCadence("Monthly")).toBe("monthly");
    expect(readCadence("every 5 weeks")).toBeNull();
    // Twice a month to some, every two months to others: not guessed.
    expect(readCadence("bimonthly")).toBeNull();
  });

  it("leaves an unknown cadence out of every total, and says which row", () => {
    const { items, unreadable } = parseLedger(
      table("| Gym | 25 | monthly | 2026-10-05 |\n| Club | 60 | every so often | 2026-10-05 |\n| Cleaner | 40 | biweekly | |"),
      "2026-10-02",
    );
    expect(items.map((s) => s.service)).toEqual(["Gym", "Cleaner"]);
    expect(unreadable).toEqual([{ service: "Club", line: 4, field: "cadence", text: "every so often" }]);
    expect(monthlyTotals(items)).toEqual([{ currency: "EUR", monthly: 111.67 }]);
  });

  it("reports a row whose amount it cannot read instead of dropping it silently", () => {
    const { items, unreadable } = parseLedger(table("| Gym | 10.99 EUR / 12 months | monthly | |\n| Netflix | | monthly | |\n| | | | |"), "2026-10-02");
    expect(items).toEqual([]);
    expect(unreadable).toEqual([
      { service: "Gym", line: 3, field: "amount", text: "10.99 EUR / 12 months" },
      { service: "Netflix", line: 4, field: "amount", text: "" },
    ]);
  });

  it("still reads an empty cadence cell as monthly", () => {
    const [gym] = parseSubscriptions(table("| Gym | 25 |  | |"), "2026-10-02");
    expect(gym!.cadence).toBe("monthly");
    expect(gym!.monthly).toBe(25);
  });

  it("steps the new cadences from the anchor", () => {
    expect(advanceBy("2026-10-09", "biweekly", 1)).toBe("2026-10-23");
    expect(advanceBy("2026-10-23", "4-weekly", 2)).toBe("2026-12-18");
    expect(advanceBy("2026-08-31", "half-yearly", 1)).toBe("2027-02-28");
    expect(advanceBy("2026-08-31", "half-yearly", 2)).toBe("2027-08-31");
    expect(nextCharge("2026-01-02", "biweekly", "2026-10-02")).toBe("2026-10-09");
    expect(chargeDates("2026-10-09", "biweekly", "2026-10-01", "2026-10-31")).toEqual(["2026-10-09", "2026-10-23"]);
  });
});
