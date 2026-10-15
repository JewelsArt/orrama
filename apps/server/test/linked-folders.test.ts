/**
 * A folder linked into the vault is part of it, at boot as live (audit
 * STO-010). Obsidian follows a symlinked folder; so did the watcher (chokidar
 * follows links) and resolvePath (a write lands through the link). Only the
 * boot walk did not — a symlink's Dirent is not a directory — so the folder's
 * notes vanished at every restart and came back on their next edit. One rule
 * now: follow, with each real folder walked once, so a link back up the tree
 * cannot loop.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "basalt-linked-"));
process.env.ORRAMA_DATA_DIR = ROOT;
process.env.ORRAMA_VAULT_DIR = path.join(ROOT, "vault");
const VAULT = process.env.ORRAMA_VAULT_DIR;
const OUTSIDE = path.join(ROOT, "synced");

fs.mkdirSync(path.join(VAULT, "Notes"), { recursive: true });
fs.mkdirSync(path.join(OUTSIDE, "deeper"), { recursive: true });
fs.writeFileSync(path.join(VAULT, "Plain.md"), "# Plain\n");
fs.writeFileSync(path.join(OUTSIDE, "Linked.md"), "# Linked\n");
fs.writeFileSync(path.join(OUTSIDE, "deeper", "Deep.md"), "# Deep\n");
fs.symlinkSync(OUTSIDE, path.join(VAULT, "Linked folder"), "dir");
// A link back up the tree: walked once, never looped.
fs.symlinkSync(VAULT, path.join(VAULT, "Notes", "loop"), "dir");
// A shortcut into the vault that sorts before its target: the real path wins.
fs.writeFileSync(path.join(VAULT, "Notes", "In notes.md"), "# In notes\n");
fs.symlinkSync(path.join(VAULT, "Notes"), path.join(VAULT, "A shortcut"), "dir");
// A synced folder linking to itself, and a second link to it: still one name per note.
fs.symlinkSync(OUTSIDE, path.join(OUTSIDE, "deeper", "again"), "dir");
fs.symlinkSync(OUTSIDE, path.join(VAULT, "Notes", "Same folder"), "dir");

const { createDb } = await import("../src/db.js");
const { closeDb } = await import("./helpers/db.js");
const { VaultStore } = await import("../src/vaultStore.js");
let store: InstanceType<typeof VaultStore>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const paths = () => store.index.all().map((n) => n.path).sort();

const db = createDb();
beforeAll(async () => {
  store = new VaultStore(db);
  store.load();
  await store.watching;
});
afterAll(async () => {
  await store.close();
  closeDb(db);
  fs.rmSync(ROOT, { recursive: true, force: true });
});

it("boot indexes the notes in a linked folder, each once", () => {
  expect(paths()).toEqual(["Linked folder/Linked.md", "Linked folder/deeper/Deep.md", "Notes/In notes.md", "Plain.md"]);
});

it("edits through the watcher leave the same set, however many names lead to the file", async () => {
  const before = paths();
  for (const n of [1, 2, 3]) {
    fs.appendFileSync(path.join(OUTSIDE, "Linked.md"), `edit ${n}\n`);
    fs.appendFileSync(path.join(OUTSIDE, "deeper", "Deep.md"), `edit ${n}\n`);
    for (let i = 0; i < 40 && !store.index.getByPath("Linked folder/Linked.md")?.content.includes(`edit ${n}`); i++) await sleep(50);
    await sleep(400);
    expect(store.index.getByPath("Linked folder/Linked.md")?.content).toContain(`edit ${n}`);
    expect(paths()).toEqual(before);
  }
});

it("the watcher does not walk into a link that loops", () => {
  const watched = Object.keys((store as unknown as { watcher: { getWatched(): Record<string, string[]> } }).watcher.getWatched());
  expect(watched.filter((d) => /again|loop|A shortcut/.test(d))).toEqual([]);
});

it("a restart finds the same set again", async () => {
  const before = paths();
  const db2 = createDb();
  const again = new VaultStore(db2);
  again.load();
  await again.watching;
  expect(again.index.all().map((n) => n.path).sort()).toEqual(before);
  await again.close();
  closeDb(db2);
});

const owner = { id: "u-owner", username: "owner", teams: [], isOwner: true };

it("a write through a link from outside lands in the linked folder", () => {
  const note = store.write(owner, "Linked folder/Written.md", "# Written\n");
  expect(note.path).toBe("Linked folder/Written.md");
  expect(fs.readFileSync(path.join(OUTSIDE, "Written.md"), "utf8")).toContain("# Written\n");
});

it("a write through a link back into the vault is refused", () => {
  expect(() => store.write(owner, "Notes/loop/Plain.md", "overwritten\n")).toThrow(/link to another part of the vault/);
  expect(fs.readFileSync(path.join(VAULT, "Plain.md"), "utf8")).not.toContain("overwritten");
  expect(paths().some((p) => p.startsWith("Notes/loop"))).toBe(false);
});

it("a folder linked in while the server runs is taken in", async () => {
  const more = path.join(ROOT, "more");
  fs.mkdirSync(more);
  fs.writeFileSync(path.join(more, "More.md"), "# More\n");
  fs.symlinkSync(more, path.join(VAULT, "More link"), "dir");
  for (let i = 0; i < 60 && !store.index.getByPath("More link/More.md"); i++) await sleep(50);
  expect(store.index.getByPath("More link/More.md")).toBeDefined();
});
