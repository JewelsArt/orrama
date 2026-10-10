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

/** A Revolut-shaped export with a running balance on the Current pocket. */
function statement(build: (row: (date: string, type: string, what: string, amount: number) => void) => void): string {
  let balance = 1000;
  const lines = ["Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance"];
  build((date, type, what, amount) => {
    balance = Math.round((balance + amount) * 100) / 100;
    lines.push(`${type},Current,${date} 10:00:00,${date} 10:00:00,${what},${amount.toFixed(2)},0.00,EUR,COMPLETED,${balance.toFixed(2)}`);
  });
  return lines.join("\n");
}

const MONTHS = ["2026-06", "2026-07", "2026-08", "2026-09"];
const STATEMENT = statement((row) => {
  for (const m of MONTHS) {
    row(`${m}-01`, "Transfer", "Payment from EMPLOYER BV", 1800);
    row(`${m}-02`, "Transfer", "To Stichting DUWO", -609); // rent, by transfer, claimed by the Home rule
    row(`${m}-10`, "Card Payment", "ALBERT HEIJN", -300);
    row(`${m}-12`, "Card Payment", "COOLBLUE", -200); // bought...
    row(`${m}-14`, "Card Refund", "COOLBLUE", 200); //    ...and returned
  }
  row("2026-07-20", "Card Payment", "ZALANDO", -100);
  row("2026-07-28", "Card Refund", "ZALANDO", 40); // part of it sent back
  row("2026-09-30", "Card Payment", "ALBERT HEIJN", -1); // the export reaches September's last day
  // October so far: rent and some groceries, export taken on the 9th.
  row("2026-10-01", "Transfer", "Payment from EMPLOYER BV", 1800);
  row("2026-10-02", "Transfer", "To Stichting DUWO", -609);
  row("2026-10-09", "Card Payment", "ALBERT HEIJN", -100);
});

const { buildServer } = await import("../src/main.js");
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
