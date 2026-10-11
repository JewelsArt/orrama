/**
 * loadTxns: every statement export in the finance folder, merged into one list
 * of transactions. The four finance endpoints and the dashboard all read it.
 *
 * Two opposite mistakes to avoid. Overlapping exports repeat transactions, and
 * a repeat must count once. But two purchases that merely LOOK alike — same
 * shop, same day, same price — are two purchases. Keying on date + amount +
 * fee + description merged those, and on the real statement 36 transactions
 * and EUR 599.50 disappeared from every figure.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

process.env.BASALT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "basalt-merge-"));
process.env.BASALT_VAULT_DIR = path.join(process.env.BASALT_DATA_DIR, "vault");

const { loadTxns } = await import("../src/routes/finance.js");

const HEADER = "Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance";
const card = (at: string, what: string, amount: string, balance: string) =>
  `Card Payment,Current,${at},${at},${what},${amount},0.00,EUR,COMPLETED,${balance}`;

/** A vault whose finance folder holds exactly these exports. */
const vaultWith = (files: Record<string, string[]>) => {
  const root = fs.mkdtempSync(path.join(process.env.BASALT_DATA_DIR!, "v-"));
  const dir = path.join(root, "02-Areas/finance/files");
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, lines] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), lines.join("\n"));
  return root;
};
const spent = (rows: { amount: number }[]) => Math.round(rows.reduce((s, r) => s + (r.amount < 0 ? -r.amount : 0), 0) * 100) / 100;

afterAll(() => fs.rmSync(process.env.BASALT_DATA_DIR!, { recursive: true, force: true }));

describe("loadTxns", () => {
  it("counts two identical-looking purchases on the same day as two", async () => {
    const root = vaultWith({
      "statement.csv": [
        HEADER,
        card("2026-06-10 08:05:12", "COFFEE CORNER", "-2.50", "997.50"),
        card("2026-06-10 15:40:03", "COFFEE CORNER", "-2.50", "995.00"),
      ],
    });
    const rows = await loadTxns(root);
    expect(rows).toHaveLength(2);
    expect(spent(rows)).toBe(5);
  });

  it("counts a transaction once when two overlapping exports both contain it", async () => {
    const jan = card("2026-01-15 10:00:00", "ALBERT HEIJN", "-40.00", "960.00");
    const feb = card("2026-02-15 10:00:00", "ALBERT HEIJN", "-60.00", "900.00");
    const mar = card("2026-03-15 10:00:00", "ALBERT HEIJN", "-80.00", "820.00");
    const root = vaultWith({ "jan-feb.csv": [HEADER, jan, feb], "feb-mar.csv": [HEADER, feb, mar] });
    const rows = await loadTxns(root);
    expect(rows.map((r) => r.date)).toEqual(["2026-01-15", "2026-02-15", "2026-03-15"]);
    expect(spent(rows)).toBe(180);
  });

  it("repeats that fall in the overlap count as often as they happened — not once, not doubled", async () => {
    const a = card("2026-02-10 08:00:00", "COFFEE CORNER", "-2.50", "997.50");
    const b = card("2026-02-10 16:00:00", "COFFEE CORNER", "-2.50", "995.00");
    const root = vaultWith({ "early.csv": [HEADER, a, b], "late.csv": [HEADER, a, b] });
    expect(await loadTxns(root)).toHaveLength(2);
  });

  // Exports cut at a time of day, not at midnight: the morning coffee is in
  // one file, the afternoon one in the next. Each file holds one, so only the
  // timestamps and balance say these are two different purchases.
  it("keeps both purchases when two exports split a day between them", async () => {
    const morning = card("2026-07-01 08:00:00", "COFFEE CORNER", "-2.50", "997.50");
    const afternoon = card("2026-07-01 16:00:00", "COFFEE CORNER", "-2.50", "995.00");
    const root = vaultWith({ "to-noon.csv": [HEADER, morning], "from-noon.csv": [HEADER, afternoon] });
    expect(await loadTxns(root)).toHaveLength(2);
  });

  // A bank that exports dates only, with no running balance: two identical
  // rows are all there is to go on, and one file holding two of them means two
  // happened. A second copy of the same export adds nothing.
  it("with no times and no balance, keeps repeats within a file and still merges repeated exports", async () => {
    const lines = ["Date,Description,Amount", "2026-05-03,BAKERY,-3.20", "2026-05-03,BAKERY,-3.20", "2026-05-04,BAKERY,-3.20"];
    expect(await loadTxns(vaultWith({ "may.csv": lines }))).toHaveLength(3);
    expect(await loadTxns(vaultWith({ "may.csv": lines, "may (1).csv": lines }))).toHaveLength(3);
  });

  // What every finance page reads, so the refund rule must already be applied
  // here: a refund for something bought before the statement starts is money
  // back, and one for a purchase in range cancels it in the purchase's month.
  it("hands every page refunds already settled against their purchases", async () => {
    const { costOf } = await import("@basalt/core");
    const root = vaultWith({
      "statement.csv": [
        HEADER,
        "Card Refund,Current,2026-01-07 10:00:00,2026-01-07 10:00:00,Rakuten,583.30,0.00,EUR,COMPLETED,1583.30",
        card("2026-03-10 12:00:00", "Coolblue", "-79.00", "1504.30"),
        "Card Refund,Current,2026-04-02 09:00:00,2026-04-02 09:00:00,Coolblue,79.00,0.00,EUR,COMPLETED,1583.30",
      ],
    });
    const rows = await loadTxns(root);
    const by = (d: string) => rows.find((r) => r.date === d)!;
    expect(costOf(by("2026-01-07"))).toBe(0); // no purchase in range: not negative spending
    expect(by("2026-03-10").refunded).toBe(79);
    expect(costOf(by("2026-03-10"))).toBe(0); //  cancelled in March, the purchase's month
    expect(costOf(by("2026-04-02"))).toBe(0);
  });

  it("recognises one transaction across exports that write the amount differently", async () => {
    const en = `Card Payment,Current,2026-04-01 09:00:00,2026-04-01 09:00:00,LAPTOP SHOP,-1207.52,0.00,EUR,COMPLETED,2000.00`;
    const nl = `Card Payment,Current,2026-04-01 09:00:00,2026-04-01 09:00:00,LAPTOP SHOP,"-1.207,52","0,00",EUR,COMPLETED,"2.000,00"`;
    const rows = await loadTxns(vaultWith({ "en.csv": [HEADER, en], "nl.csv": [HEADER, nl] }));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount).toBe(-1207.52);
  });
});
