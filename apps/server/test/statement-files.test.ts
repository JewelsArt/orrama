/**
 * Several statement files: a USD-only export sitting beside the euro ones must
 * not add dollars to euro spending or supply the "latest" balance, and merged
 * rows are ordered by time, not by date.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { balanceSpan, loadTxns } from "../src/routes/finance.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "basalt-stmts-"));
const dir = path.join(root, "02-Areas/finance/files");
fs.mkdirSync(dir, { recursive: true });
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const H = "Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance";
const row = (at: string, desc: string, amt: string, cur: string, bal: string) => `Card Payment,Current,${at},${at},${desc},${amt},0.00,${cur},COMPLETED,${bal}`;

fs.writeFileSync(path.join(dir, "a-eur.csv"), [H, row("2026-08-01 10:00:00", "Cafe", "-4.00", "EUR", "96.00"), row("2026-08-02 18:00:00", "Books", "-16.00", "EUR", "80.00"), row("2026-08-02 09:00:00", "Bus", "-2.00", "EUR", "94.00")].join("\n"));
fs.writeFileSync(path.join(dir, "b-usd.csv"), [H, row("2026-09-10 10:00:00", "NYC hotel", "-400.00", "USD", "600.00")].join("\n"));

describe("statement files", () => {
  it("leave out a file in another currency, and order rows by time", () => {
    const txns = loadTxns(root);
    expect(txns.map((t) => t.description)).toEqual(["Cafe", "Bus", "Books"]);
    const span = balanceSpan(root);
    expect(span.balance).toBe(80); // not the USD file's later 600
    expect(span.balanceDate).toBe("2026-08-02");
  });
});
