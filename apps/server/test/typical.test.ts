/**
 * One "typical month", across every surface that quotes one.
 *
 * The dashboard and the Finance tab summed each category's own median; the
 * month page took the median of the whole-month totals. Same statement, two
 * headline numbers (audit). This file exists to make the surfaces answer with
 * one number, and the fixture is built so the two old definitions cannot
 * coincide by luck: three categories that never spend in the same month, so
 * Σ median(category) is €150 while the median month total is €300.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.ORRAMA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "basalt-typical-"));
process.env.ORRAMA_VAULT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "basalt-typical-vault-"));
process.env.ORRAMA_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
// The startup guard refuses placeholder secrets everywhere now, not just
// under NODE_ENV=production, so the suite has to carry a real-shaped one too.
process.env.ORRAMA_SECRET_KEY = "test-secret-key-0123456789abcdef";

const VAULT = process.env.ORRAMA_VAULT_DIR!;
const FIN = path.join(VAULT, "02-Areas/finance");

const STATEMENT = [
  "Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance",
  // Starts on the 1st, so January is a complete month (FIN-008).
  "Card Payment,Current,2026-01-01 10:00:00,2026-01-01 10:00:00,ALBERT HEIJN,-300.00,0.00,EUR,COMPLETED,1000.00",
  "Card Payment,Current,2026-02-10 10:00:00,2026-02-10 10:00:00,UNIQLO,-300.00,0.00,EUR,COMPLETED,900.00",
  "Card Payment,Current,2026-03-10 10:00:00,2026-03-10 10:00:00,NS GROEP,-300.00,0.00,EUR,COMPLETED,800.00",
  "Card Payment,Current,2026-04-10 10:00:00,2026-04-10 10:00:00,ALBERT HEIJN,-600.00,0.00,EUR,COMPLETED,200.00",
  // May is a part-month, so completeMonths stops at April.
  "Card Payment,Current,2026-05-02 10:00:00,2026-05-02 10:00:00,ALBERT HEIJN,-25.00,0.00,EUR,COMPLETED,175.00",
].join("\n");

beforeAll(() => {
  fs.mkdirSync(path.join(FIN, "files"), { recursive: true });
  fs.writeFileSync(path.join(FIN, "files", "statement.csv"), STATEMENT);
  fs.writeFileSync(
    path.join(FIN, "spending-categories.md"),
    "---\ntitle: Spending categories\ntags:\n  - spending-categories\n---\n\n" +
      "| Category | Matches | Colour |\n|---|---|---|\n" +
      "| Groceries | albert heijn | pink |\n| Shopping | uniqlo | cyan |\n| Transport | ns groep | amber |\n",
  );
});

const { buildServer } = await import("../src/main.js");
let app: Awaited<ReturnType<typeof buildServer>>["app"];
let token: string;

const get = async (url: string) => {
  const res = await app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
  return res.json();
};

beforeAll(async () => {
  await import("../src/seed.js");
  app = (await buildServer()).app;
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: "jules@basalt.dev", password: "basalt-demo" },
  });
  token = res.json().token;
});

afterAll(async () => {
  await app.close();
  fs.rmSync(process.env.ORRAMA_DATA_DIR!, { recursive: true, force: true });
  fs.rmSync(VAULT, { recursive: true, force: true });
});

describe("one typical month", () => {
  it("is a month that happened: €300, not the €150 a sum of category medians gives", async () => {
    const fin = await get("/api/finance");
    expect(fin.spending.categories.completeMonths).toBe(4);
    // The definition this replaced, computed from the very same payload:
    // Groceries 150 + Shopping 0 + Transport 0.
    const sumOfCategoryMedians = fin.spending.categories.forecast.reduce(
      (a: number, f: { typical: number }) => a + f.typical,
      0,
    );
    expect(sumOfCategoryMedians).toBe(150);
    // Every month cost 300 or 600, so 300 is a month that actually happened.
    expect(fin.spending.categories.typical).toBe(300);
  });

  it("is the month page's number on the dashboard, for the month the card leads with", async () => {
    // The card compares one month, so it uses the month page's typical: the
    // months around it, itself excluded (FIN-014) — April (600) against
    // January to March, a month that happened, not the €150 sum of medians.
    const home = await get("/api/home");
    expect(home.spending).not.toBeNull();
    const page = await get(`/api/finance/month/${home.spending.month}`);
    expect(home.spending.typical).toBe(page.typical);
    expect(home.spending.typical).toBe(300);
  });

  it("is the same number on the month page, less the month being looked at", async () => {
    // March excluded, so Jan/Feb/Apr decide: median(300, 300, 600) = 300.
    const march = await get("/api/finance/month/2026-03");
    expect(march.typical).toBe(300);
    // Filtered to a category it is a typical month OF THAT CATEGORY: Groceries
    // over Jan/Feb/Apr is median(300, 0, 600) = 300.
    const groceries = await get("/api/finance/month/2026-03?category=Groceries");
    expect(groceries.typical).toBe(300);
    // And Shopping, which only ever ran in February, is 0 over the same three.
    const shopping = await get("/api/finance/month/2026-03?category=Shopping");
    expect(shopping.typical).toBe(0);
  });

  it("still compares on the month page when only two other months exist", async () => {
    // No three-month floor on the comparison, unlike the headline: the
    // category comparison finance.test.ts pins has exactly this shape. An
    // export starting on 10 January leaves January a part-month.
    fs.writeFileSync(path.join(FIN, "files", "statement.csv"), STATEMENT.replaceAll("2026-01-01", "2026-01-10"));
    try {
      // Feb and Apr left: median(300, 600) = 450.
      const march = await get("/api/finance/month/2026-03");
      expect(march.typical).toBe(450);
    } finally {
      fs.writeFileSync(path.join(FIN, "files", "statement.csv"), STATEMENT);
    }
  });

  it("withholds the dashboard card rather than quoting a typical €0", async () => {
    // Two complete months is under the three the card's own empty state names:
    // an export from 10 February covers March and April in full, no more.
    fs.writeFileSync(
      path.join(FIN, "files", "statement.csv"),
      STATEMENT.split("\n").filter((l) => !l.includes("2026-01-01")).join("\n"),
    );
    try {
      const home = await get("/api/home");
      expect(home.spending).toBeNull();
      const fin = await get("/api/finance");
      expect(fin.spending.categories.typical).toBeNull();
    } finally {
      fs.writeFileSync(path.join(FIN, "files", "statement.csv"), STATEMENT);
    }
  });
});
