/**
 * The ledger writers (stage 1, 1G): a screen changes one row of a ledger the way a person would
 * in the note. That line and nothing else: other rows, unknown columns, rows the ledger cannot
 * read and the note's line endings stay byte for byte, and a change made against a version of
 * the table that is no longer there is refused rather than applied to the wrong row.
 */
import { describe, expect, it } from "vitest";
import {
  appendCategoryRow,
  appendOwnAccountRow,
  categoryTable,
  changeCategoryRow,
  changeMoneyRow,
  changeOwnAccountRow,
  changePayslipRow,
  fileShopUnder,
  moneyTable,
  moveCategoryRow,
  ownAccountTable,
  parseCategoryRules,
  parseLedger,
  parseOwnAccounts,
  parsePayslipTable,
  payslipTable,
  removeCategoryRow,
  removeMoneyRow,
  removeOwnAccountRow,
  removePayslipRow,
  ruleFor,
  shopTerm,
  tableHead,
  appendPayslipRow,
  typedPayslip,
} from "../src/index.js";

const SUBS = [
  "---",
  "title: Subscriptions",
  "tags: [subscriptions]",
  "---",
  "# Subscriptions",
  "",
  "Written by hand, columns in my own order.",
  "",
  "| Service  | Every   | Amount | Next       | Card   | Note        |",
  "|----------|---------|--------|------------|--------|-------------|",
  "| Spotify  | monthly | 10,99  | 2026-09-14 | visa   | family plan |",
  "| Club     | every so often | 60 | 2026-10-05 | cash |           |",
  "| Adobe CC | monthly | €24.19 | 2026-09-21 | visa   |             |",
  "",
  "## Cancelled",
  "- Netflix",
  "",
].join("\n");

const crlf = (s: string) => s.replace(/\n/g, "\r\n");
const ref = (t: ReturnType<typeof moneyTable>, name: string) => {
  const row = t.rows.find((r) => r.name === name)!;
  return { index: row.index, name: row.name, version: t.version };
};
const ok = (w: { ok: boolean; content?: string; reason?: string }): string => {
  if (!w.ok) throw new Error(`refused: ${w.reason}`);
  return w.content!;
};

describe("moneyTable: a ledger's rows as written", () => {
  it("lists every row with its cells by field, unreadable rows included, at their lines", () => {
    const t = moneyTable(SUBS);
    expect(t.rows.map((r) => [r.index, r.line, r.name])).toEqual([
      [0, 11, "Spotify"],
      [1, 12, "Club"],
      [2, 13, "Adobe CC"],
    ]);
    expect(t.rows[1]!.cells).toEqual({ service: "Club", cadence: "every so often", amount: "60", next: "2026-10-05", note: "" });
    expect(t.fields).toEqual(["service", "cadence", "amount", "next", "note"]);
  });

  it("the parser reads exactly what it read before, and each item now names the line its row is on", () => {
    // The whole reading, pinned: `line` is the one field added (1G), every other value as before.
    expect(parseLedger(SUBS, "2026-09-01")).toEqual({
      items: [
        { service: "Spotify", amount: 10.99, currency: "EUR", cadence: "monthly", next: "2026-09-14", anchor: "2026-09-14", monthly: 10.99, match: [], category: "", note: "family plan", line: 11 },
        { service: "Adobe CC", amount: 24.19, currency: "EUR", cadence: "monthly", next: "2026-09-21", anchor: "2026-09-21", monthly: 24.19, match: [], category: "", note: "", line: 13 },
      ],
      unreadable: [{ service: "Club", line: 12, field: "cadence", text: "every so often" }],
    });
  });

  it("a blank row is not listed but keeps its place, so the rows after it are still found", () => {
    const note = "| Service | Amount |\n|---|---|\n| A | 1 |\n|  |  |\n| B | 2 |\n";
    const t = moneyTable(note);
    expect(t.rows.map((r) => [r.index, r.name])).toEqual([
      [0, "A"],
      [2, "B"],
    ]);
    expect(ok(changeMoneyRow(note, ref(t, "B"), { amount: "3" }))).toBe(note.replace("| B | 2 |", "| B | 3 |"));
  });

  it("the version moves when a row does and stays when only the prose around it does", () => {
    const v = moneyTable(SUBS).version;
    expect(moneyTable(SUBS.replace("Written by hand", "Typed by hand")).version).toBe(v);
    expect(moneyTable(SUBS.replace("10,99", "11,99")).version).not.toBe(v);
  });
});

describe("changeMoneyRow", () => {
  it("rewrites that line only: an unknown column keeps its cell, every other byte stays", () => {
    const t = moneyTable(SUBS);
    const out = ok(changeMoneyRow(SUBS, ref(t, "Spotify"), { amount: "12.99", cadence: "yearly" }));
    const before = SUBS.split("\n");
    const after = out.split("\n");
    expect(after.length).toBe(before.length);
    expect(after.filter((l, i) => l !== before[i])).toEqual(["| Spotify | yearly | 12.99 | 2026-09-14 | visa | family plan |"]);
    expect(parseLedger(out, "2026-09-01").items[0]).toMatchObject({ service: "Spotify", amount: 12.99, cadence: "yearly" });
  });

  it("keeps a CRLF note CRLF, every line of it", () => {
    const note = crlf(SUBS);
    const out = ok(changeMoneyRow(note, ref(moneyTable(note), "Adobe CC"), { note: "work" }));
    expect(out.split("\r\n").length).toBe(note.split("\r\n").length);
    expect(out.replace(/\r\n/g, "")).not.toMatch(/\n/);
    expect(out).toContain("| Adobe CC | monthly | €24.19 | 2026-09-21 | visa | work |\r\n");
  });

  it("can fix the row the ledger could not read, and leaves it alone when changing another", () => {
    const t = moneyTable(SUBS);
    const other = ok(changeMoneyRow(SUBS, ref(t, "Adobe CC"), { amount: "25" }));
    expect(other).toContain("| Club     | every so often | 60 | 2026-10-05 | cash |           |");
    const fixed = ok(changeMoneyRow(SUBS, ref(t, "Club"), { cadence: "quarterly" }));
    expect(parseLedger(fixed, "2026-09-01").unreadable).toEqual([]);
  });

  it("refuses a change made against a table that has changed since: 409, nothing written", () => {
    const t = moneyTable(SUBS);
    const edited = SUBS.replace("| Spotify  |", "| Spotify Duo |");
    const stale = changeMoneyRow(edited, ref(t, "Adobe CC"), { amount: "1" });
    expect(stale).toMatchObject({ ok: false, status: 409 });
    // A row inserted above shifts every index: the old index must not land on the wrong row.
    const inserted = SUBS.replace("| Spotify ", "| Netflix | monthly | 9 | 2026-09-01 | visa | |\n| Spotify ");
    expect(changeMoneyRow(inserted, ref(t, "Spotify"), { amount: "1" })).toMatchObject({ ok: false, status: 409 });
    // The right version but the wrong name is a stale screen too.
    expect(changeMoneyRow(SUBS, { ...ref(t, "Spotify"), name: "Adobe CC" }, { amount: "1" })).toMatchObject({ ok: false, status: 409 });
  });

  it("refuses a field the table has no column for, rather than dropping what was typed", () => {
    const bare = "| Service | Amount |\n|---|---|\n| Gym | 30 |\n";
    const t = moneyTable(bare);
    expect(changeMoneyRow(bare, ref(t, "Gym"), { note: "student price" })).toMatchObject({ ok: false, status: 422 });
  });

  it("a pipe or a newline typed in a value cannot split the row", () => {
    const out = ok(changeMoneyRow(SUBS, ref(moneyTable(SUBS), "Spotify"), { note: "a | b\nc" }));
    expect(parseLedger(out, "2026-09-01").items[0]!.note).toBe("a   b c");
  });
});

describe("removeMoneyRow", () => {
  it("takes that line out and nothing else, CRLF kept", () => {
    const note = crlf(SUBS);
    const out = ok(removeMoneyRow(note, ref(moneyTable(note), "Spotify")));
    expect(out).toBe(note.replace("| Spotify  | monthly | 10,99  | 2026-09-14 | visa   | family plan |\r\n", ""));
  });

  it("refuses a stale remove", () => {
    const t = moneyTable(SUBS);
    expect(removeMoneyRow(SUBS.replace("€24.19", "€25"), ref(t, "Spotify"))).toMatchObject({ ok: false, status: 409 });
  });
});

describe("a round trip without a change", () => {
  it("leaves the note byte-identical, hand padding included, whatever ledger", () => {
    const t = moneyTable(SUBS);
    for (const row of t.rows) {
      const same = changeMoneyRow(SUBS, { index: row.index, name: row.name, version: t.version }, row.cells);
      expect(ok(same)).toBe(SUBS);
    }
    const note = crlf(SUBS);
    expect(ok(changeMoneyRow(note, ref(moneyTable(note), "Spotify"), {}))).toBe(note);
    const cats = "| Category | Matches  | Colour |\n|---|---|---|\n| Groceries | albert heijn, =ah | pink |\n";
    const c = categoryTable(cats);
    expect(ok(changeCategoryRow(cats, { index: 0, name: "Groceries", version: c.version }, c.rows[0]!.cells))).toBe(cats);
  });
});

const CATS = ["# Spending categories", "", "| Category | Matches | Colour |", "|---|---|---|", "| Groceries | albert heijn, jumbo | pink |", "| Shopping | uniqlo, albert | cyan |", "| Empty one |  | |", "| Eating out | thuisbezorgd | |", ""].join("\n");

describe("the categories, changed from a screen", () => {
  it("lists a category with no words yet, which the figures' parser leaves out", () => {
    expect(categoryTable(CATS).rows.map((r) => r.name)).toEqual(["Groceries", "Shopping", "Empty one", "Eating out"]);
    expect(parseCategoryRules(CATS).map((r) => r.category)).toEqual(["Groceries", "Shopping", "Eating out"]);
  });

  it("moves a category up or down inside its table: the order is the colours' order", () => {
    const t = categoryTable(CATS);
    const r = (n: string) => ({ index: t.rows.find((x) => x.name === n)!.index, name: n, version: t.version });
    const up = ok(moveCategoryRow(CATS, r("Eating out"), 0));
    expect(parseCategoryRules(up).map((x) => x.category)).toEqual(["Eating out", "Groceries", "Shopping"]);
    const down = ok(moveCategoryRow(CATS, r("Groceries"), 2));
    expect(categoryTable(down).rows.map((x) => x.name)).toEqual(["Shopping", "Empty one", "Groceries", "Eating out"]);
    // The lines around the table are untouched.
    expect(down.split("\n").slice(0, 4)).toEqual(CATS.split("\n").slice(0, 4));
    expect(moveCategoryRow(CATS, r("Groceries"), 9)).toMatchObject({ ok: false, status: 422 });
  });

  it("renames, removes and adds a category", () => {
    const t = categoryTable(CATS);
    const g = { index: 0, name: "Groceries", version: t.version };
    expect(parseCategoryRules(ok(changeCategoryRow(CATS, g, { category: "Food" })))[0]!.category).toBe("Food");
    expect(parseCategoryRules(ok(removeCategoryRow(CATS, g))).map((x) => x.category)).toEqual(["Shopping", "Eating out"]);
    const added = appendCategoryRow(CATS, { category: "Transport", matches: "ns, =gvb" })!;
    expect(parseCategoryRules(added).at(-1)).toEqual({ category: "Transport", matches: ["ns", "=gvb"], colour: null });
  });
});

describe("fileShopUnder: put a shop in a category", () => {
  const rulesOf = (note: string) => parseCategoryRules(note);

  it("moves every row of that shop, and no other shop", () => {
    const out = fileShopUnder(CATS, "ALBERT HEIJN 1234", "Eating out");
    expect(out.ok).toBe(true);
    const next = (out as { content: string }).content;
    expect(ruleFor("ALBERT HEIJN 1234", rulesOf(next))?.category).toBe("Eating out");
    // "albert heijn" still files every other Albert Heijn under Groceries, "albert" the rest under Shopping.
    expect(ruleFor("ALBERT HEIJN 99", rulesOf(next))?.category).toBe("Groceries");
    expect(ruleFor("ALBERT DE GROOT", rulesOf(next))?.category).toBe("Shopping");
  });

  it("takes the very same word off the category that had it, so the move is not a tie lost to the earlier row", () => {
    const next = (fileShopUnder(CATS, "Jumbo", "Shopping") as { content: string }).content;
    expect(ruleFor("JUMBO", rulesOf(next))?.category).toBe("Shopping");
    expect(rulesOf(next)[0]!.matches).toEqual(["albert heijn"]);
  });

  it("files a short name as the whole description, so it cannot claim other shops", () => {
    expect(shopTerm("NS")).toBe("=ns");
    expect(shopTerm("Bol  ")).toBe("=bol");
    expect(shopTerm("Albert  Heijn")).toBe("albert heijn");
    const next = (fileShopUnder(CATS, "NS", "Empty one") as { content: string }).content;
    expect(ruleFor("NS", rulesOf(next))?.category).toBe("Empty one");
    expect(ruleFor("HANS EN GRIETJE", rulesOf(next))).toBeNull();
  });

  it("makes the category when it is new, and refuses no name", () => {
    const next = (fileShopUnder(CATS, "GVB Amsterdam", "Transport") as { content: string }).content;
    expect(ruleFor("GVB AMSTERDAM", rulesOf(next))?.category).toBe("Transport");
    expect(fileShopUnder(CATS, "GVB", " ")).toMatchObject({ ok: false, status: 422 });
  });

  it("adds nothing when the category already has the word", () => {
    const once = (fileShopUnder(CATS, "Uniqlo", "Shopping") as { content: string }).content;
    expect(once).toBe(CATS);
  });
});

describe("own accounts and payslips, changed from a screen", () => {
  const OWN = "| Account | Matches | Since |\n|---|---|---|\n| Broker | capital.com | 2024 |\n| Pot | savings vault | |\n";

  it("own accounts: add, change the words, remove, an unknown column kept", () => {
    const t = ownAccountTable(OWN);
    expect(t.rows.map((r) => r.name)).toEqual(["Broker", "Pot"]);
    const changed = ok(changeOwnAccountRow(OWN, { index: 0, name: "Broker", version: t.version }, { matches: "capital.com, ibkr" }));
    expect(changed).toContain("| Broker | capital.com, ibkr | 2024 |");
    expect(parseOwnAccounts(ok(removeOwnAccountRow(OWN, { index: 1, name: "Pot", version: t.version })))).toEqual([{ account: "Broker", matches: ["capital.com"] }]);
    expect(parseOwnAccounts(appendOwnAccountRow(OWN, { account: "Crypto", matches: "bitvavo" })!).at(-1)).toEqual({ account: "Crypto", matches: ["bitvavo"] });
  });

  const SLIPS = "| Month | Gross | Net | Employer |\r\n|---|---|---|---|\r\n| 2026-02 | 600 | 500 | Salary Ltd |\r\n| 2026-01 | 600 | 480 | Salary Ltd |\r\n";

  it("payslips: each row names its line; change and remove keep CRLF and the unknown column", () => {
    // The whole reading, pinned: `line` is the one field added (1G).
    expect(parsePayslipTable(SLIPS)).toEqual([
      { month: "2026-01", gross: 600, net: 480, tax: null, hours: null, rate: null, file: "", effectiveNet: null, line: 4 },
      { month: "2026-02", gross: 600, net: 500, tax: null, hours: null, rate: null, file: "", effectiveNet: null, line: 3 },
    ]);
    const t = payslipTable(SLIPS);
    const changed = ok(changePayslipRow(SLIPS, { index: 1, name: "2026-01", version: t.version }, { net: "490.00" }));
    expect(changed).toBe(SLIPS.replace("| 2026-01 | 600 | 480 | Salary Ltd |", "| 2026-01 | 600 | 490.00 | Salary Ltd |"));
    expect(ok(removePayslipRow(SLIPS, { index: 0, name: "2026-02", version: t.version }))).toBe(SLIPS.replace("| 2026-02 | 600 | 500 | Salary Ltd |\r\n", ""));
  });

  it("a payslip typed by hand files like a read one, withheld worked out", () => {
    const empty = [...tableHead(["Month", "Gross", "Net", "Tax", "Hours", "Rate", "File"]), ""].join("\n");
    const out = appendPayslipRow(empty, typedPayslip("2026-03", 2000, 1500), "march.pdf")!;
    expect(parsePayslipTable(out)[0]).toMatchObject({ month: "2026-03", gross: 2000, net: 1500, tax: 500, file: "march.pdf" });
  });
});
