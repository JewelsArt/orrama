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
        "| Service | Amount | Every | Next |",
        "|---|---|---|---|",
        "| Rent | 600 | monthly | 2026-10-01 |",
        "| Car insurance | 300 | half-yearly | 2027-01-01 |",
        "| Club | 60 | every so often | 2026-10-05 |",
        "| Gym | €29.99 / 12 months | monthly | |",
      ].join("\n"),
    ),
  );
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
    expect(d.subscriptions.items.map((s: { service: string }) => s.service)).toEqual(["Rent", "Car insurance"]);
    expect(d.subscriptions.totals).toEqual([{ currency: "EUR", monthly: 650 }]);
    // Line numbers are the file as it is on disk, its stamped `id:` included.
    expect(d.subscriptions.unreadable).toEqual([
      { service: "Club", line: 12, field: "cadence", text: "every so often" },
      { service: "Gym", line: 13, field: "amount", text: "€29.99 / 12 months" },
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
