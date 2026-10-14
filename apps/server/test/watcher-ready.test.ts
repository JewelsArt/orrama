/**
 * An edit made the moment the server has booted is indexed. load() returns
 * while chokidar is still attaching to the vault's folders, and a file
 * written in that gap raises no event at all — the note stayed stale until
 * its next change. buildServer() used to return inside the gap. For a while
 * nothing showed it: seed.ts leaked a second watcher into every test process,
 * and chokidar shares fs.watch handles within a process, so the leaked one
 * covered it; without it, calendar-notes.test.ts failed 4 runs in 5 when run
 * beside another file.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, it } from "vitest";

process.env.BASALT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "basalt-watch-ready-"));
process.env.BASALT_VAULT_DIR = path.join(process.env.BASALT_DATA_DIR, "vault");
process.env.BASALT_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.BASALT_SECRET_KEY = "test-secret-key-0123456789abcdef";

const vault = process.env.BASALT_VAULT_DIR;
const folders = ["Deep", "Deep/er", "Deep/er/still", "Wide/a", "Wide/b", "Wide/c"];
for (const f of folders) {
  fs.mkdirSync(path.join(vault, f), { recursive: true });
  fs.writeFileSync(path.join(vault, f, "n.md"), `# ${f}\n`);
}
const { buildServer } = await import("../src/main.js");
const { createDb } = await import("../src/db.js");
const { closeDb } = await import("./helpers/db.js");
const { VaultStore } = await import("../src/vaultStore.js");

afterAll(() => fs.rmSync(process.env.BASALT_DATA_DIR!, { recursive: true, force: true }));

const settled = async (p: Promise<void>) => Promise.race([p.then(() => "settled"), Promise.resolve().then(() => "pending")]);

it("store.watching settles once every folder of the vault is watched", async () => {
  const db = createDb();
  const store = new VaultStore(db);
  store.load();
  await store.watching;
  try {
    const watcher = (store as unknown as { watcher: { getWatched(): Record<string, string[]> } }).watcher;
    const watched = Object.keys(watcher.getWatched()).map((d) => path.relative(vault, d).split(path.sep).join("/"));
    for (const f of folders) expect(watched).toContain(f);
  } finally {
    await store.close();
    closeDb(db);
  }
});

it("buildServer returns only once the watcher is attached", async () => {
  const { app, store } = await buildServer();
  try {
    expect(await settled(store.watching)).toBe("settled");
  } finally {
    await app.close();
  }
});
