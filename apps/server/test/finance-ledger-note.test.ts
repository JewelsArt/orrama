/**
 * Which note is a finance ledger (audit ACL-011). Every finance singleton —
 * #subscriptions, #income, #payslips, #spending-categories, #own-accounts,
 * the #finance area note — was "the first readable note with the tag", in
 * index order. A save moves its note to the end of that order, so with two
 * tagged notes rows landed alternately in each; and any READABLE note
 * qualified, so the owner's new rows could land in a note another account
 * keeps in its own folder.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.ORRAMA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-fin-ledger-note-"));
process.env.ORRAMA_VAULT_DIR = path.join(process.env.ORRAMA_DATA_DIR, "vault");
process.env.ORRAMA_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.ORRAMA_SECRET_KEY = "test-secret-key-0123456789abcdef";

const VAULT = process.env.ORRAMA_VAULT_DIR;
const TABLE = "| Service | Amount | Every | Next |\n|---|---|---|---|";
/** A note with a fixed id, so "the note made first" is known. */
const write = (rel: string, id: string, tag: string, body: string, extra = "") => {
  fs.mkdirSync(path.dirname(path.join(VAULT, rel)), { recursive: true });
  fs.writeFileSync(path.join(VAULT, rel), `---\nid: ${id}\ntitle: ${path.basename(rel, ".md")}\n${extra}tags:\n  - ${tag}\n---\n\n${body}\n`);
};
const read = (rel: string) => fs.readFileSync(path.join(VAULT, rel), "utf8");

const { buildServer } = await import("../src/main.js");
let app: Awaited<ReturnType<typeof buildServer>>["app"];
const tokens: Record<string, string> = {};
const call = (who: string, method: "GET" | "POST", url: string, payload?: object) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${tokens[who]}` }, payload });
const get = async (who: string, url: string) => {
  const res = await call(who, "GET", url);
  expect(res.statusCode).toBe(200);
  return res.json();
};

beforeAll(async () => {
  // The owner's ledger, where the docs say it lives — the NEWEST of them all.
  write("02-Areas/finance/Subscriptions.md", "n-zzzzzzzzzz01", "subscriptions", `${TABLE}\n| Rent | 600 | monthly | 2026-10-01 |`);
  // An old archived copy, made first: the oldest id, but not in the finance area.
  write("Archive/subs-2025.md", "n-0000000000a1", "subscriptions", `${TABLE}\n| Old gym | 20 | monthly | |`);
  // Mara's own note in her team's folder, and Erin's in her personal folder.
  write("Marketing/subs.md", "n-0000000000b1", "subscriptions", `${TABLE}\n| Netflix | 9 | monthly | 2026-10-10 |`);
  write("Personal/erin/subs.md", "n-0000000000c1", "subscriptions", `${TABLE}\n| Erin's phone | 15 | monthly | |`);
  // The area note, and an older note that happens to carry #finance too.
  write("00-Inbox/resit-ifa.md", "n-0000000000d1", "finance", "Notes for the resit.", "balance: 9\n");
  write("02-Areas/finance.md", "n-zzzzzzzzzz02", "finance", "# Finance", "balance: 1.234,56\n");
  await import("../src/seed.js");
  app = (await buildServer()).app;
  for (const who of ["jules", "mara"]) {
    tokens[who] = (
      await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: `${who}@orrama.dev`, password: "orrama-demo" } })
    ).json().token;
  }
});
afterAll(async () => {
  await app.close();
  fs.rmSync(process.env.ORRAMA_DATA_DIR!, { recursive: true, force: true });
});

describe("the ledger note is one fixed note (ACL-011)", () => {
  it("ten consecutive adds all land in the same note, and /api/home reads that note", async () => {
    const paths = new Set<string>();
    for (let i = 1; i <= 10; i++) {
      const res = await call("jules", "POST", "/api/finance/subscriptions", { service: `Line ${i}`, amount: "1", cadence: "monthly" });
      expect(res.statusCode).toBe(200);
      paths.add(res.json().path);
    }
    expect([...paths]).toEqual(["02-Areas/finance/Subscriptions.md"]);
    const home = await get("jules", "/api/home");
    expect(home.finance.out.noteId).toBe("n-zzzzzzzzzz01");
    expect(home.finance.out.count).toBe(11);
    expect(home.finance.out.totals).toEqual([{ currency: "EUR", monthly: 610 }]);
  });

  it("another account's note never becomes the owner's ledger, and gets none of his rows", async () => {
    const d = await get("jules", "/api/finance");
    expect(d.subscriptions.items.map((s: { service: string }) => s.service)).not.toContain("Netflix");
    expect(d.subscriptions.items.map((s: { service: string }) => s.service)).not.toContain("Erin's phone");
    expect(read("Marketing/subs.md")).not.toContain("Line");
    expect(read("Personal/erin/subs.md")).not.toContain("Line");
    expect(read("Archive/subs-2025.md")).not.toContain("Line");
  });

  it("an editor's ledger is a note they can edit, never the owner's", async () => {
    const res = await call("mara", "POST", "/api/finance/subscriptions", { service: "Canva", amount: "12", cadence: "monthly" });
    expect(res.statusCode).toBe(200);
    expect(res.json().path).toBe("Marketing/subs.md");
    expect(read("02-Areas/finance/Subscriptions.md")).not.toContain("Canva");
  });

  it("says which notes carry the same ledger tag, and which one is used", async () => {
    const d = await get("jules", "/api/finance");
    expect(d.ledgerConflicts).toEqual([
      { tag: "subscriptions", using: "02-Areas/finance/Subscriptions.md", others: ["Archive/subs-2025.md", "Marketing/subs.md"] },
    ]);
  });

  it("the area note is 02-Areas/finance.md, not an older note that also says #finance", async () => {
    const d = await get("jules", "/api/finance");
    expect(d.notes.area).toBe("n-zzzzzzzzzz02");
    expect(d.summary.balance).toBe(1234.56);
  });
});
