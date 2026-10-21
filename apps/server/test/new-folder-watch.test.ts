/**
 * A note created together with its new folder is indexed. chokidar 5 reads a
 * new folder first and attaches fs.watch to it only once the read is done
 * (`_handleDir` in its handler.js), so a file that lands between the two
 * raises no event — the note stayed out of the index until something else in
 * that folder changed, or the server restarted. The store now reads the vault
 * again a moment after any folder appears (VaultStore.reconcileLater).
 *
 * The gap is microseconds wide, so the test opens it on purpose: `fs.watch` is
 * wrapped to write into a "Gap…" folder just before chokidar attaches to it.
 * And it makes the watch behave like Linux's inotify, which reports nothing
 * from before it was attached: macOS FSEvents delivers events from just
 * before, and those would hide the miss on this machine. The wrapper drops
 * events, in the first moments, for names already in the folder at attach
 * time — any event at all makes chokidar re-read the folder, which is the
 * real-world rescue only when something else happens to change there.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { afterAll, beforeAll, expect, it } from "vitest";

process.env.ORRAMA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-new-folder-"));
process.env.ORRAMA_VAULT_DIR = path.join(process.env.ORRAMA_DATA_DIR, "vault");
process.env.ORRAMA_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.ORRAMA_SECRET_KEY = "test-secret-key-0123456789abcdef";

const vault = process.env.ORRAMA_VAULT_DIR;
fs.mkdirSync(vault, { recursive: true });
fs.writeFileSync(path.join(vault, "root.md"), "# root\n");

const { createDb } = await import("../src/db.js");
const { closeDb } = await import("./helpers/db.js");
const db = createDb();
const { VaultStore } = await import("../src/vaultStore.js");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Up to 20 s, for a loaded machine. Without the re-read the late note is
// never indexed, so the wait still ends red, only later.
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 400 && !ok(); i++) await sleep(50);
};

const realWatch = fs.watch;
let store: InstanceType<typeof VaultStore>;

beforeAll(async () => {
  // chokidar imports `watch` from node:fs; syncBuiltinESMExports carries the
  // wrapper into that binding.
  fs.watch = ((target: fs.PathLike, options: unknown, listener: (event: string, name: string | null) => void) => {
    const dir = String(target);
    if (!path.basename(dir).startsWith("Gap") || !fs.statSync(dir).isDirectory()) {
      return (realWatch as (...a: unknown[]) => fs.FSWatcher)(target, options, listener);
    }
    if (path.basename(dir) === "GapD") {
      // Ids already carried: stamping one would write into the folder, and
      // that event would make chokidar find `inner` by itself.
      fs.writeFileSync(path.join(dir, "late.md"), "---\nid: n-gapdlate\n---\n# Late\n");
      fs.mkdirSync(path.join(dir, "inner"));
      fs.writeFileSync(path.join(dir, "inner", "deep.md"), "---\nid: n-gapddeep\n---\n# Deep\n");
    } else {
      fs.writeFileSync(path.join(dir, "late.md"), "# Late\n");
    }
    const before = new Set(fs.readdirSync(dir));
    const attached = Date.now();
    return (realWatch as (...a: unknown[]) => fs.FSWatcher)(target, options, (event: string, name: string | null) => {
      if (Date.now() - attached < 500 && name !== null && before.has(name)) return;
      listener(event, name);
    });
  }) as typeof fs.watch;
  syncBuiltinESMExports();
  store = new VaultStore(db);
  store.load();
  await store.watching;
});

afterAll(async () => {
  await store.close();
  closeDb(db);
  fs.watch = realWatch;
  syncBuiltinESMExports();
  fs.rmSync(process.env.ORRAMA_DATA_DIR!, { recursive: true, force: true });
});

it("a note written between chokidar's read of a new folder and its watch is indexed", async () => {
  fs.mkdirSync(path.join(vault, "GapA"));
  // Carries its id already, so indexing it writes nothing into the folder —
  // a write there would make chokidar re-read it and hide the miss.
  fs.writeFileSync(path.join(vault, "GapA", "first.md"), "---\nid: n-gapafirst\n---\n# First\n");
  await until(() => !!store.index.getByPath("GapA/first.md") && !!store.index.getByPath("GapA/late.md"));
  expect(store.index.getByPath("GapA/first.md")).toBeDefined(); // seen by the read
  expect(store.index.getByPath("GapA/late.md")).toBeDefined(); // landed in the gap
  // Indexed as a note of its own, id stamped into the file like any other.
  expect(fs.readFileSync(path.join(vault, "GapA", "late.md"), "utf8")).toMatch(/^---\nid: n-/);
}, 30_000);

it("a nested new folder too", async () => {
  fs.mkdirSync(path.join(vault, "Outer", "GapB"), { recursive: true });
  await until(() => !!store.index.getByPath("Outer/GapB/late.md"));
  expect(store.index.getByPath("Outer/GapB/late.md")).toBeDefined();
}, 30_000);

it("a subfolder made in the gap is watched and its notes indexed", async () => {
  fs.mkdirSync(path.join(vault, "GapD"));
  await until(() => !!store.index.getByPath("GapD/inner/deep.md"));
  expect(store.index.getByPath("GapD/late.md")).toBeDefined();
  expect(store.index.getByPath("GapD/inner/deep.md")).toBeDefined();
  // chokidar now watches it: a later note there is seen through the normal path.
  fs.writeFileSync(path.join(vault, "GapD", "inner", "after.md"), "---\nid: n-gapdafter\n---\n# After\n");
  await until(() => !!store.index.getByPath("GapD/inner/after.md"));
  expect(store.index.getByPath("GapD/inner/after.md")).toBeDefined();
}, 30_000);

it("hidden files in a new folder stay out, as everywhere else", async () => {
  fs.mkdirSync(path.join(vault, "GapC"));
  fs.writeFileSync(path.join(vault, "GapC", ".hidden.md"), "# Hidden\n");
  await until(() => !!store.index.getByPath("GapC/late.md"));
  expect(store.index.getByPath("GapC/late.md")).toBeDefined();
  expect(store.index.getByPath("GapC/.hidden.md")).toBeUndefined();
}, 30_000);
