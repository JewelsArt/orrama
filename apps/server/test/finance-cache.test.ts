/**
 * Statements are parsed once per version of the file (audit FIN-015). Every
 * Dashboard load re-read and re-parsed every export synchronously — ~0.5 s for
 * /api/finance on five years of statements, on the event loop live sync uses —
 * and the Dashboard reloads on every note-changed event. The cache must never
 * serve a file that changed, a file that is gone, or rows marked for another
 * own-accounts list.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

process.env.ORRAMA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-fin-cache-"));
process.env.ORRAMA_VAULT_DIR = path.join(process.env.ORRAMA_DATA_DIR, "vault");
process.env.ORRAMA_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.ORRAMA_SECRET_KEY = "test-secret-key-0123456789abcdef";

const FILES = path.join(process.env.ORRAMA_VAULT_DIR, "02-Areas/finance/files");
const HEADER = "Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance";
const line = (date: string, what: string, amount: number, balance: number) =>
  `Card Payment,Current,${date} 10:00:00,${date} 10:00:00,${what},${amount.toFixed(2)},0.00,EUR,COMPLETED,${balance.toFixed(2)}`;
const months = (what: string, from: number, n: number) =>
  Array.from({ length: n }, (_, i) => line(`2026-${String(from + i).padStart(2, "0")}-05`, what, -100, 1000 - 100 * (i + 1)));

const { buildServer } = await import("../src/main.js");
const { loadStatements } = await import("../src/routes/finance.js");
const { monthlyByCategory } = await import("@orrama/core");
let app: Awaited<ReturnType<typeof buildServer>>["app"];
let token = "";
const get = async (url: string) => {
  const res = await app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
  expect(res.statusCode).toBe(200);
  return res.json();
};
/** The statement files read during `run`. */
async function readsDuring(run: () => Promise<unknown>): Promise<string[]> {
  const spy = vi.spyOn(fs.promises, "readFile");
  try {
    await run();
    return spy.mock.calls.map((c) => String(c[0])).filter((p) => p.startsWith(FILES)).map((p) => path.basename(p));
  } finally {
    spy.mockRestore();
  }
}

beforeAll(async () => {
  fs.mkdirSync(FILES, { recursive: true });
  fs.writeFileSync(path.join(FILES, "a.csv"), [HEADER, ...months("ALBERT HEIJN", 1, 4)].join("\n"));
  fs.writeFileSync(path.join(FILES, "b.csv"), [HEADER, ...months("JUMBO", 5, 4)].join("\n"));
  await import("../src/seed.js");
  app = (await buildServer()).app;
  token = (await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "jules@orrama.dev", password: "orrama-demo" } })).json().token;
});
afterAll(async () => {
  await app.close();
  fs.rmSync(process.env.ORRAMA_DATA_DIR!, { recursive: true, force: true });
});

describe("the statement cache (FIN-015)", () => {
  it("a second /api/home with no file changes reads no statement file", async () => {
    await get("/api/home");
    expect(await readsDuring(() => get("/api/home"))).toEqual([]);
    expect(await readsDuring(() => get("/api/finance"))).toEqual([]);
  });

  it("a changed file is read again, and only that file", async () => {
    const b = path.join(FILES, "b.csv");
    fs.writeFileSync(b, [HEADER, ...months("JUMBO", 5, 5)].join("\n"));
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(b, later, later);
    let d: { spending: { txnCount: number } } | undefined;
    expect(await readsDuring(async () => (d = await get("/api/finance")))).toEqual(["b.csv"]);
    expect(d!.spending.txnCount).toBe(9);
  });

  it("a file that is gone takes its rows with it", async () => {
    fs.rmSync(path.join(FILES, "b.csv"));
    expect((await get("/api/finance")).spending.txnCount).toBe(4);
  });

  it("a different own-accounts list is never served the other list's rows", async () => {
    const root = process.env.ORRAMA_VAULT_DIR!;
    const plain = await loadStatements(root, []);
    const owned = await loadStatements(root, [{ account: "Groceries pot", matches: ["albert heijn"] }]);
    expect(plain.txns.every((r) => !r.own)).toBe(true);
    expect(owned.txns.every((r) => r.own === "Groceries pot")).toBe(true);
    expect((await loadStatements(root, [])).txns.every((r) => !r.own)).toBe(true);
  });
});

describe("classifying rows folds each term once per rules set (FIN-015)", () => {
  it("not once per row per term", async () => {
    const rules = Array.from({ length: 30 }, (_, i) => ({ category: `Cat${i}`, matches: [`merchant ${i}a`, `merchant ${i}b`, `shop ${i}`], colour: null }));
    const rows = Array.from({ length: 1000 }, (_, i) => ({
      date: `2026-0${(i % 9) + 1}-10`,
      description: `MERCHANT ${i % 40}A`,
      amount: -10,
      fee: 0,
      flow: "spend" as const,
      type: "Card Payment",
      balance: null,
      currency: "EUR",
      product: "Current",
      at: "",
      key: String(i),
    }));
    const normalize = vi.spyOn(String.prototype, "normalize");
    try {
      monthlyByCategory(rows, rules);
      // 90 terms folded once, and each of the 40 descriptions once — not 90 × 1000.
      expect(normalize.mock.calls.length).toBeLessThan(500);
    } finally {
      normalize.mockRestore();
    }
  });
});
