/**
 * One quantity, one formula (audit root cause #7).
 *
 * Every figure here is shown in more than one place — the Finance hero, the
 * month page, the category and merchant pages, the Dashboard — and each case
 * is one where two of those places once disagreed because each kept its own
 * arithmetic. The fixture is the shape that exposed them: rent leaves as a
 * transfer the rules note claims, purchases get returned, and the export stops
 * a few days into the month.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.BASALT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "basalt-figures-"));
process.env.BASALT_VAULT_DIR = path.join(process.env.BASALT_DATA_DIR, "vault");
process.env.BASALT_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.BASALT_SECRET_KEY = "test-secret-key-0123456789abcdef";

const VAULT = process.env.BASALT_VAULT_DIR;
const FIN = path.join(VAULT, "02-Areas/finance");
const note = (title: string, tag: string, body: string) => `---\ntitle: ${title}\ntags:\n  - ${tag}\n---\n\n${body}\n`;

/**
 * A Revolut-shaped export. Each pocket keeps its own running balance, the way
 * Revolut prints it; `at` records Current's balance after every row so a test
 * can read the true slope off it.
 */
function statement(build: (row: (date: string, type: string, what: string, amount: number, pocket?: string) => void) => void) {
  const balance: Record<string, number> = { Current: 1000, Savings: 10_000 };
  const current: { date: string; balance: number }[] = [];
  const lines = ["Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance"];
  let tick = 0; // a second apiece, so same-day rows keep the order they were written in
  build((date, type, what, amount, pocket = "Current") => {
    balance[pocket] = Math.round((balance[pocket]! + amount) * 100) / 100;
    if (pocket === "Current") current.push({ date, balance: balance[pocket]! });
    const t = tick++;
    const at = `${date} 10:${String(Math.floor(t / 60) % 60).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
    lines.push(`${type},${pocket},${at},${at},${what},${amount.toFixed(2)},0.00,EUR,COMPLETED,${balance[pocket]!.toFixed(2)}`);
  });
  /** Current's balance at the end of a day (or before any row: 1000). */
  const currentAt = (date: string) => current.filter((c) => c.date <= date).at(-1)?.balance ?? 1000;
  return { csv: lines.join("\n"), currentAt };
}

const MONTHS = ["2026-06", "2026-07", "2026-08", "2026-09"];
const { csv: STATEMENT, currentAt } = statement((row) => {
  for (const m of MONTHS) {
    row(`${m}-01`, "Transfer", "Payment from EMPLOYER BV", 1800);
    row(`${m}-02`, "Transfer", "To Stichting DUWO", -609); // rent, by transfer, claimed by the Home rule
    row(`${m}-10`, "Card Payment", "ALBERT HEIJN", -300);
    row(`${m}-12`, "Card Payment", "COOLBLUE", -200); // bought...
    row(`${m}-14`, "Card Refund", "COOLBLUE", 200); //    ...and returned
    // A Savings pocket in the same export: the move is printed on both
    // pockets, the Savings row last, with the Savings balance (FIN-002).
    row(`${m}-28`, "Transfer", "To Savings", -200);
    row(`${m}-28`, "Transfer", "From Current", 200, "Savings");
  }
  row("2026-07-20", "Card Payment", "ZALANDO", -100);
  row("2026-07-28", "Card Refund", "ZALANDO", 40); // part of it sent back
  row("2026-08-15", "Transfer", "To Current", -150, "Savings"); // a withdrawal: not money that left
  row("2026-08-15", "Transfer", "From Savings", 150);
  row("2026-09-30", "Card Payment", "ALBERT HEIJN", -1); // the export reaches September's last day
  row("2026-09-30", "Transfer", "Savings interest", 3, "Savings");
  // October so far: rent and some groceries, export taken on the 9th.
  row("2026-10-01", "Transfer", "Payment from EMPLOYER BV", 1800);
  row("2026-10-02", "Transfer", "To Stichting DUWO", -609);
  row("2026-10-09", "Card Payment", "ALBERT HEIJN", -100);
});

const { buildServer } = await import("../src/main.js");
const { balanceTrend, loadStatements, planSavings, writtenBalance } = await import("../src/routes/finance.js");
const { completeMonths, mainPocket, monthlyByCategory, parseStatement } = await import("@orrama/core");
let app: Awaited<ReturnType<typeof buildServer>>["app"];
let token = "";
const get = async (url: string) => {
  const res = await app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
  expect(res.statusCode).toBe(200);
  return res.json();
};

beforeAll(async () => {
  fs.mkdirSync(path.join(FIN, "files"), { recursive: true });
  fs.writeFileSync(path.join(FIN, "files", "statement.csv"), STATEMENT);
  fs.writeFileSync(
    path.join(FIN, "spending-categories.md"),
    note(
      "Spending categories",
      "spending-categories",
      "| Category | Matches |\n|---|---|\n| Home | stichting duwo |\n| Groceries | albert heijn |\n| Electronics | coolblue |\n| Shopping | zalando |",
    ),
  );
  // Lines matched three ways: an unaccented term for an accented descriptor,
  // an exact `=ns`, and no Match at all (the name's own words, accented).
  fs.writeFileSync(
    path.join(FIN, "subscriptions.md"),
    note(
      "Subscriptions",
      "subscriptions",
      "| Service | Amount | Every | Next | Match |\n|---|---|---|---|---|\n| Pathe Unlimited | 24.99 | monthly | 2026-10-12 | pathe |\n| NS Flex | 99 | monthly | 2026-10-12 | =ns |\n| Döner Club | 12 | monthly | 2026-10-12 | |\n| GitHub | $12 | monthly | 2026-10-12 | github |",
    ),
  );
  // A hand-typed balance in Dutch notation; the statement's own balance wins
  // whenever it has one (REG-003).
  fs.writeFileSync(path.join(FIN, "finance.md"), "---\ntitle: Finance\nbalance: 1.234,56\ntags:\n  - finance\n---\n\n# Finance\n");
  // Income in two currencies: the dollars are never euros (FIN-017).
  fs.writeFileSync(
    path.join(FIN, "income.md"),
    note("Income", "income", "| Source | Amount | Every | Next | Match |\n|---|---|---|---|---|\n| Salary | 1800 | monthly | 2026-10-01 | employer bv |\n| Freelance | $500 | monthly | 2026-10-15 | |"),
  );
  await import("../src/seed.js");
  app = (await buildServer()).app;
  token = (
    await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "jules@basalt.dev", password: "basalt-demo" } })
  ).json().token;
});

afterAll(async () => {
  await app.close();
  fs.rmSync(process.env.BASALT_DATA_DIR!, { recursive: true, force: true });
});

/** Swap the finance folder's statements for these while `fn` runs. */
const withStatements = async (files: Record<string, string>, fn: () => Promise<void>) => {
  const dir = path.join(FIN, "files");
  fs.renameSync(path.join(dir, "statement.csv"), path.join(FIN, "statement.csv.aside"));
  for (const [name, csv] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), csv);
  try {
    await fn();
  } finally {
    for (const name of Object.keys(files)) fs.rmSync(path.join(dir, name));
    fs.renameSync(path.join(FIN, "statement.csv.aside"), path.join(dir, "statement.csv"));
  }
};

type Month = { month: string; spend: number };
type CatMonth = { month: string; total: number; byCategory: Record<string, number> };

describe("what a month cost (FIN-001)", () => {
  it("is the same figure on the hero, the category months and the month page", async () => {
    const d = await get("/api/finance");
    const cat = new Map<string, number>(d.spending.categories.months.map((m: CatMonth) => [m.month, m.total]));
    for (const m of d.spending.months as Month[]) {
      expect(m.spend, m.month).toBe(cat.get(m.month) ?? 0);
      expect((await get(`/api/finance/month/${m.month}`)).total, m.month).toBe(m.spend);
    }
  });

  it("counts rent claimed as a transfer, and nets a returned purchase", async () => {
    const d = await get("/api/finance");
    const spend = (month: string) => (d.spending.months as Month[]).find((m) => m.month === month)!.spend;
    // October so far: rent 609 + groceries 100. The old loop said 100.
    expect(spend("2026-10")).toBe(709);
    // September: rent 609 + groceries 301; the Coolblue purchase came back.
    // The old loop said 501 (rent left out, the refunded 200 counted).
    expect(spend("2026-09")).toBe(910);
  });

  it("agrees with the Dashboard's month in progress", async () => {
    const home = await get("/api/home");
    const d = await get("/api/finance");
    expect(home.spending.running.total).toBe((d.spending.months as Month[]).at(-1)!.spend);
  });

  it("never draws a hero split wider than the hero total", async () => {
    const d = await get("/api/finance");
    const current = (d.spending.months as Month[]).at(-1)!;
    const split = (d.spending.categories.months as CatMonth[]).find((m) => m.month === current.month)!.byCategory;
    for (const v of Object.values(split)) expect(v).toBeLessThanOrEqual(current.spend);
  });

  it("gives a merchant the total its category row gives it", async () => {
    const cat = await get("/api/finance/category/Shopping?year=2026");
    const row = cat.merchants.find((m: { name: string }) => m.name === "ZALANDO");
    const page = await get("/api/finance/merchant/ZALANDO?year=2026");
    expect(row.total).toBe(60);
    expect(page.direction).toBe("out");
    expect(page.stats.total).toBe(row.total);
    expect(page.stats.allTime).toBe(row.total);
    expect((await get("/api/finance/month/2026-07?category=Shopping")).total).toBe(60);
  });

  it("does not count a refund as money arriving at the merchant", async () => {
    // Four purchases, each returned in full: nothing was spent and nothing
    // came in. Counting the refunds as "in" made this a merchant that pays
    // Jules €800.
    const page = await get("/api/finance/merchant/COOLBLUE?year=2026");
    expect(page.direction).toBe("out");
    expect(page.stats.total).toBe(0);
  });
});

describe("one pocket's balance (FIN-002)", () => {
  /** A vault folder holding one statement, for the functions that read files. */
  const rootWith = (csv: string) => {
    const root = fs.mkdtempSync(path.join(process.env.BASALT_DATA_DIR!, "pockets-"));
    fs.mkdirSync(path.join(root, "02-Areas/finance/files"), { recursive: true });
    fs.writeFileSync(path.join(root, "02-Areas/finance/files/statement.csv"), csv);
    return root;
  };
  // Current grows by €300 a month: 1,800 in, 1,000 spent, 500 to savings.
  // The Savings pocket holds €10,000 and records the other side of each move.
  const months = ["2026-01", "2026-02", "2026-03", "2026-04"];
  const build = (withSavings: boolean) =>
    statement((row) => {
      for (const m of months) {
        row(`${m}-01`, "Transfer", "Payment from EMPLOYER BV", 1800);
        row(`${m}-10`, "Card Payment", "ALBERT HEIJN", -1000);
        row(`${m}-28`, "Transfer", "To Savings", -500);
        if (withSavings) row(`${m}-28`, "Transfer", "From Current", 500, "Savings");
        // A broker deposit made from the Savings pocket: saved, but not out of
        // the account whose slope the plan reads.
        if (withSavings) row(`${m}-20`, "Transfer", "To Capital.com", -100, "Savings");
      }
      if (withSavings) row("2026-02-14", "Transfer", "To Current", -150, "Savings");
      row("2026-02-14", "Transfer", "From Savings", 150);
      row("2026-04-30", "Card Payment", "ALBERT HEIJN", -1);
      if (withSavings) row("2026-04-30", "Transfer", "Savings interest", 9, "Savings");
    }).csv;
  const plan = async (csv: string) => {
    const { txns, complete } = await loadStatements(rootWith(csv), [{ account: "Broker", matches: ["capital.com"] }]);
    const finished = completeMonths(monthlyByCategory(txns, []), complete);
    return { txns, finished, savings: planSavings(txns, finished, { payslipNet: [], ledger: [], currency: "EUR" }) };
  };

  it("reads the trend off the main pocket, not whichever pocket moved last", async () => {
    const { txns, finished } = await plan(build(true));
    expect(finished.map((m) => m.month)).toEqual(months);
    // 4 × 300, plus the 150 withdrawn from savings, minus the €1 on the 30th.
    expect(balanceTrend(txns, months).drift).toBe((4 * 300 + 150 - 1) / 4);
  });

  it("leaves the savings plan unchanged by the Savings pocket's own rows", async () => {
    const one = (await plan(build(false))).savings;
    const two = (await plan(build(true))).savings;
    expect(two).toEqual(one);
    expect(two.incomeSource).toBe("balance");
    expect(two.observed).toBe((4 * 300 + 150 - 1) / 4);
  });

  it("is one choice of pocket for the Balance card and the trend", () => {
    const csv = build(true);
    expect(mainPocket(parseStatement(csv).rows)).toBe("Current");
    expect(parseStatement(csv).balance).toBe(1000 + 4 * 300 + 150 - 1);
  });

  it("gives the Finance tab and the Dashboard the same slope and plan", async () => {
    const d = await get("/api/finance");
    const home = await get("/api/home");
    // Jun–Sep are complete; the slope is Current's own, before June to end of September.
    const slope = (currentAt("2026-09-30") - currentAt("2026-05-31")) / 4;
    expect(d.summary.drift).toBeCloseTo(slope, 2);
    expect(d.summary.balance).toBe(currentAt("2026-10-09"));
    expect(d.savings.observed).toBeCloseTo(slope, 2);
    for (const k of ["target", "surplus", "trimmable", "observed", "targetRate"] as const) {
      expect(home.spending.savings[k], k).toBe(d.savings[k]);
    }
  });
});

describe("what the statements cover (FIN-008)", () => {
  it("does not count the month a statement starts inside", async () => {
    // From 17 March. Every whole month costs 400 of groceries and the
    // salary is 1,500; March holds half of that.
    const { csv } = statement((row) => {
      row("2026-03-17", "Transfer", "Payment from EMPLOYER BV", 1500);
      row("2026-03-20", "Card Payment", "ALBERT HEIJN", -200);
      for (const m of ["2026-04", "2026-05", "2026-06"]) {
        row(`${m}-01`, "Transfer", "Payment from EMPLOYER BV", 1500);
        row(`${m}-05`, "Card Payment", "ALBERT HEIJN", -200);
        row(`${m}-20`, "Card Payment", "ALBERT HEIJN", -200);
      }
      row("2026-07-02", "Card Payment", "ALBERT HEIJN", -10);
    });
    await withStatements({ "march.csv": csv }, async () => {
      const d = await get("/api/finance");
      expect(d.spending.categories.completeMonths).toBe(3);
      expect(d.spending.categories.forecast.find((f: { category: string }) => f.category === "Groceries").low).toBe(400);
      expect([d.savings.typicalMonth, d.savings.goodMonth]).not.toContain("2026-03");
      // +1,100 a month (1,500 in, 400 out), not the half-month's +1,300 averaged in.
      expect(d.summary.drift).toBe(1100);
      expect(d.savings.incomeMonthly).toBe(1500);
      const cat = await get("/api/finance/category/Groceries?year=2026");
      expect(cat.series.find((m: { month: string }) => m.month === "2026-03").partial).toBe(true);
      expect(cat.stats.low).toBe(400);
      expect(cat.stats.activeMonths).toBe(3);
      expect((await get("/api/finance/month/2026-03")).complete).toBe(false);
    });
  });

  it("measures the balance across a gap per covered run, over the months measured", async () => {
    // The account grows 500 every month, nine months running, but April–June
    // were never uploaded. Over the two runs it is +500 a month; across the
    // gap it read 3,500 of change over six months.
    const header = "Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance";
    const q1 = [header];
    const q3 = [header];
    let balance = 1000;
    for (let i = 1; i <= 9; i++) {
      const m = `2026-${String(i).padStart(2, "0")}`;
      const end = new Date(Date.UTC(2026, i, 0)).getUTCDate();
      for (const [day, type, what, amount] of [
        ["01", "Transfer", "Payment from EMPLOYER BV", 2000],
        ["10", "Card Payment", "ALBERT HEIJN", -1000],
        [String(end), "Card Payment", "ALBERT HEIJN", -500],
      ] as const) {
        balance += amount;
        const at = `${m}-${day} 10:00:00`;
        (i <= 3 ? q1 : i >= 7 ? q3 : []).push(`${type},Current,${at},${at},${what},${amount.toFixed(2)},0.00,EUR,COMPLETED,${balance.toFixed(2)}`);
      }
    }
    await withStatements({ "q1.csv": q1.join("\n"), "q3.csv": q3.join("\n") }, async () => {
      const d = await get("/api/finance");
      expect(d.spending.categories.completeMonths).toBe(6);
      expect(d.summary.drift).toBe(500);
      expect(d.summary.spanMonths).toBe(6);
      expect(d.savings.incomeMonthly).toBe(2000);
      // April to June are not €0 months: nobody can say what they cost.
      const cat = await get("/api/finance/category/Groceries?year=2026");
      expect(cat.series.filter((m: { partial: boolean }) => m.partial).map((m: { month: string }) => m.month)).toEqual(["2026-04", "2026-05", "2026-06"]);
    });
  });

  it("counts a covered month with nothing spent as a €0 month", async () => {
    const { csv } = statement((row) => {
      for (const m of ["2026-06", "2026-07", "2026-08", "2026-09"]) {
        row(`${m}-01`, "Transfer", "Payment from EMPLOYER BV", 1000);
        if (m !== "2026-08") row(`${m}-10`, "Card Payment", "ALBERT HEIJN", -300); // away all August
      }
      row("2026-10-01", "Transfer", "Payment from EMPLOYER BV", 1000);
    });
    await withStatements({ "away.csv": csv }, async () => {
      const d = await get("/api/finance");
      expect(d.spending.categories.completeMonths).toBe(4);
      expect(d.spending.categories.forecast.find((f: { category: string }) => f.category === "Groceries").low).toBe(0);
      expect((await get("/api/finance/month/2026-08")).complete).toBe(true);
      expect(d.summary.drift).toBe(775); // (4 × 1,000 − 3 × 300) / 4
    });
  });
});

describe("the category page (FIN-009)", () => {
  // Four complete months of €300 groceries and €40 in an uncategorised shop,
  // salary and a top-up every month, a Coolblue purchase returned in full,
  // and an export taken on 2 October holding €20 of groceries so far.
  const { csv } = statement((row) => {
    for (const m of ["2026-06", "2026-07", "2026-08", "2026-09"]) {
      row(`${m}-01`, "Transfer", "Payment from EMPLOYER BV", 1800);
      row(`${m}-02`, "Topup", "Top-up by *1234", 200);
      row(`${m}-10`, "Card Payment", "ALBERT HEIJN", -300);
      row(`${m}-15`, "Card Payment", "RANDOM SHOP", -40);
    }
    row("2026-07-20", "Card Payment", "COOLBLUE", -250);
    row("2026-08-03", "Card Refund", "COOLBLUE", 250);
    row("2026-10-01", "Transfer", "Payment from EMPLOYER BV", 1800);
    row("2026-10-02", "Card Payment", "ALBERT HEIJN", -20);
  });

  it("averages the complete months only, and says over how many", async () => {
    await withStatements({ "c.csv": csv }, async () => {
      const g = await get("/api/finance/category/Groceries?year=2026");
      expect(g.stats.average).toBe(300); // not (4 × 300 + 20) / 5 = 244
      expect(g.stats.activeMonths).toBe(4);
      expect(g.stats.count).toBe(5); // October's €20 is still a transaction
    });
  });

  it("counts only what cost something", async () => {
    await withStatements({ "c.csv": csv }, async () => {
      const other = await get("/api/finance/category/Other?year=2026");
      // Four shop visits — not the salary and top-ups beside them.
      expect(other.stats.count).toBe(4);
      expect(other.stats.activeMonths).toBe(4);
      expect(other.series.find((m: { month: string }) => m.month === "2026-10").hasData).toBe(false);
      // Bought and returned in full: no spending, so no active months.
      const e = await get("/api/finance/category/Electronics");
      expect(e.stats.activeMonths).toBe(0);
      expect(e.stats.count).toBe(0);
      expect(e.series.every((m: { hasData: boolean }) => !m.hasData)).toBe(true);
    });
  });
});

describe("a ledger line's Match terms (FIN-010)", () => {
  const { csv } = statement((row) => {
    for (const m of ["2026-06", "2026-07", "2026-08", "2026-09"]) {
      row(`${m}-01`, "Transfer", "Payment from EMPLOYER BV", 1800);
      row(`${m}-05`, "Card Payment", "PATHÉ AMSTERDAM", -24.99);
      row(`${m}-06`, "Card Payment", "NS", -99);
      row(`${m}-07`, "Card Payment", "DONER CLUB AMSTERDAM", -12);
      row(`${m}-08`, "Card Payment", "HANS EN GRIETJE", -8); // "ns" inside a word: not the railway
    }
    row("2026-09-30", "Card Payment", "ALBERT HEIJN", -1);
  });

  it("finds the charges on the line's own card that the categories file under it", async () => {
    await withStatements({ "subs.csv": csv }, async () => {
      const d = await get("/api/finance");
      const sept = d.spending.categories.months.find((m: CatMonth) => m.month === "2026-09");
      expect(sept.byCategory.Subscriptions).toBe(135.99); // 24.99 + 99 + 12
      for (const [line, merchant] of [["Pathe Unlimited", "PATHÉ AMSTERDAM"], ["NS Flex", "NS"], ["Döner Club", "DONER CLUB AMSTERDAM"]]) {
        expect(d.subscriptions.activity[line!], line).toMatchObject({ charges: 4, months: 4, first: "2026-06", merchants: [merchant] });
      }
    });
  });

  it("does not offer a claimed charge under Looks recurring", async () => {
    await withStatements({ "subs.csv": csv }, async () => {
      const d = await get("/api/finance");
      expect(d.recurring.map((r: { merchant: string }) => r.merchant)).toEqual(["HANS EN GRIETJE"]);
    });
  });
});

describe("one typical for a month and the page it opens (FIN-014)", () => {
  // Groceries €300, €400, €500 and then a €900 September.
  const { csv } = statement((row) => {
    for (const [m, groceries] of [["2026-06", 300], ["2026-07", 400], ["2026-08", 500], ["2026-09", 900]] as const) {
      row(`${m}-01`, "Transfer", "Payment from EMPLOYER BV", 1800);
      row(`${m}-02`, "Transfer", "To Stichting DUWO", -609);
      row(`${m}-10`, "Card Payment", "ALBERT HEIJN", -groceries);
    }
    row("2026-10-01", "Transfer", "Payment from EMPLOYER BV", 1800);
  });

  it("is the month page's figure on the top card and the Dashboard", async () => {
    await withStatements({ "spike.csv": csv }, async () => {
      const d = await get("/api/finance");
      const home = await get("/api/home");
      const page = await get("/api/finance/month/2026-09");
      const groceries = await get("/api/finance/month/2026-09?category=Groceries");
      expect(groceries.typical).toBe(400); // June–August; not 450 with September in it

      const card = d.spending.categories.forecast.find((f: { category: string }) => f.category === "Groceries");
      expect(card.last).toBe(900);
      expect(card.lastTypical).toBe(groceries.typical);
      expect(card.typical).toBe(450); // "a typical month" still spans every complete month

      expect(home.spending.month).toBe("2026-09");
      expect(home.spending.typical).toBe(page.typical);
      const row = home.spending.categories.find((c: { category: string }) => c.category === "Groceries");
      expect(row.typical).toBe(groceries.typical);
    });
  });
});

describe("ledger totals stay in their own currency (FIN-017)", () => {
  it("nets in and out per currency on the Finance tab and the Dashboard alike", async () => {
    const d = await get("/api/finance");
    const home = await get("/api/home");
    // EUR: 1,800 − (24.99 + 99 + 12); USD: 500 − 12. Not one "€2,152.01".
    expect(d.summary.net).toEqual([
      { currency: "EUR", monthly: 1664.01 },
      { currency: "USD", monthly: 488 },
    ]);
    expect(home.finance.net).toEqual(d.summary.net);
    expect(d.summary).not.toHaveProperty("inPerMonth");
    expect(d.summary).not.toHaveProperty("outPerMonth");
  });

  it("gives the savings plan only the statement's currency from the income note", async () => {
    // No balance column, no payslips: the plan falls back to the income note.
    const root = fs.mkdtempSync(path.join(process.env.BASALT_DATA_DIR!, "ledger-"));
    fs.mkdirSync(path.join(root, "02-Areas/finance/files"), { recursive: true });
    const rows = ["Type,Completed Date,Description,Amount,Fee,Currency,State"];
    for (const m of ["2026-01", "2026-02", "2026-03"]) {
      rows.push(`Card Payment,${m}-01 10:00:00,ALBERT HEIJN,-300.00,0.00,EUR,COMPLETED`);
      rows.push(`Card Payment,${m}-${m === "2026-02" ? "28" : "31"} 10:00:00,ALBERT HEIJN,-300.00,0.00,EUR,COMPLETED`);
    }
    fs.writeFileSync(path.join(root, "02-Areas/finance/files/s.csv"), rows.join("\n"));
    const { txns, complete, currency } = await loadStatements(root);
    const finished = completeMonths(monthlyByCategory(txns, []), complete);
    const plan = planSavings(txns, finished, {
      payslipNet: [],
      ledger: [{ currency: "EUR", monthly: 1800 }, { currency: "USD", monthly: 500 }],
      currency,
    });
    expect(plan.incomeSource).toBe("ledger");
    expect(plan.incomeMonthly).toBe(1800);
  });
});

describe("the balance typed into the finance note (REG-003)", () => {
  it("reads European and grouped notation as money, not as parseFloat does", () => {
    expect(writtenBalance("1.234,56")).toBe(1234.56); // parseFloat: 1.234
    expect(writtenBalance("2,500.00")).toBe(2500); //    parseFloat: 2
    expect(writtenBalance("12.345,67")).toBe(12345.67);
    expect(writtenBalance("1 234,56")).toBe(1234.56);
    expect(writtenBalance(1234.56)).toBe(1234.56); // YAML already made it a number
    expect(writtenBalance("")).toBeNull();
    expect(writtenBalance(undefined)).toBeNull();
    expect(writtenBalance("n/a")).toBeNull();
  });

  it("is the balance the Finance tab shows when the statement carries none", async () => {
    const rows = ["Type,Completed Date,Description,Amount,Fee,Currency,State"];
    for (const m of ["2026-06", "2026-07", "2026-08"]) rows.push(`Card Payment,${m}-10 10:00:00,ALBERT HEIJN,-300.00,0.00,EUR,COMPLETED`);
    await withStatements({ "nobalance.csv": rows.join("\n") }, async () => {
      expect((await get("/api/finance")).summary.balance).toBe(1234.56);
    });
    // With a balance column, the bank's figure wins over the typed one.
    expect((await get("/api/finance")).summary.balance).toBe(currentAt("2026-10-09"));
  });
});
