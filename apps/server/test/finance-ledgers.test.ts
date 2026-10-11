/**
 * The ledgers as the Finance tab reads them: what a hand-kept row is worth,
 * what it is compared against, and which rows were left out. Each case is one
 * the audit found silently wrong (FIN-004, FIN-006, FIN-012, FIN-013).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.BASALT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "basalt-fin-ledgers-"));
process.env.BASALT_VAULT_DIR = path.join(process.env.BASALT_DATA_DIR, "vault");
process.env.BASALT_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.BASALT_SECRET_KEY = "test-secret-key-0123456789abcdef";

const FIN = path.join(process.env.BASALT_VAULT_DIR, "02-Areas/finance");
const note = (title: string, tag: string, body: string) => `---\ntitle: ${title}\ntags:\n  - ${tag}\n---\n\n${body}\n`;

/**
 * A year of a Revolut export in which every ledger line is charged exactly as
 * the ledger says, plus one catch-up payment, a broker deposit, a weekly
 * habit no ledger line claims, and a merchant with "%" in its name.
 */
function statement(): string {
  const lines = ["Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance"];
  const rows: [string, string, string, number][] = [];
  const add = (date: string, type: string, what: string, amount: number) => rows.push([date, type, what, amount]);
  add("2025-03-15", "Card Payment", "NAMECHEAP", -120); // yearly
  add("2026-03-15", "Card Payment", "NAMECHEAP", -120);
  for (const d of ["2025-12-10", "2026-03-10", "2026-06-10", "2026-09-10"]) add(d, "Card Payment", "CENTRAAL BEHEER", -90); // quarterly
  for (let i = 0; i < 8; i++) add(new Date(Date.UTC(2026, 7, 4 + 7 * i)).toISOString().slice(0, 10), "Card Payment", "YOGA STUDIO", -12); // weekly, Tuesdays
  for (const m of ["06", "07", "08", "09"]) {
    add(`2026-${m}-01`, "Transfer", "Payment from EMPLOYER BV", 1800); // monthly income
    add(`2026-${m}-02`, "Transfer", "To Stichting DUWO", -600); // rent
    add(`2026-${m}-03`, "Card Payment", "CAPITAL.COM", -200); // an own account, not a subscription
    add(`2026-${m}-12`, "Card Payment", "SHOP 100% LOCAL", -19.5);
  }
  add("2026-07-15", "Transfer", "Payment from EMPLOYER BV", 300); // a catch-up payment
  for (let i = 0; i < 13; i++) add(new Date(Date.UTC(2026, 6, 4 + 7 * i)).toISOString().slice(0, 10), "Card Payment", "BOULDER HALL", -9); // weekly, unclaimed
  rows.sort((a, b) => a[0].localeCompare(b[0]));
  let balance = 5000;
  rows.forEach(([date, type, what, amount], i) => {
    balance = Math.round((balance + amount) * 100) / 100;
    const at = `${date} 10:00:${String(i % 60).padStart(2, "0")}`;
    lines.push(`${type},Current,${at},${at},${what},${amount.toFixed(2)},0.00,EUR,COMPLETED,${balance.toFixed(2)}`);
  });
  return lines.join("\n");
}

const { buildServer } = await import("../src/main.js");
let app: Awaited<ReturnType<typeof buildServer>>["app"];
let token = "";
const call = (method: "GET" | "POST", url: string, payload?: object) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload });
const get = async (url: string) => {
  const res = await call("GET", url);
  expect(res.statusCode).toBe(200);
  return res.json();
};

beforeAll(async () => {
  fs.mkdirSync(path.join(FIN, "files"), { recursive: true });
  fs.writeFileSync(
    path.join(FIN, "subscriptions.md"),
    note(
      "Subscriptions",
      "subscriptions",
      [
        "| Service | Amount | Every | Next | Match |",
        "|---|---|---|---|---|",
        "| Rent | 600 | monthly | 2026-10-02 | stichting duwo |",
        "| Car insurance | 300 | half-yearly | 2027-01-01 | |",
        "| Domain | 120 | yearly | 2027-03-15 | namecheap |",
        "| Insurance | 90 | quarterly | 2026-12-10 | centraal beheer |",
        "| Yoga | 12 | weekly | 2026-09-29 | yoga studio |",
        "| Club | 60 | every so often | 2026-10-05 | |",
        "| Gym | €29.99 / 12 months | monthly | | |",
      ].join("\n"),
    ),
  );
  fs.writeFileSync(
    path.join(FIN, "income.md"),
    note("Income", "income", "| Source | Amount | Every | Next | Match |\n|---|---|---|---|---|\n| Salary | 1800 | monthly | 2026-10-01 | employer bv |"),
  );
  fs.writeFileSync(path.join(FIN, "own-accounts.md"), note("Own accounts", "own-accounts", "| Account | Matches |\n|---|---|\n| Capital.com | capital.com |"));
  fs.writeFileSync(
    path.join(FIN, "spending-categories.md"),
    note("Spending categories", "spending-categories", "| Category | Matches |\n|---|---|\n| 50% Off | shop 100% local |"),
  );
  fs.writeFileSync(path.join(FIN, "files", "statement.csv"), statement());
  await import("../src/seed.js");
  app = (await buildServer()).app;
  token = (await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "jules@basalt.dev", password: "basalt-demo" } })).json().token;
});
afterAll(async () => {
  await app.close();
  fs.rmSync(process.env.BASALT_DATA_DIR!, { recursive: true, force: true });
});

describe("rows the ledger cannot read (FIN-005, FIN-006)", () => {
  it("are counted nowhere and named in the response", async () => {
    const d = await get("/api/finance");
    expect(d.subscriptions.items.map((s: { service: string }) => s.service)).toEqual(["Rent", "Car insurance", "Domain", "Insurance", "Yoga"]);
    expect(d.subscriptions.totals).toEqual([{ currency: "EUR", monthly: 742 }]);
    // Line numbers are the file as it is on disk, its stamped `id:` included.
    expect(d.subscriptions.unreadable).toEqual([
      { service: "Club", line: 15, field: "cadence", text: "every so often" },
      { service: "Gym", line: 16, field: "amount", text: "€29.99 / 12 months" },
    ]);
    expect(d.income.unreadable).toEqual([]);
  });

  it("the add-row form's API takes every cadence the parser reads", async () => {
    const res = await call("POST", "/api/finance/subscriptions", { service: "Cleaner", amount: "40", cadence: "biweekly", next: "2026-10-09" });
    expect(res.statusCode).toBe(200);
    const d = await get("/api/finance");
    const cleaner = d.subscriptions.items.find((s: { service: string }) => s.service === "Cleaner");
    expect(cleaner).toMatchObject({ cadence: "biweekly", monthly: 86.67 });
  });
});

describe("what a ledger card expects to have seen (FIN-004)", () => {
  type Act = { charges: number; total: number; expected: number };
  const activity = async () => {
    const d = await get("/api/finance");
    return { out: d.subscriptions.activity as Record<string, Act>, in: d.income.activity as Record<string, Act> };
  };

  it("a yearly, a quarterly and a weekly line charged exactly as written expect exactly that", async () => {
    const { out } = await activity();
    expect(out["Domain"]).toMatchObject({ charges: 2, total: 240, expected: 240 });
    expect(out["Insurance"]).toMatchObject({ charges: 4, total: 360, expected: 360 });
    expect(out["Yoga"]).toMatchObject({ charges: 8, total: 96, expected: 96 });
    expect(out["Rent"]).toMatchObject({ charges: 4, total: 2400, expected: 2400 });
  });

  it("a monthly line with one catch-up payment still shows the extra", async () => {
    const { in: income } = await activity();
    expect(income["Salary"]).toMatchObject({ charges: 5, total: 7500, expected: 7200 });
  });
});
