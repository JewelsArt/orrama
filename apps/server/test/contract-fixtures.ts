/**
 * A vault and database where every endpoint the web app reads has something
 * to say: finance files and ledgers, calendar rows (an event, a time block,
 * a subscribed feed), project documents of every kind the reader opens, a
 * board, tokens, webhooks, a passkey, a mail account and a draft. An empty
 * list proves nothing about the shape of its items, so the contract test
 * runs against this, not a bare seed.
 *
 * Import AFTER setting BASALT_DATA_DIR / BASALT_VAULT_DIR / BASALT_FETCH_ALLOW.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { deck } from "./helpers/pptx.js";

/**
 * Fifteen months of a Revolut statement ending today: enough history for
 * typical months, headroom and recurring charges, and a row in the current
 * month for the Dashboard. Relative to the clock, so it never goes stale.
 */
function statement(now = new Date()): string {
  const rows: { at: string; type: string; desc: string; amount: number }[] = [];
  for (let back = 15; back >= 0; back--) {
    const m = new Date(now.getFullYear(), now.getMonth() - back, 1);
    const ym = `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, "0")}`;
    const add = (day: number, type: string, desc: string, amount: number) => {
      if (back === 0 && day > now.getDate()) return; // not yet
      rows.push({ at: `${ym}-${String(day).padStart(2, "0")} 10:00:00`, type, desc, amount });
    };
    add(1, "Card Payment", "ALBERT HEIJN", -(40 + (back % 3) * 10));
    add(5, "Card Payment", "ADOBE", -19.66);
    add(10, "Card Payment", "UNIQLO", -(30 + back * 2));
    if (back % 4 === 0) add(12, "Card Refund", "UNIQLO", 10);
    add(25, "Transfer", "Payment from SALARY LTD", 500);
    add(26, "Transfer", "To investment account", -50);
  }
  let balance = 2000;
  return [
    "Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance",
    ...rows.map((r) => {
      balance = Math.round((balance + r.amount) * 100) / 100;
      return `${r.type},Current,${r.at},${r.at},${r.desc},${r.amount.toFixed(2)},0.00,EUR,COMPLETED,${balance.toFixed(2)}`;
    }),
  ].join("\n");
}

const ledger = (title: string, tag: string, table: string) => `---\ntitle: ${title}\ntags:\n  - ${tag}\n---\n\n${table}\n`;

const ICS = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VEVENT",
  "UID:contract-1@test",
  "DTSTART:20261005T090000Z",
  "DTEND:20261005T100000Z",
  "SUMMARY:Subscribed standup",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

/** Files and ledgers, written before the server boots. */
export function writeVaultFixtures(vault: string): void {
  const fin = path.join(vault, "02-Areas/finance");
  fs.mkdirSync(path.join(fin, "files"), { recursive: true });
  fs.writeFileSync(path.join(fin, "files", "statement.csv"), statement());
  fs.writeFileSync(path.join(fin, "spending-categories.md"), ledger("Spending categories", "spending-categories", "| Category | Matches | Colour |\n|---|---|---|\n| Groceries | albert heijn | pink |\n| Shopping | uniqlo | cyan |\n| Software | adobe | violet |"));
  fs.writeFileSync(path.join(fin, "subscriptions.md"), ledger("Subscriptions", "subscriptions", "| Service | Amount | Every | Next | Match |\n|---|---|---|---|---|\n| Adobe | 19.66 | monthly | 2026-10-12 | adobe |"));
  fs.writeFileSync(path.join(fin, "income.md"), ledger("Income", "income", "| Source | Amount | Every | Next | Match |\n|---|---|---|---|---|\n| Salary | 500 | monthly | 2026-10-25 | salary ltd |"));
  fs.writeFileSync(path.join(fin, "own-accounts.md"), ledger("Own accounts", "own-accounts", "| Account | Matches |\n|---|---|\n| Investment account | investment account |"));
  // Front matter is YAML, not text: numbers and lists where strings usually go.
  fs.mkdirSync(path.join(vault, "Shared"), { recursive: true });
  fs.writeFileSync(path.join(vault, "Shared", "Odd front matter.md"), "---\nsector: 2026\ndescription: [a, list]\n---\n# Odd\n");
  fs.writeFileSync(path.join(fin, "payslips.md"), ledger("Payslips", "payslips", "| Month | Gross | Net | Hours | Employer |\n|---|---|---|---|---|\n| 2026-02 | 600 | 500 | 160 | Salary Ltd |"));
}

/** Project documents of each kind the reader opens. */
export async function writeProjectFiles(vault: string, slug: string): Promise<void> {
  const dir = path.join(vault, "04-Projects", slug, "files");
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(import.meta.dirname, "fixtures", "links.docx"), path.join(dir, "brief.docx"));
  fs.writeFileSync(path.join(dir, "deck.pptx"), deck());
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Budget");
  ws.addRow(["Item", "Cost"]);
  ws.addRow(["Laptop", 900]);
  fs.writeFileSync(path.join(dir, "budget.xlsx"), Buffer.from(await wb.xlsx.writeBuffer()));
  fs.writeFileSync(path.join(dir, "notes.txt"), "plain text");
}

/** A board edited by hand into something that does not parse. */
export function writeBrokenBoard(vault: string, slug: string): void {
  fs.mkdirSync(path.join(vault, "04-Projects", slug), { recursive: true });
  fs.writeFileSync(path.join(vault, "04-Projects", slug, "documents.canvas"), "{ not json");
}

/** A local calendar feed the server may fetch (BASALT_FETCH_ALLOW=127.0.0.1). */
export async function serveIcs(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/calendar" });
    res.end(ICS);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/cal.ics`, close: () => new Promise((r) => server.close(() => r())) };
}

export const uid = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
