/**
 * Events the watcher never receives are made up for (VaultStore.reconcile).
 *
 * On macOS, Node's fs.watch serves every watched folder of a process from one
 * FSEvents stream and rebuilds it, "since now", whenever a folder watch is
 * added or closed: what FSEvents had not yet delivered is lost, for every
 * folder. chokidar adds a watch per new folder, so a folder made anywhere in
 * the vault could swallow a note created, renamed or deleted elsewhere at
 * that moment, for good; and the first stream starts after chokidar's
 * "ready", so a note made just after boot was lost the same way. That was
 * the flake in path-identity (STO-012) and new-folder-watch: the event was
 * never late, it never came.
 *
 * The test loses events on purpose, on every platform: `fs.watch` is wrapped
 * so that nothing naming a file in `lost` reaches chokidar, as if the stream
 * had been rebuilt over it. A folder made elsewhere is the moment the store
 * reads the vault again.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.ORRAMA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-lost-events-"));
process.env.ORRAMA_VAULT_DIR = path.join(process.env.ORRAMA_DATA_DIR, "vault");
process.env.ORRAMA_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.ORRAMA_SECRET_KEY = "test-secret-key-0123456789abcdef";

const vault = process.env.ORRAMA_VAULT_DIR;
const abs = (rel: string) => path.join(vault, rel);
// Ids already carried: stamping one would write into its folder, and that
// event would make chokidar read the folder and find the rest by itself.
const note = (rel: string, id: string) => {
  fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
  fs.writeFileSync(abs(rel), `---\nid: ${id}\n---\n# ${path.basename(rel, ".md")}\n`);
};
note("Shared/Gone.md", "n-lostgone");
note("Shared/Plan.md", "n-lostplan");
note("Locked/Kept.md", "n-lostkept");

const { createDb } = await import("../src/db.js");
const { closeDb } = await import("./helpers/db.js");
const db = createDb();
const { VaultStore } = await import("../src/vaultStore.js");

const CASE_INSENSITIVE = fs.existsSync(abs("shared/plan.md"));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// The re-read comes 1 s after the folder change, then the 300 ms settle;
// up to 10 s for a loaded machine.
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 200 && !ok(); i++) await sleep(50);
};
let triggers = 0;
/** A folder appears elsewhere, at the root: the moment the watcher's folder
 *  set changes. chokidar reads the root again for it, so what is lost is
 *  never at the root itself. */
const folderElsewhere = () => fs.mkdirSync(abs(`Elsewhere ${++triggers}`));

const lost = new Set<string>();
const realWatch = fs.watch;
let store: InstanceType<typeof VaultStore>;
const has = (rel: string) => !!store.index.getByPath(rel);
const paths = (prefix: string) =>
  store.index
    .all()
    .map((n) => n.path)
    .filter((p) => p.toLowerCase().startsWith(prefix.toLowerCase()))
    .sort();

beforeAll(async () => {
  // chokidar imports `watch` from node:fs; syncBuiltinESMExports carries the
  // wrapper into that binding.
  fs.watch = ((target: fs.PathLike, options: unknown, listener: (event: string, name: string | null) => void) =>
    (realWatch as (...a: unknown[]) => fs.FSWatcher)(target, options, (event: string, name: string | null) => {
      if (name !== null && lost.has(path.basename(name))) return;
      listener(event, name);
    })) as typeof fs.watch;
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

// First, while the boot's re-read is still to come: nothing else happens.
it("a note made just after the watcher is ready, its event lost, is indexed", async () => {
  lost.add("Early.md");
  note("Early.md", "n-lostearly");
  await until(() => has("Early.md"));
  expect(has("Early.md")).toBe(true);
});

it("a note made as a folder appears elsewhere, its event lost, is indexed", async () => {
  lost.add("Lost note.md");
  note("Shared/Lost note.md", "n-lostnote");
  folderElsewhere();
  await until(() => has("Shared/Lost note.md"));
  expect(has("Shared/Lost note.md")).toBe(true);
});

it("a new folder whose event is lost is watched, and its notes indexed", async () => {
  lost.add("Lost folder");
  note("Shared/Lost folder/First.md", "n-lostfirst");
  folderElsewhere();
  await until(() => has("Shared/Lost folder/First.md"));
  expect(has("Shared/Lost folder/First.md")).toBe(true);
  // chokidar watches it now: an edit there arrives the normal way. (An edit,
  // not a new note: that would change the folder, and chokidar would read it
  // again from Shared's watch by itself.)
  lost.delete("Lost folder");
  fs.appendFileSync(abs("Shared/Lost folder/First.md"), "edited\n");
  await until(() => !!store.index.getByPath("Shared/Lost folder/First.md")?.content.includes("edited"));
  expect(store.index.getByPath("Shared/Lost folder/First.md")?.content).toContain("edited");
});

it("a note deleted while its events are lost leaves the index", async () => {
  expect(has("Shared/Gone.md")).toBe(true);
  lost.add("Gone.md");
  fs.rmSync(abs("Shared/Gone.md"));
  folderElsewhere();
  await until(() => !has("Shared/Gone.md"));
  expect(has("Shared/Gone.md")).toBe(false);
});

describe.runIf(CASE_INSENSITIVE)("a case-only rename", () => {
  it("whose events are lost moves the note to the new spelling, id kept, file untouched; and back again", async () => {
    const id = store.index.getByPath("Shared/Plan.md")?.id;
    expect(id).toBe("n-lostplan");
    const bytes = fs.readFileSync(abs("Shared/Plan.md"), "utf8");
    lost.add("Plan.md").add("plan.md");
    fs.renameSync(abs("Shared/Plan.md"), abs("Shared/plan.md"));
    folderElsewhere();
    await until(() => paths("Shared/plan").join() === "Shared/plan.md");
    expect(paths("Shared/plan")).toEqual(["Shared/plan.md"]);
    expect(store.index.getByPath("Shared/plan.md")?.id).toBe(id);
    expect(fs.readFileSync(abs("Shared/plan.md"), "utf8")).toBe(bytes);

    // chokidar still holds the old spelling for this folder, so the rename
    // back reads to it as no change at all; the raw event still names both.
    lost.clear();
    fs.renameSync(abs("Shared/plan.md"), abs("Shared/Plan.md"));
    await until(() => paths("Shared/plan").join() === "Shared/Plan.md");
    expect(paths("Shared/plan")).toEqual(["Shared/Plan.md"]);
    expect(store.index.getByPath("Shared/Plan.md")?.id).toBe(id);
    expect(fs.readFileSync(abs("Shared/Plan.md"), "utf8")).toBe(bytes);
  });
});

it("a folder the re-read cannot list keeps its notes in the index", async () => {
  // A transient failure (too many open files): chokidar reads with the async
  // API and is not affected, the re-read and listedExactly are.
  expect(has("Locked/Kept.md")).toBe(true);
  const realReaddir = fs.readdirSync;
  fs.readdirSync = ((dir: fs.PathLike, ...rest: unknown[]) => {
    if (path.resolve(String(dir)) === path.resolve(abs("Locked"))) throw Object.assign(new Error("EMFILE: too many open files"), { code: "EMFILE" });
    return (realReaddir as (...a: unknown[]) => unknown)(dir, ...rest);
  }) as typeof fs.readdirSync;
  try {
    // A lost note alongside shows the re-read has run.
    lost.add("Witness.md");
    note("Shared/Witness.md", "n-lostwitness");
    folderElsewhere();
    await until(() => has("Shared/Witness.md"));
    expect(has("Shared/Witness.md")).toBe(true);
    await sleep(500);
    expect(has("Locked/Kept.md")).toBe(true);
  } finally {
    fs.readdirSync = realReaddir;
  }
});
