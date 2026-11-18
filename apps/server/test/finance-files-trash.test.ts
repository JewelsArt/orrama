/**
 * Money → Documents: a statement or payslip goes to the trash (2L, stage 1's leftover:
 * `VaultStore.trashFile` was ready and not wired). Its figures leave every total, Undo (a
 * restore from the trash) brings them back, a payslip's row stays in the payslips list, and
 * only someone who can change the finance files may do it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileTrashedResponse } from "@orrama/schema/responses";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessionOf, signedIn } from "./helpers/session.js";

process.env.ORRAMA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-fin-trash-"));
process.env.ORRAMA_VAULT_DIR = path.join(process.env.ORRAMA_DATA_DIR, "vault");
process.env.ORRAMA_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.ORRAMA_SECRET_KEY = "test-secret-key-0123456789abcdef";

const FILES = path.join(process.env.ORRAMA_VAULT_DIR, "02-Areas", "finance", "files");
const { buildServer } = await import("../src/main.js");
let app: Awaited<ReturnType<typeof buildServer>>["app"];
const token: Record<string, string> = {};
const call = async (who: string, method: string, url: string, payload?: object) => {
  const r = await app.inject({ method: method as "GET", url, headers: signedIn(token[who]!), ...(payload && { payload }) });
  const json = (r.headers["content-type"] ?? "").toString().includes("json");
  return { status: r.statusCode, body: json && r.body ? r.json() : r.body };
};
const finance = async () => (await call("jules", "GET", "/api/finance")).body as { spending: { txnCount: number }; files: { name: string }[]; payslips: { month: string }[] };

const HEADER = "Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance";
const STATEMENT = [HEADER, ...[10, 12, 14].map((d, i) => `Card Payment,Current,2026-06-${d} 10:00:00,2026-06-${d} 10:00:00,ALBERT HEIJN,-${20 + i}.00,0.00,EUR,COMPLETED,${900 - 20 * i}.00`)].join("\n");

beforeAll(async () => {
  fs.mkdirSync(FILES, { recursive: true });
  fs.writeFileSync(path.join(FILES, "june.csv"), STATEMENT);
  fs.writeFileSync(path.join(FILES, "slip-2026-05.pdf"), "%PDF-1.4 not really");
  fs.writeFileSync(path.join(FILES, "notes.txt"), "a file someone dropped here");
  fs.writeFileSync(
    path.join(process.env.ORRAMA_VAULT_DIR!, "02-Areas", "finance", "Payslips.md"),
    "---\ntags: [payslips]\n---\n# Payslips\n\n| Month | Gross | Net | File |\n| --- | --- | --- | --- |\n| 2026-05 | 3000 | 2200 | slip-2026-05.pdf |\n",
  );
  await import("../src/seed.js");
  app = (await buildServer()).app;
  for (const who of ["jules", "mara"]) {
    token[who] = sessionOf(await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: `${who}@orrama.dev`, password: "orrama-demo" } }));
  }
});
afterAll(async () => {
  await app.close();
  fs.rmSync(process.env.ORRAMA_DATA_DIR!, { recursive: true, force: true });
});

describe("DELETE /api/finance/files/:name", () => {
  it("puts a statement in the trash; its rows leave the figures, and the restore brings them back", async () => {
    expect((await finance()).spending.txnCount).toBe(3);
    const gone = await call("jules", "DELETE", "/api/finance/files/june.csv");
    expect(gone.status).toBe(200);
    const said = fileTrashedResponse.parse(gone.body);
    expect(said.trashPath).toBe(".trash/02-Areas/finance/files/june.csv");
    expect(fs.existsSync(path.join(FILES, "june.csv"))).toBe(false);
    const now = await finance();
    expect(now.spending.txnCount).toBe(0);
    expect(now.files.map((f) => f.name)).not.toContain("june.csv");

    // Notes → Trash lists it, and Undo is that list's restore.
    const trash = (await call("jules", "GET", "/api/vault/trash")).body as { path: string }[];
    expect(trash.map((t) => t.path)).toContain(said.trashPath);
    expect((await call("jules", "POST", "/api/vault/trash/restore", { path: said.trashPath })).status).toBe(200);
    expect((await finance()).spending.txnCount).toBe(3);
  });

  it("a payslip's file goes, its row in the payslips list stays", async () => {
    expect((await finance()).payslips.map((p) => p.month)).toContain("2026-05");
    expect((await call("jules", "DELETE", "/api/finance/files/slip-2026-05.pdf")).status).toBe(200);
    const now = await finance();
    expect(now.files.map((f) => f.name)).not.toContain("slip-2026-05.pdf");
    expect(now.payslips.map((p) => p.month)).toContain("2026-05");
  });

  it("any file the Documents page lists can go, not only the kinds an upload takes", async () => {
    expect((await finance()).files.map((f) => f.name)).toContain("notes.txt");
    expect((await call("jules", "DELETE", "/api/finance/files/notes.txt")).status).toBe(200);
    expect(fs.existsSync(path.join(FILES, "notes.txt"))).toBe(false);
  });

  it("needs edit on the finance files: a viewer reads them and cannot delete one", async () => {
    expect((await call("mara", "GET", "/api/finance/files/june.csv")).status).toBe(200);
    expect((await call("mara", "DELETE", "/api/finance/files/june.csv")).status).toBe(403);
    expect(fs.existsSync(path.join(FILES, "june.csv"))).toBe(true);
  });

  it("refuses a name that leaves the folder, and answers 404 for one that isn't there", async () => {
    expect((await call("jules", "DELETE", `/api/finance/files/${encodeURIComponent("../Payslips.md")}`)).status).toBe(400);
    expect((await call("jules", "DELETE", "/api/finance/files/.hidden.csv")).status).toBe(400);
    expect((await call("jules", "DELETE", "/api/finance/files/nothing.csv")).status).toBe(404);
    expect(fs.existsSync(path.join(process.env.ORRAMA_VAULT_DIR!, "02-Areas", "finance", "Payslips.md"))).toBe(true);
  });
});
