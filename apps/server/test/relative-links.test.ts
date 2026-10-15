/**
 * The note view and the map follow a markdown link written relative to its
 * note, and a composed link to a decomposed name (audit COR-016; the rule is
 * VaultIndex.resolveLinkOf, packages/core/test/link-resolution.test.ts).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";

process.env.ORRAMA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "basalt-relative-links-"));
process.env.ORRAMA_VAULT_DIR = path.join(process.env.ORRAMA_DATA_DIR, "vault");
process.env.ORRAMA_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.ORRAMA_SECRET_KEY = "test-secret-key-0123456789abcdef";

const VAULT = process.env.ORRAMA_VAULT_DIR;
fs.mkdirSync(path.join(VAULT, "Shared/Thesis/sub"), { recursive: true });
fs.writeFileSync(path.join(VAULT, "Shared/Thesis/Plan.md"), "# Plan\n\n[up](../Up.md) and [child](sub/Child.md) and [[R\u00e9sum\u00e9]]\n");
fs.writeFileSync(path.join(VAULT, "Shared/Up.md"), "# Up\n");
fs.writeFileSync(path.join(VAULT, "Shared/Thesis/sub/Child.md"), "# Child\n");
fs.writeFileSync(path.join(VAULT, "Shared/Re\u0301sume\u0301.md"), "# CV\n");
await import("../src/seed.js");
const { buildServer } = await import("../src/main.js");

let b: Awaited<ReturnType<typeof buildServer>>;
let token = "";
const get = async (url: string) => (await b.app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } })).json();
const idOf = (p: string) => b.store.index.all().find((n) => n.path.normalize("NFC") === p.normalize("NFC"))!.id;

beforeAll(async () => {
  b = await buildServer();
  token = (await b.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "jules@basalt.dev", password: "basalt-demo" } })).json().token;
});
afterAll(async () => {
  await b.app.close();
  fs.rmSync(process.env.ORRAMA_DATA_DIR!, { recursive: true, force: true });
});

it("the note's links point at the notes they name", async () => {
  const note = await get(`/api/vault/note/${idOf("Shared/Thesis/Plan.md")}`);
  const targets = (note.links as { raw: string; targetId: string | null }[]).map((l) => l.targetId).sort();
  expect(targets).toEqual([idOf("Shared/Up.md"), idOf("Shared/Thesis/sub/Child.md"), idOf("Shared/R\u00e9sum\u00e9.md")].sort());
});

it("the map draws those edges, and the targets list the backlink", async () => {
  const plan = idOf("Shared/Thesis/Plan.md");
  const { edges } = await get("/api/vault/graph");
  const from = (edges as { from: string; to: string }[]).filter((e) => e.from === plan).map((e) => e.to).sort();
  expect(from).toEqual([idOf("Shared/Up.md"), idOf("Shared/Thesis/sub/Child.md"), idOf("Shared/R\u00e9sum\u00e9.md")].sort());
  const up = await get(`/api/vault/note/${idOf("Shared/Up.md")}`);
  expect((up.backlinks as { fromId: string }[]).map((x) => x.fromId)).toEqual([plan]);
});
