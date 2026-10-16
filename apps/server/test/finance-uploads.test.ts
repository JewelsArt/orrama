/**
 * Statement uploads say what they added, or why they add nothing (audit
 * FIN-007). An .xlsx statement, or a Revolut CSV re-saved by Excel under a
 * Dutch locale, used to be stored, listed among the documents and ignored by
 * every total — and every statement, read or not, got the same flash:
 * "Stored X, but the figures were not filed — unknown reason".
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessionOf, signedIn } from "./helpers/session.js";

process.env.ORRAMA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-fin-uploads-"));
process.env.ORRAMA_VAULT_DIR = path.join(process.env.ORRAMA_DATA_DIR, "vault");
process.env.ORRAMA_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.ORRAMA_SECRET_KEY = "test-secret-key-0123456789abcdef";

const { buildServer } = await import("../src/main.js");
let app: Awaited<ReturnType<typeof buildServer>>["app"];
let token = "";
const upload = async (name: string, data: Buffer | string) => {
  const res = await app.inject({
    method: "POST",
    url: "/api/finance/payslip",
    headers: signedIn(token),
    payload: { name, dataBase64: Buffer.from(data).toString("base64") },
  });
  expect(res.statusCode).toBe(200);
  return res.json();
};
const finance = async () =>
  (await app.inject({ method: "GET", url: "/api/finance", headers: signedIn(token) })).json();

const HEADER = ["Type", "Product", "Started Date", "Completed Date", "Description", "Amount", "Fee", "Currency", "State", "Balance"];
/** Five Revolut rows in one month, as cells. */
const rows = (month: string, currency = "EUR") =>
  [10, 12, 14, 16, 18].map((day, i) => {
    const at = `${month}-${day} 10:00:00`;
    return ["Card Payment", "Current", at, at, "ALBERT HEIJN", -(20 + i), 0, currency, "COMPLETED", 1000 - 20 * (i + 1)];
  });
const csv = (body: (string | number)[][], sep = ",", decimal = ".") =>
  [HEADER, ...body].map((r) => r.map((c) => (typeof c === "number" ? c.toFixed(2).replace(".", decimal) : c)).join(sep)).join("\n");

beforeAll(async () => {
  fs.mkdirSync(process.env.ORRAMA_VAULT_DIR!, { recursive: true });
  await import("../src/seed.js");
  app = (await buildServer()).app;
  token = sessionOf(await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "jules@orrama.dev", password: "orrama-demo" } }));
});
afterAll(async () => {
  await app.close();
  fs.rmSync(process.env.ORRAMA_DATA_DIR!, { recursive: true, force: true });
});

describe("a statement upload (FIN-007)", () => {
  it("a readable CSV reports the rows it added, not 'unknown reason'", async () => {
    const res = await upload("revolut-june.csv", csv(rows("2026-06")));
    expect(res.statement).toMatchObject({ rows: 5, skipped: 0, first: "2026-06-10", last: "2026-06-18", reason: null });
    expect((await finance()).spending.txnCount).toBe(5);
  });

  it("a CSV Excel saved with semicolons and decimal commas is read", async () => {
    const res = await upload("revolut-july-excel.csv", csv(rows("2026-07"), ";", ","));
    expect(res.statement).toMatchObject({ rows: 5, reason: null });
    expect((await finance()).spending.txnCount).toBe(10);
  });

  it("an .xlsx statement is read, dates and numbers as the workbook holds them", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Statement");
    ws.addRow(["Account statement"]); // a title above the header
    ws.addRow(HEADER);
    for (const r of rows("2026-08")) {
      const at = new Date(`${String(r[2]).replace(" ", "T")}Z`);
      ws.addRow([r[0], r[1], at, at, r[4], r[5], r[6], r[7], r[8], r[9]]);
    }
    const res = await upload("revolut-august.xlsx", Buffer.from(await wb.xlsx.writeBuffer()));
    expect(res.statement).toMatchObject({ rows: 5, first: "2026-08-10", last: "2026-08-18", reason: null });
    const d = await finance();
    expect(d.spending.txnCount).toBe(15);
    expect(d.spending.months.map((m: { month: string }) => m.month)).toEqual(["2026-06", "2026-07", "2026-08"]);
  });

  it("a file it cannot read says why, and is counted on the page", async () => {
    const res = await upload("bank-export.csv", "Datum;Omschrijving;Bedrag\n2026-09-01;AH;-3,00");
    expect(res.statement).toMatchObject({ rows: 0, reason: "its header has no Amount column" });
    const d = await finance();
    expect(d.spending.txnCount).toBe(15);
    expect(d.spending.excluded).toEqual([{ name: "bank-export.csv", reason: "its header has no Amount column" }]);
  });

  it("a statement in another currency says it is left out", async () => {
    const res = await upload("usd-pocket.csv", csv(rows("2026-09", "USD")));
    expect(res.statement.reason).toBe("it is in USD, and the statements are read in EUR");
    expect((await finance()).spending.excluded.map((f: { name: string }) => f.name)).toEqual(["bank-export.csv", "usd-pocket.csv"]);
  });

  it("a statement kept beside one of the same name reports its own rows (STO-006 with FIN-007)", async () => {
    const res = await upload("revolut-june.csv", csv(rows("2026-05")));
    expect(res).toMatchObject({ name: "revolut-june (2).csv", stored: true });
    expect(res.statement).toMatchObject({ name: "revolut-june (2).csv", rows: 5, first: "2026-05-10", last: "2026-05-18", reason: null });
  });
});
