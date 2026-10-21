/**
 * Money in screens (1G) on a filled vault: a ledger opened on a screen and saved without a change
 * is the same note, byte for byte, hand-padded columns, CRLF, unknown columns and unreadable rows
 * included, and Money's figures do not move.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessionOf, signedIn } from "./helpers/session.js";

process.env.ORRAMA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-fin-round-trip-"));
process.env.ORRAMA_VAULT_DIR = path.join(process.env.ORRAMA_DATA_DIR, "vault");
process.env.ORRAMA_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.ORRAMA_SECRET_KEY = "test-secret-key-0123456789abcdef";

const VAULT = process.env.ORRAMA_VAULT_DIR;
const FIN = path.join(VAULT, "02-Areas/finance");
const note = (title: string, tag: string, body: string) => `---\ntitle: ${title}\ntags:\n  - ${tag}\n---\n\n# ${title}\n\nKept by hand.\n\n${body}\n\nThe end.\n`;
const crlf = (s: string) => s.replace(/\n/g, "\r\n");

const LEDGERS: Record<string, string> = {
  "subscriptions.md": note(
    "Subscriptions",
    "subscriptions",
    [
      "| Service      | Amount  | Every     | Next       | Match         | Card |",
      "|--------------|---------|-----------|------------|---------------|------|",
      "| Rent         | 600     | monthly   | 2026-10-02 | stichting duwo | visa |",
      "| Club         | 60      | every so often | 2026-10-05 |          |      |",
      "| **Adobe CC** | €24,19  | maandelijks | 2026-09-21 | adobe       | visa |",
    ].join("\n"),
  ),
  "income.md": crlf(note("Income", "income", "| Source | Amount | Every | Next | Match |\n|---|---|---|---|---|\n| Salary | 1.800,00 | monthly | 2026-10-01 | employer bv |")),
  "spending-categories.md": note("Spending categories", "spending-categories", "| Category  | Matches                   | Colour |\n|-----------|---------------------------|--------|\n| Groceries | albert heijn, =ah, jumbo  | pink   |\n| Shopping  | uniqlo                    | cyan   |\n| Empty     |                           |        |"),
  "own-accounts.md": note("Own accounts", "own-accounts", "| Account     | Matches     | Since |\n|-------------|-------------|-------|\n| Capital.com | capital.com | 2024  |"),
  "payslips.md": crlf(note("Payslips", "payslips", "| Month   | Gross   | Net    | Employer   |\n|---------|---------|--------|------------|\n| 2026-02 | 2600,00 | 2000   | Fictive BV |")),
};

/** What a screen may set on each ledger: the round trip sends exactly those cells back. */
const SETTABLE: Record<string, string[]> = {
  subscriptions: ["service", "amount", "cadence", "next", "note"],
  income: ["service", "amount", "cadence", "next", "note"],
  categories: ["category", "matches"],
  "own-accounts": ["account", "matches"],
  payslips: ["month", "gross", "net", "tax"],
};

function statement(): string {
  const lines = ["Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance"];
  let balance = 5000;
  let n = 0;
  const add = (date: string, type: string, what: string, amount: number) => {
    balance = Math.round((balance + amount) * 100) / 100;
    const at = `${date} 10:00:${String(n++ % 60).padStart(2, "0")}`;
    lines.push(`${type},Current,${at},${at},${what},${amount.toFixed(2)},0.00,EUR,COMPLETED,${balance.toFixed(2)}`);
  };
  for (const m of ["06", "07", "08", "09"]) {
    add(`2026-${m}-01`, "Transfer", "Payment from EMPLOYER BV", 1800);
    add(`2026-${m}-02`, "Transfer", "To Stichting DUWO", -600);
    add(`2026-${m}-04`, "Card Payment", "ALBERT HEIJN", -55);
    add(`2026-${m}-06`, "Card Payment", "AH", -9);
    add(`2026-${m}-10`, "Card Payment", "UNIQLO", -40);
    add(`2026-${m}-21`, "Card Payment", "ADOBE", -24.19);
    add(`2026-${m}-22`, "Card Payment", "CAPITAL.COM", -150);
  }
  return lines.join("\n");
}

const { buildServer } = await import("../src/main.js");
let app: Awaited<ReturnType<typeof buildServer>>["app"];
let token = "";
const call = (method: "GET" | "PATCH", url: string, payload?: object) => app.inject({ method, url, headers: signedIn(token), payload });
const disk = () => Object.fromEntries(Object.keys(LEDGERS).map((f) => [f, fs.readFileSync(path.join(FIN, f), "utf8")]));

beforeAll(async () => {
  fs.mkdirSync(path.join(FIN, "files"), { recursive: true });
  for (const [file, text] of Object.entries(LEDGERS)) fs.writeFileSync(path.join(FIN, file), text);
  fs.writeFileSync(path.join(FIN, "files", "statement.csv"), statement());
  await import("../src/seed.js");
  app = (await buildServer()).app;
  token = sessionOf(await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "jules@orrama.dev", password: "orrama-demo" } }));
});
afterAll(async () => {
  await app.close();
  fs.rmSync(process.env.ORRAMA_DATA_DIR!, { recursive: true, force: true });
});

describe("a round trip without a change", () => {
  it("every row of every ledger, opened and saved as it is: the notes byte-identical, the figures unmoved", async () => {
    const before = (await call("GET", "/api/finance")).json();
    const months = ["2026-07", "2026-08"].map(async (m) => (await call("GET", `/api/finance/month/${m}`)).json());
    const monthsBefore = await Promise.all(months);
    const bytes = disk();
    let saved = 0;
    for (const [id, t] of Object.entries(before.tables as Record<string, { version: string; rows: { index: number; name: string; cells: Record<string, string> }[] }>)) {
      for (const row of t.rows) {
        const set = Object.fromEntries(Object.entries(row.cells).filter(([k]) => SETTABLE[id]!.includes(k)));
        const res = await call("PATCH", `/api/finance/${id}/${row.index}`, { version: t.version, name: row.name, set });
        expect(res.statusCode, `${id} ${row.name}: ${res.body}`).toBe(200);
        saved++;
      }
    }
    // Rent, Club, Adobe CC, Salary, three categories, one account, one payslip.
    expect(saved).toBe(9);
    expect(disk()).toEqual(bytes);
    const after = (await call("GET", "/api/finance")).json();
    expect(after).toEqual(before);
    expect(await Promise.all(["2026-07", "2026-08"].map(async (m) => (await call("GET", `/api/finance/month/${m}`)).json()))).toEqual(monthsBefore);
  });

  it("the unreadable row is listed for a screen to fix, and still counted nowhere", async () => {
    const d = (await call("GET", "/api/finance")).json();
    expect(d.subscriptions.unreadable.map((r: { service: string }) => r.service)).toEqual(["Club"]);
    expect(d.tables.subscriptions.rows.map((r: { name: string }) => r.name)).toEqual(["Rent", "Club", "**Adobe CC**"]);
    expect(d.subscriptions.items.map((r: { service: string; line: number }) => [r.service, r.line])).toEqual(
      d.tables.subscriptions.rows.filter((r: { name: string }) => r.name !== "Club").map((r: { name: string; line: number }) => [r.name.replace(/\*/g, ""), r.line]),
    );
  });
});
