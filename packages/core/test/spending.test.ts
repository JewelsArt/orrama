import { describe, expect, it } from "vitest";
import { completeMonths, forecast, merchantsByCategory, monthlyByCategory, parseCategoryRules, categoryOf, UNCATEGORISED } from "../src/spending.js";
import type { StatementRow } from "../src/statement.js";

const RULES = parseCategoryRules(`
| Category  | Matches                   | Colour  |
|-----------|---------------------------|---------|
| Groceries | albert heijn, lidl        | #22c993 |
| Eating out| uber eats, doner          |         |
| Transport | ovpay, uber               |         |
`);

let seq = 0;
const row = (date: string, description: string, amount: number, fee = 0): StatementRow => ({
  key: `row-${++seq}`, // each helper row is its own transaction
  date,
  type: "Card Payment",
  description,
  amount: -amount,
  fee,
  currency: "EUR",
  balance: null,
  flow: "spend",
});

describe("parseCategoryRules", () => {
  it("reads categories, comma-separated matches and an optional colour", () => {
    expect(RULES).toHaveLength(3);
    expect(RULES[0]).toEqual({ category: "Groceries", matches: ["albert heijn", "lidl"], colour: "#22c993" });
    expect(RULES[1]!.colour).toBeNull();
  });

  it("skips rows with no category or no matches", () => {
    const r = parseCategoryRules("| Category | Matches |\n|---|---|\n| Empty |  |\n|  | orphan |\n");
    expect(r).toEqual([]);
  });
});

describe("categoryOf", () => {
  it("lets the longest match win, so a meal is not filed as a taxi", () => {
    // Both "uber" and "uber eats" match; the specific one has to win.
    expect(categoryOf("UBER EATS AMSTERDAM", RULES)).toBe("Eating out");
    expect(categoryOf("UBER *TRIP", RULES)).toBe("Transport");
  });

  it("is case-insensitive and matches inside a longer descriptor", () => {
    expect(categoryOf("ALBERT HEIJN 1234 AMSTERDAM", RULES)).toBe("Groceries");
  });

  it("ignores accents on both sides", () => {
    // Card descriptors are inconsistent about diacritics; "doner" must find it.
    expect(categoryOf("THE DÖNER COMPANY", RULES)).toBe("Eating out");
  });

  it("will not match a term shorter than three characters as a substring", () => {
    // "ns" inside "HANS EN GRIETJE" is the classic accident.
    const r = parseCategoryRules("| Category | Matches |\n|---|---|\n| Transport | ns |\n");
    expect(categoryOf("HANS EN GRIETJE", r)).toBe(UNCATEGORISED);
  });

  it("matches a short name written with = against the whole description", () => {
    const r = parseCategoryRules("| Category | Matches |\n|---|---|\n| Transport | =ns |\n");
    expect(categoryOf("NS", r)).toBe("Transport");
    expect(categoryOf("HANS EN GRIETJE", r)).toBe(UNCATEGORISED);
  });

  it("lets an exact term win over a longer accidental substring", () => {
    const r = parseCategoryRules(
      "| Category | Matches |\n|---|---|\n| Transport | =free |\n| Shopping | freezer outlet |\n",
    );
    expect(categoryOf("FREE", r)).toBe("Transport");
  });

  it("falls back to Other rather than guessing", () => {
    expect(categoryOf("SOME NEW SHOP", RULES)).toBe(UNCATEGORISED);
  });
});

describe("monthlyByCategory", () => {
  it("totals each category per month, fees included", () => {
    const m = monthlyByCategory(
      [row("2026-01-05", "ALBERT HEIJN", 40), row("2026-01-20", "LIDL", 10), row("2026-01-06", "METAL PLAN FEE", 0, 18.99)],
      RULES,
    );
    expect(m[0]!.byCategory).toEqual({ Groceries: 50, [UNCATEGORISED]: 18.99 });
    expect(m[0]!.total).toBe(68.99);
  });
});

describe("completeMonths", () => {
  const months = monthlyByCategory(
    [row("2026-07-05", "LIDL", 10), row("2026-08-05", "LIDL", 20), row("2026-09-02", "LIDL", 1)],
    RULES,
  );

  it("drops the month the statement stops inside", () => {
    // Exported on the 3rd: September holds three days and would drag every
    // average down if it counted.
    expect(completeMonths(months, "2026-09-03").map((m) => m.month)).toEqual(["2026-07", "2026-08"]);
  });

  it("keeps a final month that ran to its last day", () => {
    expect(completeMonths(months, "2026-09-30").map((m) => m.month)).toEqual(["2026-07", "2026-08", "2026-09"]);
  });
});

describe("forecast", () => {
  const build = (amounts: number[]) =>
    monthlyByCategory(
      amounts.map((a, i) => row(`2026-0${i + 1}-10`, "ALBERT HEIJN", a)),
      RULES,
    );

  it("uses the median, so one big month does not become the expectation", () => {
    const f = forecast(build([100, 110, 105, 900]));
    expect(f[0]!.typical).toBe(107.5); // not the 303.75 mean
    expect(f[0]!.high).toBe(900);
    expect(f[0]!.low).toBe(100);
  });

  it("counts a month with no spending in that category as zero, not as missing", () => {
    const months = monthlyByCategory(
      [row("2026-01-10", "ALBERT HEIJN", 90), row("2026-02-10", "LIDL", 30), row("2026-03-10", "UBER EATS", 40)],
      RULES,
    );
    const eating = forecast(months).find((f) => f.category === "Eating out")!;
    // Bought once in three months: typical is 0, not 40.
    expect(eating.typical).toBe(0);
    expect(eating.high).toBe(40);
  });

  it("says nothing at all below three complete months", () => {
    expect(forecast(build([100, 110]))).toEqual([]);
  });

  it("reports the most recent month alongside the typical figure", () => {
    const f = forecast(build([100, 110, 105, 200]));
    expect(f[0]!.last).toBe(200);
    expect(f[0]!.months).toBe(4);
  });
});

describe("merchantsByCategory", () => {
  const rows = [
    row("2026-01-05", "Albert Heijn 1234", 40),
    row("2026-01-09", "ALBERT HEIJN 1234", 30),
    row("2026-01-20", "LIDL", 10),
    row("2026-02-02", "UBER EATS", 25),
  ];

  it("groups repeats of the same merchant and ranks by spend", () => {
    const m = merchantsByCategory(rows, RULES);
    expect(m.Groceries).toEqual([
      { name: "ALBERT HEIJN 1234", total: 70, count: 2 },
      { name: "LIDL", total: 10, count: 1 },
    ]);
  });

  it("keeps the descriptor as the bank wrote it, bar case and spacing", () => {
    // Store numbers stay: they are how the statement identifies the shop.
    expect(merchantsByCategory(rows, RULES).Groceries![0]!.name).toContain("1234");
  });

  it("caps the list per category", () => {
    const many = Array.from({ length: 9 }, (_, i) => row("2026-01-05", `LIDL ${i}`, 10 + i));
    expect(merchantsByCategory(many, RULES, 3).Groceries).toHaveLength(3);
  });
});

describe("pinned categories", () => {
  // Adobe is software AND a subscription. A pinned Subscriptions rule decides
  // which of the two it is filed under, whatever the rules note says.
  const withSubs = [
    ...RULES,
    { category: "Software", matches: ["adobe creative cloud"], colour: null },
    { category: "Subscriptions", matches: ["adobe", "metal"], colour: null, pinned: true },
  ];

  it("beats a longer unpinned match", () => {
    expect(categoryOf("ADOBE CREATIVE CLOUD", withSubs)).toBe("Subscriptions");
  });

  it("beats an exact unpinned match too", () => {
    const rules = [
      { category: "Transport", matches: ["=free"], colour: null },
      { category: "Subscriptions", matches: ["free"], colour: null, pinned: true },
    ];
    expect(categoryOf("FREE", rules)).toBe("Subscriptions");
  });

  it("leaves everything it does not match alone", () => {
    expect(categoryOf("ALBERT HEIJN", withSubs)).toBe("Groceries");
  });
});

describe("transfers count only when the rules name them", () => {
  const row = (description: string, amount: number, flow: "spend" | "moved") =>
    ({ date: "2026-01-05", description, amount, fee: 0, flow, type: "Transfer", balance: null, currency: "EUR" }) as never;
  const rules = [{ category: "Rent", matches: ["stichting duwo"], colour: null }];

  it("counts a transfer the rules note has claimed", () => {
    const months = monthlyByCategory([row("To Stichting DUWO", -608.99, "moved")], rules);
    expect(months[0]!.byCategory["Rent"]).toBe(608.99);
    expect(months[0]!.total).toBe(608.99);
  });

  it("leaves an unnamed transfer out entirely, rather than filing it as Other", () => {
    const months = monthlyByCategory([row("To WAEL BOUAYSS", -900, "moved")], rules);
    expect(months).toEqual([]);
  });

  it("never counts money coming in, however well it matches", () => {
    const months = monthlyByCategory([row("From Stichting DUWO", 757.53, "moved")], rules);
    expect(months).toEqual([]);
  });

  it("still counts an uncategorised CARD payment as Other", () => {
    const months = monthlyByCategory([row("SOME SHOP", -20, "spend")], rules);
    expect(months[0]!.byCategory["Other"]).toBe(20);
  });
});
