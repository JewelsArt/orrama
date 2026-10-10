/**
 * "Typical" means the last twelve complete months, not every month on record.
 *
 * Jules added five years of statements (2020-2025) to one of 2026. Measured
 * over all of them, the median month was a student's: rent read EUR 0, the
 * typical month halved, and the savings plan's money-in came from a balance
 * slope starting in 2020. The fixture is the same shape: 44 "student" months
 * (EUR 500 in, EUR 100 spent, no rent) then 12 "now" months (EUR 2,000 in, EUR 600
 * rent, EUR 100 groceries). Every all-history median would be a student month.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { monthsAround, recentMonths } from "@basalt/core";

process.env.BASALT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "basalt-window-"));
process.env.BASALT_VAULT_DIR = path.join(process.env.BASALT_DATA_DIR, "vault");
process.env.BASALT_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.BASALT_SECRET_KEY = "test-secret-key-0123456789abcdef";

const VAULT = process.env.BASALT_VAULT_DIR;
const FIN = path.join(VAULT, "02-Areas/finance");
const note = (title: string, tag: string, body: string) => `---\ntitle: ${title}\ntags:\n  - ${tag}\n---\n\n${body}\n`;

const monthKeys: string[] = [];
for (let y = 2021, m = 1; monthKeys.length < 56; m === 12 ? ((m = 1), y++) : m++) monthKeys.push(`${y}-${String(m).padStart(2, "0")}`);
const STUDENT = monthKeys.slice(0, 44); // 2021-01 .. 2024-08
const NOW = monthKeys.slice(44); //        2024-09 .. 2025-08

let balance = 1000;
const lines = ["Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance"];
const row = (date: string, type: string, what: string, amount: number) => {
  balance = Math.round((balance + amount) * 100) / 100;
  lines.push(`${type},Current,${date} 10:00:00,${date} 10:00:00,${what},${amount.toFixed(2)},0.00,EUR,COMPLETED,${balance.toFixed(2)}`);
};
for (const m of STUDENT) {
  row(`${m}-01`, "Transfer", "Payment from STUDENT JOB", 500);
  row(`${m}-15`, "Card Payment", "ALBERT HEIJN", -100);
}
for (const m of NOW) {
  row(`${m}-01`, "Transfer", "Payment from EMPLOYER BV", 2000);
  row(`${m}-02`, "Card Payment", "STICHTING DUWO", -600);
  row(`${m}-15`, "Card Payment", "ALBERT HEIJN", -100);
}
row("2025-08-31", "Card Payment", "ALBERT HEIJN", -1); // the statement reaches the month's last day

const { buildServer } = await import("../src/main.js");
let app: Awaited<ReturnType<typeof buildServer>>["app"];
let token = "";
const get = async (url: string) => (await app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } })).json();

beforeAll(async () => {
  fs.mkdirSync(path.join(FIN, "files"), { recursive: true });
  fs.writeFileSync(path.join(FIN, "files", "statement.csv"), lines.join("\n"));
  fs.writeFileSync(
    path.join(FIN, "spending-categories.md"),
    note("Spending categories", "spending-categories", "| Category | Matches | Colour |\n|---|---|---|\n| Groceries | albert heijn | pink |\n| Home | stichting duwo | purple |"),
  );
  await import("../src/seed.js");
  app = (await buildServer()).app;
  token = (await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "jules@basalt.dev", password: "basalt-demo" } })).json().token;
});

afterAll(async () => {
  await app.close();
  fs.rmSync(process.env.BASALT_DATA_DIR!, { recursive: true, force: true });
});

describe("the window helpers", () => {
  const ms = ["2021-01", "2021-02", "2021-03", "2021-04", "2021-05"].map((month) => ({ month }));
  it("recentMonths keeps the most recent n", () => {
    expect(recentMonths(ms, 2).map((m) => m.month)).toEqual(["2021-04", "2021-05"]);
  });
  it("monthsAround prefers earlier months, tops up with later, never includes the month itself", () => {
    expect(monthsAround(ms, "2021-05", 2).map((m) => m.month)).toEqual(["2021-03", "2021-04"]);
    expect(monthsAround(ms, "2021-02", 3).map((m) => m.month)).toEqual(["2021-01", "2021-03", "2021-04"]);
  });
});

describe("GET /api/finance with years of history", () => {
  it("measures the typical month over the last twelve months", async () => {
    const f = await get("/api/finance");
    expect(f.spending.categories.typical).toBe(700); // all-history median: 100
    const home = f.spending.categories.forecast.find((c: { category: string }) => c.category === "Home");
    expect(home.typical).toBe(600); //                    all-history median: 0
  });

  it("reads money-in off the balance across the same twelve months", async () => {
    const f = await get("/api/finance");
    expect(f.summary.spanMonths).toBe(12);
    expect(f.summary.drift).toBe(1299.92); // 2,000 in - 700 out a month, less the closing EUR 1 over 12
    // 2,000 lands every month: the average outflow (700.08, the closing EUR 1
    // included) + this window's drift. A median outflow (700) said 1,999.92
    // — the median-plus-mean mix FIN-011 is about.
    expect(f.savings.incomeMonthly).toBe(2000);
  });

  it("gives the Dashboard the same window, so the two quote one target", async () => {
    const f = await get("/api/finance");
    const h = await get("/api/home");
    const target = JSON.stringify(h).match(/"savings":\{"target":(-?[\d.]+)/)?.[1];
    expect(target).toBeDefined();
    expect(Number(target)).toBe(f.savings.target);
  });

  it("gives a category's totals for every year the statements reach, marking the part ones", async () => {
    const c = await get("/api/finance/category/Home");
    expect(c.yearly.map((y: { year: string }) => y.year)).toEqual(["2021", "2022", "2023", "2024", "2025"]);
    const by = Object.fromEntries(c.yearly.map((y: { year: string; total: number; partial: boolean }) => [y.year, y]));
    expect(by["2022"]).toMatchObject({ total: 0, partial: false }); // no rent yet: zero, not missing
    expect(by["2024"]).toMatchObject({ total: 2400, partial: false }); // Sep-Dec at 600
    expect(by["2025"]).toMatchObject({ total: 4800, partial: true }); //  Jan-Aug, statements stop in August
  });

  it("compares an old month with its own time, not with today", async () => {
    const then = await get("/api/finance/month/2022-06");
    expect(then.typical).toBe(100); // the months around mid-2022, not 2025's 700
    const recent = await get("/api/finance/month/2025-08");
    expect(recent.typical).toBe(700);
  });
});
