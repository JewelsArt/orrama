/**
 * A #vault-categories note holding a catastrophic-backtracking /regex/ cannot
 * stall the tree (audit INP-003). The pattern used to be run by RegExp
 * against every note's path and tags on each GET /api/vault/tree; on a
 * 40-character path it ran for minutes and the whole server stopped
 * answering. The rule still applies where it matches.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { sessionOf, signedIn } from "./helpers/session.js";

process.env.ORRAMA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-cat-redos-"));
process.env.ORRAMA_VAULT_DIR = path.join(process.env.ORRAMA_DATA_DIR, "vault");
process.env.ORRAMA_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.ORRAMA_SECRET_KEY = "test-secret-key-0123456789abcdef";

const VAULT = process.env.ORRAMA_VAULT_DIR;
fs.mkdirSync(path.join(VAULT, "Shared/Journal/2026/October/Week 41"), { recursive: true });
fs.writeFileSync(
  path.join(VAULT, "Shared/Vault categories.md"),
  "---\ntags: [vault-categories]\n---\n| Category | Matches |\n| --- | --- |\n| School | /^([^~]+)+~/, /(\\w+\\s?)+$/, /resit~/ |\n",
);
for (let i = 0; i < 60; i++) {
  fs.writeFileSync(path.join(VAULT, `Shared/Journal/2026/October/Week 41/2026-10-${String(i).padStart(2, "0")} daily note with a long name.md`), `# Day ${i}\n`);
}
fs.writeFileSync(path.join(VAULT, "Shared/resit~plan.md"), "# Resit\n");
await import("../src/seed.js");
const { buildServer } = await import("../src/main.js");

let b: Awaited<ReturnType<typeof buildServer>>;
let token = "";
beforeAll(async () => {
  b = await buildServer();
  token = sessionOf(await b.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "jules@orrama.dev", password: "orrama-demo" } }));
});
afterAll(async () => {
  await b.app.close();
  fs.rmSync(process.env.ORRAMA_DATA_DIR!, { recursive: true, force: true });
});

it("the tree answers promptly, and the rules still categorise", async () => {
  const t = performance.now();
  const res = await b.app.inject({ method: "GET", url: "/api/vault/tree", headers: signedIn(token) });
  expect(performance.now() - t).toBeLessThan(3000);
  expect(res.statusCode).toBe(200);
  const cat = new Map((res.json() as { path: string; category: string }[]).map((n) => [n.path, n.category]));
  // /(\w+\s?)+$/ matches any path ending in a word character: every note here is School.
  expect(cat.get("Shared/Journal/2026/October/Week 41/2026-10-00 daily note with a long name.md")).toBe("school");
  expect(cat.get("Shared/resit~plan.md")).toBe("school");
});
