/**
 * The ledgers on a calendar (audit FIN-003). Planning's dated band and the
 * Finance ledger calendar both expand one `next` date across a range, and
 * both used to chain single steps: rent due on the 31st was drawn on the 30th
 * from October and on the 28th from March, and the band only walked forward
 * from `next`, so a range before it showed nothing at all.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.ORRAMA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-fin-calendar-"));
process.env.ORRAMA_VAULT_DIR = path.join(process.env.ORRAMA_DATA_DIR, "vault");
process.env.ORRAMA_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.ORRAMA_SECRET_KEY = "test-secret-key-0123456789abcdef";

const FIN = path.join(process.env.ORRAMA_VAULT_DIR, "02-Areas/finance");
const note = (title: string, tag: string, body: string) => `---\ntitle: ${title}\ntags:\n  - ${tag}\n---\n\n${body}\n`;

const { buildServer } = await import("../src/main.js");
let app: Awaited<ReturnType<typeof buildServer>>["app"];
let token = "";
const charges = async (from: string, to: string) => {
  const res = await app.inject({ method: "GET", url: `/api/calendar/markers?from=${from}&to=${to}`, headers: { authorization: `Bearer ${token}` } });
  expect(res.statusCode).toBe(200);
  return (res.json() as { kind: string; title: string; date: string }[])
    .filter((m) => m.kind === "charge" || m.kind === "income")
    .map((m) => `${m.title}@${m.date}`);
};

beforeAll(async () => {
  fs.mkdirSync(FIN, { recursive: true });
  fs.writeFileSync(
    path.join(FIN, "subscriptions.md"),
    note(
      "Subscriptions",
      "subscriptions",
      "| Service | Amount | Every | Next |\n|---|---|---|---|\n| Rent | 609 | monthly | 2026-08-31 |\n| Insurance | 120 | quarterly | 2026-08-31 |\n| Gym | 12 | weekly | 2026-10-05 |",
    ),
  );
  fs.writeFileSync(path.join(FIN, "income.md"), note("Income", "income", "| Source | Amount | Every | Next |\n|---|---|---|---|\n| Salary | 1800 | monthly | 2026-11-01 |"));
  await import("../src/seed.js");
  app = (await buildServer()).app;
  token = (await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "jules@orrama.dev", password: "orrama-demo" } })).json().token;
});
afterAll(async () => {
  await app.close();
  fs.rmSync(process.env.ORRAMA_DATA_DIR!, { recursive: true, force: true });
});

describe("Planning's charge band (FIN-003)", () => {
  it("puts a 31st-anchored line on the 31st of October and of March", async () => {
    const all = await charges("2026-09-01", "2027-03-31");
    const rent = all.filter((c) => c.startsWith("Rent@"));
    expect(rent).toEqual([
      "Rent@2026-09-30",
      "Rent@2026-10-31",
      "Rent@2026-11-30",
      "Rent@2026-12-31",
      "Rent@2027-01-31",
      "Rent@2027-02-28",
      "Rent@2027-03-31",
    ]);
    expect(all.filter((c) => c.startsWith("Insurance@"))).toEqual(["Insurance@2026-11-30", "Insurance@2027-02-28"]);
  });

  it("shows the charges in a range before the note's next date", async () => {
    const sept = await charges("2026-08-31", "2026-10-04");
    expect(sept).toContain("Gym@2026-09-28");
    expect(sept).toContain("Salary@2026-10-01");
    expect(sept).toContain("Salary@2026-09-01");
  });
});

describe("the Finance ledger calendar keeps no date arithmetic of its own (FIN-003)", () => {
  it("reads chargeDates from core instead of stepping dates itself", () => {
    // Money's screen is Finance.tsx and its pages in money/ (R10); the calendar is among them.
    const web = path.join(__dirname, "../../web/src");
    const files = ["Finance.tsx", ...fs.readdirSync(path.join(web, "money")).filter((f) => /\.tsx?$/.test(f) && !/\.test\./.test(f)).map((f) => `money/${f}`)];
    const src = files.map((f) => fs.readFileSync(path.join(web, f), "utf8")).join("\n");
    expect(src).toMatch(/import \{[^}]*\bchargeDates\b[^}]*\} from "@orrama\/core\/subscriptions"/);
    expect(src).not.toMatch(/setUTC(Date|Month|FullYear)\(/);
  });
});
