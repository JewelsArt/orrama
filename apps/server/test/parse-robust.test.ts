/**
 * A note whose markdown link holds a stray `%` is a note like any other: it is
 * indexed at boot, its tasks are on /api/tasks, and Orrama can save it (audit
 * COR-002 — parseNote threw URIError, the note was skipped at boot and every
 * save answered 500). The parser half is packages/core/test/parse-robust.test.ts.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";

process.env.ORRAMA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-parse-robust-"));
process.env.ORRAMA_VAULT_DIR = path.join(process.env.ORRAMA_DATA_DIR, "vault");
process.env.ORRAMA_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.ORRAMA_SECRET_KEY = "test-secret-key-0123456789abcdef";

const VAULT = process.env.ORRAMA_VAULT_DIR;
fs.mkdirSync(path.join(VAULT, "Shared"), { recursive: true });
fs.writeFileSync(path.join(VAULT, "Shared/Budget.md"), "# Budget\n\n- [ ] pay rent due:2026-10-05\n\nSavings ![chart](growth%.png)\n");
await import("../src/seed.js");
const { buildServer } = await import("../src/main.js");

let b: Awaited<ReturnType<typeof buildServer>>;
let token = "";
const auth = () => ({ authorization: `Bearer ${token}` });

beforeAll(async () => {
  b = await buildServer();
  token = (await b.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "jules@orrama.dev", password: "orrama-demo" } })).json().token;
});
afterAll(async () => {
  await b.app.close();
  fs.rmSync(process.env.ORRAMA_DATA_DIR!, { recursive: true, force: true });
});

it("is indexed at boot, with its tasks", async () => {
  expect(b.store.index.getByPath("Shared/Budget.md")).toBeDefined();
  const tasks = (await b.app.inject({ method: "GET", url: "/api/tasks", headers: auth() })).json() as { text: string }[];
  expect(tasks.map((t) => t.text)).toContain("pay rent");
});

it("saves when it gains such a link in Orrama", async () => {
  const res = await b.app.inject({
    method: "PUT",
    url: "/api/vault/note",
    headers: auth(),
    payload: { path: "Shared/Deals.md", content: "# Deals\n\n[deal](www.shop.com/50%off) and [plan](<Budget 100% final.md>)\n" },
  });
  expect(res.statusCode).toBe(200);
  expect(b.store.index.getByPath("Shared/Deals.md")!.links.map((l) => l.target)).toEqual(["Budget 100% final"]);
});
