/**
 * A ledger line that names a category must ADD to that category, not replace
 * the rule written for it — and only the ledger's own payments are committed.
 *
 * Jules's subscriptions ledger files his bouldering membership under
 * "Bouldering", and his spending-categories note has a Bouldering rule listing
 * the gyms. buildRules dropped the written rule whenever the ledger named the
 * same category, so every visit fell into "Other"; and the savings plan
 * treated any category the ledger named as committed wholesale. Here the
 * membership stays committed and the visits are discretionary.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.BASALT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "basalt-rules-"));
process.env.BASALT_VAULT_DIR = path.join(process.env.BASALT_DATA_DIR, "vault");
process.env.BASALT_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.BASALT_SECRET_KEY = "test-secret-key-0123456789abcdef";

const VAULT = process.env.BASALT_VAULT_DIR;
const FIN = path.join(VAULT, "02-Areas/finance");

const note = (title: string, tag: string, body: string) => `---\ntitle: ${title}\ntags:\n  - ${tag}\n---\n\n${body}\n`;

// Four complete months (the statement reaches 30 April). A EUR 1,000 salary,
// a EUR 40 membership, groceries, and visits that vary — 15, 45, 30, 60 — so
// the months differ and the savings plan has headroom to find. Balances are
// running, as a real export's are.
const EVENTS: [string, string, string, number][] = [];
const visits = { "01": 1, "02": 3, "03": 2, "04": 4 };
for (const [mm, n] of Object.entries(visits)) {
  EVENTS.push([`2026-${mm}-01`, "Transfer", "Payment from EMPLOYER BV", 1000]);
  EVENTS.push([`2026-${mm}-02`, "Card Payment", "BUCKAROO STICHTING", -40]);
  for (let i = 0; i < n; i++) EVENTS.push([`2026-${mm}-${String(10 + i).padStart(2, "0")}`, "Card Payment", "BOULDERMUUR", -15]);
  EVENTS.push([`2026-${mm}-20`, "Card Payment", "ALBERT HEIJN", -100]);
}
EVENTS.push(["2026-04-30", "Card Payment", "ALBERT HEIJN", -1]); // the statement reaches the month's last day
let balance = 500;
const STATEMENT = [
  "Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance",
  ...EVENTS.map(([d, type, what, amount]) => {
    balance = Math.round((balance + amount) * 100) / 100;
    return `${type},Current,${d} 10:00:00,${d} 10:00:00,${what},${amount.toFixed(2)},0.00,EUR,COMPLETED,${balance.toFixed(2)}`;
  }),
].join("\n");

const { buildServer } = await import("../src/main.js");
const { buildRules, loadTxns, savingsCategories } = await import("../src/routes/finance.js");
const { categoryOf, monthlyByCategory, parseCategoryRules, parseSubscriptions, ruleFor } = await import("@basalt/core");

const RULES_MD = note(
  "Spending categories",
  "spending-categories",
  "| Category | Matches | Colour |\n|---|---|---|\n| Groceries | albert heijn | pink |\n| Bouldering | bouldermuur, boulder | lilac |",
);
const LEDGER_MD = note(
  "Subscriptions",
  "subscriptions",
  "| Service | Amount | Every | Next | Match | Category |\n|---|---|---|---|---|---|\n| Climbing membership | 40 | monthly | 2026-04-02 | buckaroo | Bouldering |",
);

let app: Awaited<ReturnType<typeof buildServer>>["app"];
let token = "";

beforeAll(async () => {
  fs.mkdirSync(path.join(FIN, "files"), { recursive: true });
  fs.writeFileSync(path.join(FIN, "files", "statement.csv"), STATEMENT);
  fs.writeFileSync(path.join(FIN, "spending-categories.md"), RULES_MD);
  fs.writeFileSync(path.join(VAULT, "subscriptions.md"), LEDGER_MD);
  await import("../src/seed.js");
  app = (await buildServer()).app;
  const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "jules@basalt.dev", password: "basalt-demo" } });
  token = r.json().token;
});

afterAll(async () => {
  await app.close();
  fs.rmSync(process.env.BASALT_DATA_DIR!, { recursive: true, force: true });
});

const rules = async () => buildRules(parseCategoryRules(RULES_MD), parseSubscriptions(LEDGER_MD, "2026-04-30"), await loadTxns(VAULT));

describe("buildRules", () => {
  it("keeps the written rule for a category the ledger also names", async () => {
    expect(categoryOf("BOULDERMUUR", (await rules()))).toBe("Bouldering");
  });

  it("still lets the ledger's own term win its transaction, as a pinned rule", async () => {
    const won = ruleFor("BUCKAROO STICHTING", (await rules()));
    expect(won?.category).toBe("Bouldering");
    expect(won?.pinned).toBe(true);
    expect(ruleFor("BOULDERMUUR", (await rules()))?.pinned).toBeFalsy();
  });
});

describe("savingsCategories", () => {
  it("splits a category into its committed and discretionary parts", async () => {
    const months = monthlyByCategory(await loadTxns(VAULT), (await rules()));
    expect(months.map((m) => m.committed?.["Bouldering"] ?? 0)).toEqual([40, 40, 40, 40]);
    const cats = savingsCategories(["Bouldering", "Groceries"], months);
    expect(cats).toEqual([
      { category: "Bouldering", totals: [40, 40, 40, 40], committed: true },
      { category: "Bouldering", totals: [15, 45, 30, 60], committed: false },
      { category: "Groceries", totals: [100, 100, 100, 101], committed: false },
    ]);
  });
});

describe("GET /api/finance and /api/home", () => {
  it("put the visits in Bouldering and only the membership in committed", async () => {
    const fin = (await app.inject({ method: "GET", url: "/api/finance", headers: { authorization: `Bearer ${token}` } })).json();
    const bouldering = fin.spending.categories.forecast.find((f: { category: string }) => f.category === "Bouldering");
    expect(bouldering.typical).toBe(77.5); // median of 55, 85, 70, 100 — visits included
    expect(fin.spending.categories.forecast.some((f: { category: string }) => f.category === "Other")).toBe(false);
    expect(fin.savings.committedMonthly).toBe(40); // the membership, not the visits
    // Visits are discretionary, so the months differ and there is headroom to
    // find; with the whole category committed there would be none.
    expect(fin.savings.trimmable).toBeGreaterThan(0);

    // The Dashboard builds its own plan from the same data; it must quote the
    // same target, or the two screens disagree about what to save.
    const home = (await app.inject({ method: "GET", url: "/api/home", headers: { authorization: `Bearer ${token}` } })).json();
    const target = JSON.stringify(home).match(/"savings":\{"target":(-?[\d.]+)/)?.[1];
    expect(target).toBeDefined();
    expect(Number(target)).toBe(fin.savings.target);
  });
});
