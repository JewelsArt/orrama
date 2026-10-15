/**
 * A note Basalt creates and something outside deletes a moment later leaves
 * the index. The create (our atomic rename) and the delete can reach chokidar
 * as one coalesced fs event; by the time chokidar looks the file is gone, so
 * it reported neither "add" nor "unlink" and the note stayed listed — seen
 * when a test deleted a calendar note right after Basalt wrote it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";

process.env.ORRAMA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "basalt-vanishing-"));
process.env.ORRAMA_VAULT_DIR = path.join(process.env.ORRAMA_DATA_DIR, "vault");
process.env.ORRAMA_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.ORRAMA_SECRET_KEY = "test-secret-key-0123456789abcdef";

const vault = process.env.ORRAMA_VAULT_DIR;
const { buildServer } = await import("../src/main.js");
let b: Awaited<ReturnType<typeof buildServer>>;
let token = "";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 60 && !ok(); i++) await sleep(50);
};

beforeAll(async () => {
  fs.mkdirSync(vault, { recursive: true });
  await import("../src/seed.js");
  b = await buildServer();
  token = (await b.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "jules@basalt.dev", password: "basalt-demo" } })).json().token;
});
afterAll(async () => {
  await b.app.close();
  fs.rmSync(process.env.ORRAMA_DATA_DIR!, { recursive: true, force: true });
});

it("a note written by Basalt and deleted at once outside it leaves the index", async () => {
  const rels = [0, 1, 2, 3, 4].map((i) => `Shared/Fleeting ${i}.md`);
  for (const rel of rels) {
    const put = await b.app.inject({ method: "PUT", url: "/api/vault/note", headers: { authorization: `Bearer ${token}` }, payload: { path: rel, content: "# Fleeting\n" } });
    expect(put.statusCode).toBe(200);
    expect(b.store.index.getByPath(rel)).toBeDefined();
    fs.rmSync(path.join(vault, rel)); // in the same breath
    await sleep(150);
  }
  await until(() => rels.every((rel) => !b.store.index.getByPath(rel)));
  expect(rels.filter((rel) => b.store.index.getByPath(rel))).toEqual([]);
  const tree = (await b.app.inject({ method: "GET", url: "/api/vault/tree", headers: { authorization: `Bearer ${token}` } })).json() as { path: string }[];
  expect(tree.filter((n) => n.path.startsWith("Shared/Fleeting"))).toEqual([]);
}, 20_000);

it("an add or change that settles after the file is gone counts as its unlink", async () => {
  const rel = "Shared/Gone before settling.md";
  await b.app.inject({ method: "PUT", url: "/api/vault/note", headers: { authorization: `Bearer ${token}` }, payload: { path: rel, content: "# Gone\n" } });
  await sleep(500); // let the write's own events settle first
  const id = b.store.index.getByPath(rel)!.id;
  const removed: string[] = [];
  b.store.events.on("note-removed", (e: { noteId: string }) => removed.push(e.noteId));
  fs.rmSync(path.join(vault, rel));
  // What the debounce does when chokidar's last word on the path was "add".
  (b.store as unknown as { handleExternalChange(e: string, r: string, a: string): void }).handleExternalChange("add", rel, path.join(vault, rel));
  expect(b.store.index.getByPath(rel)).toBeUndefined();
  expect(removed).toContain(id);
});
