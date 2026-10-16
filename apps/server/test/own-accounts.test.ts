/**
 * The #own-accounts note, end to end: a Capital.com deposit the bank files as
 * a card payment is not spending on the Finance tab, the month view or the
 * Dashboard, and the savings plan counts it as saved rather than as the
 * balance going down.
 *
 * Fixture: six complete months of +1,000 salary, -300 groceries and -200 into
 * Capital.com. The balance climbs 500 a month; 700 a month is actually kept.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessionOf, signedIn } from "./helpers/session.js";

process.env.ORRAMA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-own-"));
process.env.ORRAMA_VAULT_DIR = path.join(process.env.ORRAMA_DATA_DIR, "vault");
process.env.ORRAMA_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.ORRAMA_SECRET_KEY = "test-secret-key-0123456789abcdef";

const FIN = path.join(process.env.ORRAMA_VAULT_DIR, "02-Areas/finance");
const note = (title: string, tag: string, body: string) => `---\ntitle: ${title}\ntags:\n  - ${tag}\n---\n\n${body}\n`;

let balance = 1000;
const lines = ["Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance"];
const row = (date: string, type: string, what: string, amount: number) => {
  balance = Math.round((balance + amount) * 100) / 100;
  lines.push(`${type},Current,${date} 10:00:00,${date} 10:00:00,${what},${amount.toFixed(2)},0.00,EUR,COMPLETED,${balance.toFixed(2)}`);
};
for (const m of ["01", "02", "03", "04", "05", "06"]) {
  row(`2025-${m}-01`, "Transfer", "Payment from EMPLOYER BV", 1000);
  row(`2025-${m}-05`, "Card Payment", "CAPITAL.COM", -200);
  row(`2025-${m}-15`, "Card Payment", "ALBERT HEIJN", -300);
}
row("2025-07-01", "Card Payment", "ALBERT HEIJN", -1); // June is complete

const { buildServer } = await import("../src/main.js");
let app: Awaited<ReturnType<typeof buildServer>>["app"];
let token = "";
const get = async (url: string) => (await app.inject({ method: "GET", url, headers: signedIn(token) })).json();

beforeAll(async () => {
  fs.mkdirSync(path.join(FIN, "files"), { recursive: true });
  fs.writeFileSync(path.join(FIN, "files", "statement.csv"), lines.join("\n"));
  fs.writeFileSync(
    path.join(FIN, "spending-categories.md"),
    // "Investing" also names the broker: the own-accounts list must still win.
    note("Spending categories", "spending-categories", "| Category | Matches |\n|---|---|\n| Groceries | albert heijn |\n| Investing | capital.com |"),
  );
  fs.writeFileSync(
    path.join(FIN, "own-accounts.md"),
    note("Own accounts", "own-accounts", "| Account | Matches |\n|---|---|\n| Capital.com | capital.com |"),
  );
  await import("../src/seed.js");
  app = (await buildServer()).app;
  token = sessionOf(await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "jules@orrama.dev", password: "orrama-demo" } }));
});

afterAll(async () => {
  await app.close();
  fs.rmSync(process.env.ORRAMA_DATA_DIR!, { recursive: true, force: true });
});

describe("a broker deposit on the Finance tab", () => {
  it("is not spending in any month", async () => {
    const d = await get("/api/finance");
    expect(d.spending.months.find((m: { month: string }) => m.month === "2025-03")).toMatchObject({ spend: 300, movedOut: 200 });
    expect(d.spending.categories.forecast.map((f: { category: string }) => f.category)).not.toContain("Investing");
  });

  it("is saved: the plan's surplus is the balance slope plus what went to the broker", async () => {
    const { savings, summary } = await get("/api/finance");
    expect(summary.drift).toBeCloseTo(500, 2); // what the bank account itself did
    expect(savings.surplus).toBeCloseTo(700, 2);
    expect(savings.incomeMonthly).toBeCloseTo(1000, 2); // not 800: the deposit is not money that never came in
  });

  it("is a transfer in the month view, not a cost", async () => {
    const m = await get("/api/finance/month/2025-03");
    expect(m).toMatchObject({ total: 300, movedOut: 200 });
  });
});

describe("the Dashboard", () => {
  it("quotes the same month and the same surplus", async () => {
    const { spending } = await get("/api/home");
    expect(spending).toMatchObject({ month: "2025-06", total: 300 });
    expect(spending.savings.surplus).toBeCloseTo(700, 2);
  });
});
