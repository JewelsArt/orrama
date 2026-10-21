/**
 * Money in screens (stage 1, 1G), on an empty vault: a friend starts with no ledger notes, adds a
 * subscription, an income line, categories with their words and an own account, uploads a
 * statement and sees its rows land in those categories, moves a shop to another category, and
 * changes and removes each kind of row. Every change is a row of a Markdown table in a note the
 * app made in the finance area: delete the database and the money is still there.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessionOf, signedIn } from "./helpers/session.js";

process.env.ORRAMA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-fin-writes-"));
process.env.ORRAMA_VAULT_DIR = path.join(process.env.ORRAMA_DATA_DIR, "vault");
process.env.ORRAMA_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.ORRAMA_SECRET_KEY = "test-secret-key-0123456789abcdef";

const VAULT = process.env.ORRAMA_VAULT_DIR;
const FIN = path.join(VAULT, "02-Areas/finance");
const read = (rel: string) => fs.readFileSync(path.join(VAULT, rel), "utf8");

/** Three months of a made-up Revolut export. */
function statement(): string {
  const lines = ["Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance"];
  let balance = 3000;
  let n = 0;
  const add = (date: string, type: string, what: string, amount: number) => {
    balance = Math.round((balance + amount) * 100) / 100;
    const at = `${date} 10:00:${String(n++ % 60).padStart(2, "0")}`;
    lines.push(`${type},Current,${at},${at},${what},${amount.toFixed(2)},0.00,EUR,COMPLETED,${balance.toFixed(2)}`);
  };
  for (const m of ["07", "08", "09"]) {
    add(`2026-${m}-01`, "Transfer", "Payment from FICTIVE BV", 2000);
    add(`2026-${m}-03`, "Card Payment", "DIRK VAN DEN BROEK", -45);
    add(`2026-${m}-08`, "Card Payment", "HEMA AMSTERDAM", -20);
    add(`2026-${m}-12`, "Card Payment", "PIZZA PALAZZO", -30);
    add(`2026-${m}-15`, "Card Payment", "STREAMFLIX", -12.99);
    add(`2026-${m}-20`, "Card Payment", "BROKERLY", -100);
    add(`2026-${m}-25`, "Card Payment", "NS", -15);
  }
  return lines.join("\n");
}

/** A one-page PDF whose text layer is `text` (the payslip reader's input), as create-only.test.ts makes it. */
function textPdf(text: string): Buffer {
  const stream = `BT /F1 10 Tf 40 700 Td (${text.replace(/[()\\]/g, "\\$&")}) Tj ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const { buildServer } = await import("../src/main.js");
let app: Awaited<ReturnType<typeof buildServer>>["app"];
const tokens: Record<string, string> = {};
type Method = "GET" | "POST" | "PATCH" | "DELETE";
const call = (method: Method, url: string, payload?: object, who = "jules") => app.inject({ method, url, headers: signedIn(tokens[who]), payload });
const ok = async (method: Method, url: string, payload?: object) => {
  const res = await call(method, url, payload);
  if (res.statusCode !== 200) throw new Error(`${method} ${url} → ${res.statusCode} ${res.body}`);
  return res.json();
};
const finance = () => ok("GET", "/api/finance");
type Table = { noteId: string; version: string; fields: string[]; rows: { index: number; line: number; name: string; cells: Record<string, string> }[] };
const table = async (id: string): Promise<Table> => (await finance()).tables[id];
/** Until the index has seen an edit made outside the app (the watcher settles in its own time). */
async function until(seen: () => Promise<boolean>) {
  for (let i = 0; i < 100 && !(await seen()); i++) await new Promise((r) => setTimeout(r, 100));
}
const rowOf = (t: Table, name: string) => {
  const r = t.rows.find((x) => x.name === name);
  if (!r) throw new Error(`no row ${name} in ${JSON.stringify(t.rows.map((x) => x.name))}`);
  return r;
};

beforeAll(async () => {
  fs.mkdirSync(VAULT, { recursive: true });
  // The seed's demo users and notes, and nothing of Money: no ledger note, no finance folder.
  await import("../src/seed.js");
  app = (await buildServer()).app;
  for (const who of ["jules", "mara"])
    tokens[who] = sessionOf(await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: `${who}@orrama.dev`, password: "orrama-demo" } }));
});
afterAll(async () => {
  await app.close();
  fs.rmSync(process.env.ORRAMA_DATA_DIR!, { recursive: true, force: true });
});

describe("an empty vault: every ledger note is made by the first add", () => {
  it("starts with no ledger note and nothing to change", async () => {
    expect(fs.existsSync(FIN)).toBe(false);
    const d = await finance();
    expect(d.tables).toEqual({ subscriptions: null, income: null, payslips: null, categories: null, "own-accounts": null });
  });

  it("the first subscription makes the note in the finance area, tagged, with its table", async () => {
    const res = await ok("POST", "/api/finance/subscriptions", { service: "Streamflix", amount: "12.99", cadence: "monthly", next: "2026-10-15", note: "" });
    expect(res.path).toBe("02-Areas/finance/Subscriptions.md");
    const text = read("02-Areas/finance/Subscriptions.md");
    expect(text).toMatch(/tags:\n {2}- subscriptions\n/);
    expect(text).toContain("| Service | Amount | Every | Next | Note |\n|---|---|---|---|---|\n| Streamflix | 12.99 | monthly | 2026-10-15 |  |");
    const d = await finance();
    expect(d.notes.subscriptions).toBe(res.noteId);
    expect(d.subscriptions.items.map((i: { service: string }) => i.service)).toEqual(["Streamflix"]);
    expect(d.tables.subscriptions.rows).toEqual([{ index: 0, line: d.subscriptions.items[0].line, name: "Streamflix", cells: { service: "Streamflix", amount: "12.99", cadence: "monthly", next: "2026-10-15", note: "" } }]);
  });

  it("income, categories, an own account: each makes its own note on its first add", async () => {
    expect((await ok("POST", "/api/finance/income", { service: "Fictive BV", amount: "2000", cadence: "monthly", next: "2026-10-01" })).path).toBe("02-Areas/finance/Income.md");
    expect(read("02-Areas/finance/Income.md")).toContain("| Source | Amount | Every | Next | Note |");
    expect((await ok("POST", "/api/finance/categories", { category: "Groceries", matches: "dirk van den broek" })).path).toBe("02-Areas/finance/Spending categories.md");
    await ok("POST", "/api/finance/categories", { category: "Shopping", matches: "hema, pizza" });
    await ok("POST", "/api/finance/categories", { category: "Transport" });
    expect((await ok("POST", "/api/finance/own-accounts", { account: "Brokerly", matches: "brokerly" })).path).toBe("02-Areas/finance/Own accounts.md");
    const t = await table("categories");
    expect(t.rows.map((r) => [r.name, r.cells["matches"]])).toEqual([
      ["Groceries", "dirk van den broek"],
      ["Shopping", "hema, pizza"],
      ["Transport", ""],
    ]);
  });

  it("refuses a second category of the same name", async () => {
    const res = await call("POST", "/api/finance/categories", { category: "groceries" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("There is already a category called groceries.");
  });

  it("a statement's rows land in those categories, and the own account is a move, not spending", async () => {
    fs.mkdirSync(path.join(FIN, "files"), { recursive: true });
    const up = await ok("POST", "/api/finance/payslip", { name: "statement.csv", dataBase64: Buffer.from(statement()).toString("base64") });
    expect(up.statement.rows).toBe(21);
    const m = await ok("GET", "/api/finance/month/2026-08");
    const byCat = Object.fromEntries(m.categories.map((c: { category: string; total: number }) => [c.category, c.total]));
    expect(byCat).toEqual({ Groceries: 45, Shopping: 50, Other: 15, Subscriptions: 12.99 });
    expect(m.transactions.find((t: { description: string }) => t.description === "BROKERLY")).toMatchObject({ moved: true });
  });
});

describe("put a shop in a category", () => {
  it("moves every row of that shop and says where it came from", async () => {
    const res = await ok("POST", "/api/finance/categories/shop", { merchant: "PIZZA PALAZZO", category: "Eating out" });
    expect(res).toMatchObject({ from: "Shopping", to: "Eating out", term: "pizza palazzo" });
    const m = await ok("GET", "/api/finance/month/2026-08");
    expect(m.transactions.find((t: { description: string }) => t.description === "PIZZA PALAZZO").category).toBe("Eating out");
    expect(m.transactions.find((t: { description: string }) => t.description === "HEMA AMSTERDAM").category).toBe("Shopping");
    expect(rowOf(await table("categories"), "Eating out").cells["matches"]).toBe("pizza palazzo");
  });

  it("a short name files as the whole description", async () => {
    expect((await ok("POST", "/api/finance/categories/shop", { merchant: "NS", category: "Transport" })).term).toBe("=ns");
    expect((await ok("GET", "/api/finance/merchant/NS")).filing).toEqual({ category: "Transport", commitment: null, own: null });
  });

  it("refuses a shop a commitment claims, and an own account, saying why", async () => {
    const sub = await call("POST", "/api/finance/categories/shop", { merchant: "STREAMFLIX", category: "Shopping" });
    expect(sub.statusCode).toBe(422);
    expect(sub.json().error).toBe("STREAMFLIX is your Streamflix commitment, so it stays under Subscriptions.");
    expect((await ok("GET", "/api/finance/merchant/STREAMFLIX")).filing).toEqual({ category: "Subscriptions", commitment: "Streamflix", own: null });
    const own = await call("POST", "/api/finance/categories/shop", { merchant: "BROKERLY", category: "Shopping" });
    expect(own.statusCode).toBe(422);
    expect((await ok("GET", "/api/finance/merchant/BROKERLY")).filing.own).toBe("Brokerly");
  });
});

describe("change and remove each kind of row", () => {
  it("a subscription: every field, all eight cadences accepted, then removed", async () => {
    let t = await table("subscriptions");
    const r = rowOf(t, "Streamflix");
    await ok("PATCH", `/api/finance/subscriptions/${r.index}`, { version: t.version, name: r.name, set: { service: "Streamflix 4K", amount: "15.99", cadence: "half-yearly", next: "2026-12-15", note: "family" } });
    const item = (await finance()).subscriptions.items[0];
    expect(item).toMatchObject({ service: "Streamflix 4K", amount: 15.99, cadence: "half-yearly", anchor: "2026-12-15", note: "family" });
    t = await table("subscriptions");
    for (const cadence of ["weekly", "biweekly", "4-weekly", "monthly", "2-monthly", "quarterly", "half-yearly", "yearly"]) {
      const cur = await table("subscriptions");
      await ok("PATCH", `/api/finance/subscriptions/0`, { version: cur.version, name: "Streamflix 4K", set: { cadence } });
      expect((await finance()).subscriptions.items[0].cadence).toBe(cadence);
    }
    const bad = await call("PATCH", `/api/finance/subscriptions/0`, { version: (await table("subscriptions")).version, name: "Streamflix 4K", set: { cadence: "bimonthly" } });
    expect(bad.statusCode).toBe(400);
    const cur = await table("subscriptions");
    await ok("DELETE", `/api/finance/subscriptions/0`, { version: cur.version, name: "Streamflix 4K" });
    expect((await finance()).subscriptions.items).toEqual([]);
    expect(read("02-Areas/finance/Subscriptions.md")).toContain("| Service | Amount | Every | Next | Note |\n|---|---|---|---|---|\n");
  });

  it("refuses a change against a table changed since it was read: 409, the note untouched", async () => {
    await ok("POST", "/api/finance/income", { service: "Side gig", amount: "100", cadence: "monthly" });
    const t = await table("income");
    // Someone edits the table in another editor.
    const file = path.join(FIN, "Income.md");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("| Fictive BV | 2000 |", "| Fictive BV | 2100 |"));
    await until(async () => (await table("income")).version !== t.version);
    const before = read("02-Areas/finance/Income.md");
    const res = await call("PATCH", `/api/finance/income/${rowOf(t, "Side gig").index}`, { version: t.version, name: "Side gig", set: { amount: "150" } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/changed since you opened it/);
    expect(read("02-Areas/finance/Income.md")).toBe(before);
    const del = await call("DELETE", `/api/finance/income/${rowOf(t, "Side gig").index}`, { version: t.version, name: "Side gig" });
    expect(del.statusCode).toBe(409);
  });

  it("income: changed and removed", async () => {
    let t = await table("income");
    await ok("PATCH", `/api/finance/income/${rowOf(t, "Side gig").index}`, { version: t.version, name: "Side gig", set: { amount: "150", cadence: "4-weekly" } });
    expect((await finance()).income.items.find((i: { service: string }) => i.service === "Side gig")).toMatchObject({ amount: 150, cadence: "4-weekly" });
    t = await table("income");
    await ok("DELETE", `/api/finance/income/${rowOf(t, "Side gig").index}`, { version: t.version, name: "Side gig" });
    expect((await finance()).income.items.map((i: { service: string }) => i.service)).toEqual(["Fictive BV"]);
  });

  it("categories: renamed, words changed, reordered (the colours' order), removed", async () => {
    let t = await table("categories");
    await ok("PATCH", `/api/finance/categories/${rowOf(t, "Shopping").index}`, { version: t.version, name: "Shopping", set: { category: "Shops", matches: "hema, kruidvat" } });
    t = await table("categories");
    expect(rowOf(t, "Shops").cells["matches"]).toBe("hema, kruidvat");
    const rename = await call("PATCH", `/api/finance/categories/${rowOf(t, "Shops").index}`, { version: t.version, name: "Shops", set: { category: "Groceries" } });
    expect(rename.statusCode).toBe(409);
    await ok("POST", `/api/finance/categories/${rowOf(t, "Transport").index}/move`, { version: t.version, name: "Transport", to: 0 });
    expect((await finance()).spending.categories.rules.slice(0, 3).map((r: { category: string }) => r.category)).toEqual(["Transport", "Groceries", "Shops"]);
    t = await table("categories");
    await ok("DELETE", `/api/finance/categories/${rowOf(t, "Shops").index}`, { version: t.version, name: "Shops" });
    expect((await table("categories")).rows.map((r) => r.name)).toEqual(["Transport", "Groceries", "Eating out"]);
    const m = await ok("GET", "/api/finance/month/2026-08");
    expect(m.transactions.find((x: { description: string }) => x.description === "HEMA AMSTERDAM").category).toBe("Other");
  });

  it("an own account: words changed, then removed, and its rows count as spending again", async () => {
    let t = await table("own-accounts");
    await ok("PATCH", `/api/finance/own-accounts/0`, { version: t.version, name: "Brokerly", set: { matches: "brokerly, brokerly sa" } });
    t = await table("own-accounts");
    expect(t.rows[0]!.cells["matches"]).toBe("brokerly, brokerly sa");
    await ok("DELETE", `/api/finance/own-accounts/0`, { version: t.version, name: "Brokerly" });
    const m = await ok("GET", "/api/finance/month/2026-08");
    expect(m.transactions.find((x: { description: string }) => x.description === "BROKERLY")).toMatchObject({ moved: false });
  });

  it("the first payslip PDF read on upload makes the payslips note and files it", async () => {
    const pdf = textPdf("BRUTO 2.600,00 15.600,00 NETTOLOON 2.000,00 12.000,00 Verl. per. 07/2026");
    const up = await ok("POST", "/api/finance/payslip", { name: "july.pdf", dataBase64: pdf.toString("base64") });
    expect(up).toMatchObject({ filed: true, stored: true, name: "july.pdf" });
    expect(read("02-Areas/finance/Payslips.md")).toContain("| Month | Gross | Net | Tax | Hours | Rate | File |\n|---|---|---|---|---|---|---|\n| 2026-07 | 2600.00 | 2000.00 | 600.00 |  |  | july.pdf |");
    // A layout it cannot read is kept and not filed: the screen asks for the figures.
    const odd = await ok("POST", "/api/finance/payslip", { name: "august.pdf", dataBase64: textPdf("Salary statement August, total 2.000").toString("base64") });
    expect(odd).toMatchObject({ filed: false, stored: true, name: "august.pdf", reason: "unfamiliar payslip layout" });
  });

  it("a payslip typed by hand files beside them; changed figures move what was withheld; removed", async () => {
    const res = await ok("POST", "/api/finance/payslips", { month: "2026-08", gross: 2600, net: 2000, file: "august.pdf" });
    expect(res.path).toBe("02-Areas/finance/Payslips.md");
    expect((await finance()).payslips).toMatchObject([{ month: "2026-07" }, { month: "2026-08", gross: 2600, net: 2000, tax: 600, file: "august.pdf" }]);
    const twice = await call("POST", "/api/finance/payslips", { month: "2026-08", net: 1 });
    expect(twice.statusCode).toBe(409);
    expect((await call("POST", "/api/finance/payslips", { month: "2026-09" })).statusCode).toBe(400);
    let t = await table("payslips");
    await ok("PATCH", `/api/finance/payslips/${rowOf(t, "2026-08").index}`, { version: t.version, name: "2026-08", set: { net: "2100" } });
    expect((await finance()).payslips[1]).toMatchObject({ month: "2026-08", gross: 2600, net: 2100, tax: 500 });
    t = await table("payslips");
    await ok("DELETE", `/api/finance/payslips/${rowOf(t, "2026-08").index}`, { version: t.version, name: "2026-08" });
    expect((await finance()).payslips.map((p: { month: string }) => p.month)).toEqual(["2026-07"]);
  });

  it("refuses a field a ledger does not keep, and an unknown ledger", async () => {
    const t = await table("income");
    expect((await call("PATCH", `/api/finance/income/0`, { version: t.version, name: "Fictive BV", set: { colour: "pink" } })).statusCode).toBe(400);
    expect((await call("POST", "/api/finance/budgets", { name: "x" })).statusCode).toBe(404);
    expect((await call("PATCH", `/api/finance/income/zero`, { version: t.version, name: "Fictive BV", set: {} })).statusCode).toBe(400);
  });
});

describe("who may make a ledger note", () => {
  it("someone who cannot edit the finance area is refused, and nothing is made", async () => {
    fs.rmSync(path.join(FIN, "Own accounts.md"));
    await until(async () => (await table("own-accounts")) === null);
    const res = await call("POST", "/api/finance/own-accounts", { account: "Pot", matches: "pot" }, "mara");
    expect(res.statusCode).toBe(403);
    expect(fs.existsSync(path.join(FIN, "Own accounts.md"))).toBe(false);
  });

  it("a note tagged for a ledger but holding no table gets the table at its end, its own text kept", async () => {
    const prose = "---\ntags:\n  - own-accounts\n---\n\n# My accounts\n\nThe broker and the pot.";
    fs.writeFileSync(path.join(FIN, "accounts.md"), prose);
    await until(async () => (await table("own-accounts")) !== null);
    const res = await ok("POST", "/api/finance/own-accounts", { account: "Pot", matches: "savings pot" });
    expect(res.path).toBe("02-Areas/finance/accounts.md");
    expect(read("02-Areas/finance/accounts.md")).toMatch(/\n# My accounts\n\nThe broker and the pot\.\n\n\| Account \| Matches \|\n\|---\|---\|\n\| Pot \| savings pot \|\n$/);
  });
});
