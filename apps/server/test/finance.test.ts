/**
 * The Finance endpoints, over a vault seeded with a real-shaped statement.
 *
 * The interesting cases here are the ones that were wrong once: the month view
 * has to compare like for like when it is filtered to a category, the savings
 * plan has to take money-in from the bank's own balance trend rather than from
 * payslips, and the file routes must refuse a name that tries to leave the
 * folder.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.BASALT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "basalt-finance-"));
process.env.BASALT_VAULT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "basalt-finance-vault-"));
process.env.BASALT_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
// The startup guard refuses placeholder secrets everywhere now, not just
// under NODE_ENV=production, so the suite has to carry a real-shaped one too.
process.env.BASALT_SECRET_KEY = "test-secret-key-0123456789abcdef";

const VAULT = process.env.BASALT_VAULT_DIR!;
const FIN = path.join(VAULT, "02-Areas/finance");

/**
 * Two complete months plus a part-month, with running balances so the drift —
 * and therefore the savings plan's money-in — is computable.
 */
const STATEMENT = [
  "Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance",
  "Card Payment,Current,2026-01-05 10:00:00,2026-01-05 10:00:00,ALBERT HEIJN,-100.00,0.00,EUR,COMPLETED,1000.00",
  "Card Payment,Current,2026-01-20 10:00:00,2026-01-20 10:00:00,UNIQLO,-100.00,0.00,EUR,COMPLETED,900.00",
  "Card Payment,Current,2026-02-05 10:00:00,2026-02-05 10:00:00,ALBERT HEIJN,-50.00,0.00,EUR,COMPLETED,1050.00",
  "Card Payment,Current,2026-02-20 10:00:00,2026-02-20 10:00:00,UNIQLO,-50.00,0.00,EUR,COMPLETED,1000.00",
  "Card Payment,Current,2026-03-05 10:00:00,2026-03-05 10:00:00,ALBERT HEIJN,-75.00,0.00,EUR,COMPLETED,1125.00",
  "Card Payment,Current,2026-03-20 10:00:00,2026-03-20 10:00:00,UNIQLO,-75.00,0.00,EUR,COMPLETED,1200.00",
  "Card Payment,Current,2026-04-02 10:00:00,2026-04-02 10:00:00,ALBERT HEIJN,-10.00,0.00,EUR,COMPLETED,1300.00",
  // A counterparty paid in BOTH directions: mostly pays in, occasionally paid.
  "Transfer,Current,2026-01-25 10:00:00,2026-01-25 10:00:00,Payment from SALARY LTD,500.00,0.00,EUR,COMPLETED,1400.00",
  "Transfer,Current,2026-02-25 10:00:00,2026-02-25 10:00:00,Payment from SALARY LTD,500.00,0.00,EUR,COMPLETED,1900.00",
  "Transfer,Current,2026-03-25 10:00:00,2026-03-25 10:00:00,Payment from SALARY LTD,500.00,0.00,EUR,COMPLETED,2400.00",
  "Transfer,Current,2026-03-27 10:00:00,2026-03-27 10:00:00,Transfer to SALARY LTD,-900.00,0.00,EUR,COMPLETED,1500.00",
].join("\n");

const note = (title: string, tag: string, body: string) =>
  `---\ntitle: ${title}\ntags:\n  - ${tag}\n---\n\n${body}\n`;

beforeAll(() => {
  fs.mkdirSync(path.join(FIN, "files"), { recursive: true });
  fs.writeFileSync(path.join(FIN, "files", "statement.csv"), STATEMENT);
  fs.writeFileSync(
    path.join(FIN, "spending-categories.md"),
    note("Spending categories", "spending-categories",
      "| Category | Matches | Colour |\n|---|---|---|\n| Groceries | albert heijn | pink |\n| Shopping | uniqlo | cyan |"),
  );
  fs.writeFileSync(
    path.join(FIN, "subscriptions.md"),
    note("Subscriptions", "subscriptions", "| Service | Amount | Every | Next |\n|---|---|---|---|\n| Adobe | 19.66 | monthly | 2026-09-12 |"),
  );
  fs.writeFileSync(
    path.join(FIN, "income.md"),
    note("Income", "income", "| Source | Amount | Every | Next | Match |\n|---|---|---|---|---|\n| Salary | 500 | monthly | 2026-09-25 | salary ltd |"),
  );
});

const { buildServer } = await import("../src/main.js");
let app: Awaited<ReturnType<typeof buildServer>>["app"];
let token: string;

const api = async (method: string, url: string, auth?: string, body?: unknown) => {
  const res = await app.inject({
    method: method as "GET",
    url,
    headers: auth ? { authorization: `Bearer ${auth}` } : {},
    ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
  });
  return { status: res.statusCode, json: res.json.bind(res) };
};

beforeAll(async () => {
  await import("../src/seed.js");
  app = (await buildServer()).app;
  token = (await api("POST", "/api/auth/login", undefined, { email: "jules@basalt.dev", password: "basalt-demo" }))
    .json().token;
});

afterAll(async () => {
  await app.close();
  fs.rmSync(process.env.BASALT_DATA_DIR!, { recursive: true, force: true });
  fs.rmSync(VAULT, { recursive: true, force: true });
});

describe("finance overview", () => {
  it("requires authentication on every route", async () => {
    expect((await api("GET", "/api/finance")).status).toBe(401);
    expect((await api("GET", "/api/finance/month/2026-01")).status).toBe(401);
    expect((await api("GET", "/api/finance/files/statement.csv/sheet")).status).toBe(401);
  });

  it("reads the statement, the ledgers and the categories in one call", async () => {
    const d = (await api("GET", "/api/finance", token)).json();
    expect(d.spending.txnCount).toBe(11);
    expect(d.subscriptions.count).toBe(1);
    expect(d.income.count).toBe(1);
    expect(d.spending.categories.forecast.map((f: { category: string }) => f.category)).toContain("Groceries");
  });

  it("says how long each ledger line has been charging, from the statement", async () => {
    const d = (await api("GET", "/api/finance", token)).json();
    // Adobe never appears on this statement, so it reports no run rather than
    // a guessed one.
    expect(d.subscriptions.activity["Adobe"]).toMatchObject({ charges: 0, months: 0, first: null });
  });
});

describe("average spend", () => {
  it("leaves out the part-month the statement stops inside", async () => {
    const { summary } = (await api("GET", "/api/finance", token)).json();
    // Jan 200, Feb 100, Mar 150 are complete; April holds one EUR 10 row and
    // the export stops on the 2nd. Averaging that in gave EUR 86.67 — an
    // export taken early in a month understated by about a third (audit).
    expect(summary.avgSpend).toBeCloseTo(150, 2);
  });
});

describe("savings plan", () => {
  it("takes money in from the balance trend, not from payslips", async () => {
    const { savings, summary } = (await api("GET", "/api/finance", token)).json();
    expect(savings.incomeSource).toBe("balance");
    // The identity the model rests on: what came in is what went OUT plus the
    // change in balance. Out means every debit, not just what counts as spend
    // — this fixture has a EUR 900 transfer to a counterparty that spend does
    // not see, and reading income off spend understated it by exactly that
    // much (audit).
    expect(savings.outflowMonthly).toBeGreaterThan(savings.spendMonthly);
    expect(savings.incomeMonthly).toBeCloseTo(savings.outflowMonthly + summary.drift, 1);
    expect(savings.surplus).toBeCloseTo(savings.observed, 2);
  });

  it("never proposes trimming a committed category", async () => {
    const { savings } = (await api("GET", "/api/finance", token)).json();
    expect(savings.headroom.map((h: { category: string }) => h.category)).not.toContain("Subscriptions");
  });

  it("targets the surplus plus the headroom, and never a negative", async () => {
    const { savings } = (await api("GET", "/api/finance", token)).json();
    expect(savings.target).toBeCloseTo(Math.max(0, savings.surplus + savings.trimmable), 2);
    expect(savings.target).toBeGreaterThanOrEqual(0);
  });
});

describe("one month", () => {
  it("rejects anything that is not YYYY-MM", async () => {
    expect((await api("GET", "/api/finance/month/2026", token)).status).toBe(400);
    expect((await api("GET", "/api/finance/month/not-a-month", token)).status).toBe(400);
  });

  it("returns the month's transactions, its split and its neighbours", async () => {
    const d = (await api("GET", "/api/finance/month/2026-02", token)).json();
    expect(d.total).toBe(100);
    expect(d.count).toBe(2);
    expect(d.prev).toBe("2026-01");
    expect(d.next).toBe("2026-03");
    expect(d.categories.map((c: { category: string }) => c.category).sort()).toEqual(["Groceries", "Shopping"]);
  });

  it("carries each category's own colour, so the split matches every other page", async () => {
    const d = (await api("GET", "/api/finance/month/2026-02", token)).json();
    expect(d.categories.find((c: { category: string }) => c.category === "Shopping").colour).toBe("cyan");
  });

  it("compares like for like when filtered to one category", async () => {
    const all = (await api("GET", "/api/finance/month/2026-02", token)).json();
    const one = (await api("GET", "/api/finance/month/2026-02?category=Groceries", token)).json();
    expect(one.category).toBe("Groceries");
    expect(one.total).toBe(50);
    // Groceries' own median across the OTHER complete months (100 and 75),
    // not the whole month's median — the bug this test exists for.
    expect(one.typical).toBe(87.5);
    expect(all.typical).toBeGreaterThan(one.typical);
  });

  it("knows the statement stops inside the last month", async () => {
    expect((await api("GET", "/api/finance/month/2026-02", token)).json().complete).toBe(true);
    expect((await api("GET", "/api/finance/month/2026-04", token)).json().complete).toBe(false);
  });
});

describe("documents", () => {
  it("refuses a filename that tries to leave the folder", async () => {
    for (const bad of ["..%2F..%2Fsecret.csv", ".hidden.csv", "sub%2Fdir.csv"]) {
      expect((await api("GET", `/api/finance/files/${bad}`, token)).status).toBe(400);
    }
  });

  it("refuses a file type it cannot serve", async () => {
    expect((await api("GET", "/api/finance/files/notes.txt", token)).status).toBe(415);
  });

  it("converts only spreadsheets to rows", async () => {
    expect((await api("GET", "/api/finance/files/statement.csv/sheet", token)).status).toBe(400);
  });

  it("404s a file that is not there", async () => {
    expect((await api("GET", "/api/finance/files/missing.pdf", token)).status).toBe(404);
  });
});

describe("ledger activity is direction-aware", () => {
  it("totals income as money IN, not money out", async () => {
    const d = (await api("GET", "/api/finance", token)).json();
    // The income note names "Salary"; the statement pays it in. Counting only
    // negative amounts (as the outgoing side does) gave every income line €0.
    const salary = d.income.activity["Salary"];
    expect(salary.total).toBeGreaterThan(0);
  });

  it("totals a subscription as money OUT", async () => {
    const d = (await api("GET", "/api/finance", token)).json();
    for (const a of Object.values(d.subscriptions.activity) as { total: number }[]) {
      expect(a.total).toBeGreaterThanOrEqual(0);
    }
  });

  it("never points an income line at money that went the other way", async () => {
    const d = (await api("GET", "/api/finance", token)).json();
    // Every descriptor an income line offers must be one it actually received
    // on; a counterparty paid in both directions must not surface the outgoing.
    // SALARY LTD pays in three times and is paid once. The card must lead to
    // the money that ARRIVED, and the outgoing must not appear at all.
    const salary = d.income.activity["Salary"];
    expect(salary.merchants).toEqual(["PAYMENT FROM SALARY LTD"]);
    expect(salary.charges).toBe(3);
    expect(salary.total).toBe(1500);
  });
});

describe("a merchant that pays IN", () => {
  it("reports what arrived, not zero", async () => {
    const d = (await api("GET", "/api/finance/merchant/PAYMENT%20FROM%20SALARY%20LTD", token)).json();
    expect(d.direction).toBe("in");
    expect(d.stats.total).toBe(1500);
    expect(d.stats.average).toBe(500);
    expect(d.stats.biggest).toBe(500);
    expect(d.transactions.every((t: { amount: number }) => t.amount === 500)).toBe(true);
  });

  it("still reports a shop as money out", async () => {
    const d = (await api("GET", "/api/finance/merchant/ALBERT%20HEIJN", token)).json();
    expect(d.direction).toBe("out");
    expect(d.stats.total).toBeGreaterThan(0);
  });
});

describe("income is what you can count on", () => {
  it("takes the typical incoming payment as the median, not the mean", async () => {
    // SALARY LTD pays 500, 500, 500 in the fixture; add nothing and the two
    // agree. The rule matters when a catch-up lands: DUO pays €324.52 most
    // months and once settled a backlog, and the mean of that has never landed.
    const d = (await api("GET", "/api/finance/merchant/PAYMENT%20FROM%20SALARY%20LTD", token)).json();
    expect(d.stats.average).toBe(500);
  });

  it("keeps the mean for spending, where a total over a count is the useful reading", async () => {
    const d = (await api("GET", "/api/finance/merchant/ALBERT%20HEIJN", token)).json();
    expect(d.direction).toBe("out");
    expect(d.stats.average).toBeCloseTo(d.stats.total / d.stats.count, 2);
  });
});
