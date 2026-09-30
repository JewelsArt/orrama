/**
 * One note id, one file (audit item 11). A note copied outside Basalt carries
 * the original's `id: n-…`, and the id keys everything: the index, the notes
 * table, task objects, calendar blocks, the Y.Doc history. Before this, a
 * live copy took all of it over — the tree lost the original, a task ticked
 * from the Dashboard was written into the copy, the copy's text was appended
 * to the original's history (every replay held the note twice) — and deleting
 * the copy removed the original from the index. At boot, whichever file the
 * walk reached last won.
 *
 * Now the file that owns the id keeps it and the copy gets its own, stamped
 * into its front matter. Rules: noteIds.ts.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.BASALT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "basalt-dup-ids-"));
process.env.BASALT_VAULT_DIR = path.join(process.env.BASALT_DATA_DIR, "vault");
process.env.BASALT_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.BASALT_SECRET_KEY = "test-secret-key-0123456789abcdef";

await import("../src/seed.js");
const { buildServer } = await import("../src/main.js");
const { tables } = await import("../src/db.js");
const { docContent, docFromUpdates } = await import("@basalt/sync");

const VAULT = process.env.BASALT_VAULT_DIR;
const ORIG = "Engineering/Atlas Roadmap.md";
type Built = Awaited<ReturnType<typeof buildServer>>;
let built: Built;
let token = "";
let id = "";
let otherId = "";
let linkedFrom: string[] = [];
const OTHER = "Engineering/Other.md";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const abs = (rel: string) => path.join(VAULT, rel);
const read = (rel: string) => fs.readFileSync(abs(rel), "utf8");
const idAt = (rel: string) => /^id: (n-\S+)$/m.exec(read(rel))?.[1];
const withoutId = (s: string) => s.replace(/^id: n-\S+\n/m, "");

const api = async (method: string, url: string, body?: unknown) => {
  const res = await built.app.inject({
    method: method as "GET",
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
  });
  return { status: res.statusCode, json: (() => { try { return res.json(); } catch { return null; } })() };
};
const boot = async () => {
  built = await buildServer();
  token = (await built.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "jules@basalt.dev", password: "basalt-demo" } })).json().token;
};
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 100 && !ok(); i++) await sleep(50);
};
/** The note's history replayed from the log alone — what history and a cold doc() see. */
const replay = (noteId: string) => {
  const log = built.db.select().from(tables.ydocUpdates).where(eq(tables.ydocUpdates.noteId, noteId)).orderBy(tables.ydocUpdates.id).all();
  return docContent(docFromUpdates(log.map((r) => r.update)));
};
const tree = async () => ((await api("GET", "/api/vault/tree")).json as { id: string; path: string }[]).map((n) => `${n.path} ${n.id}`);
const row = (noteId: string) => built.db.select().from(tables.notes).where(eq(tables.notes.id, noteId)).get();
const backlinks = async () =>
  ((await api("GET", `/api/vault/note/${id}`)).json?.backlinks as { fromPath: string }[] | undefined)?.map((b) => b.fromPath).sort() ?? [];
const objects = (noteId: string) => built.db.select().from(tables.taskObjects).where(eq(tables.taskObjects.noteId, noteId)).all();

/** Everything that says ORIG is note `id`, intact. */
async function originalIntact() {
  expect(idAt(ORIG)).toBe(id);
  expect(built.store.index.get(id)?.path).toBe(ORIG);
  expect(built.store.index.getByPath(ORIG)?.id).toBe(id);
  expect(await tree()).toContain(`${ORIG} ${id}`);
  expect((await api("GET", `/api/vault/note/${id}`)).json?.path).toBe(ORIG);
  expect(row(id)).toMatchObject({ path: ORIG, deleted: false });
  const objs = objects(id);
  expect(objs).toHaveLength(2);
  expect(objs.every((o) => o.status !== "orphaned")).toBe(true);
  expect(replay(id)).toBe(read(ORIG));
  // Links: the copies carry `title: Atlas Roadmap` too; the filename wins.
  expect(built.store.index.resolveLink("Atlas Roadmap")?.id).toBe(id);
  expect(await backlinks()).toEqual(linkedFrom);
  const blocks = built.db.select().from(tables.taskBlocks).all();
  expect(blocks.map((b) => objs.some((o) => o.id === b.taskObjectId))).toEqual([true]);
}

/** A copy at `rel` is a note of its own: its own id, in the file and everywhere. */
async function isOwnNote(rel: string) {
  const own = idAt(rel);
  expect(own).toMatch(/^n-/);
  expect(own).not.toBe(id);
  expect(built.store.index.getByPath(rel)?.id).toBe(own);
  expect(await tree()).toContain(`${rel} ${own}`);
  expect(row(own!)).toMatchObject({ path: rel, deleted: false });
  expect(objects(own!)).toEqual([]);
  // Its own history — none yet if boot stamped it (history starts on first use).
  expect(["", read(rel)]).toContain(replay(own!));
  return own!;
}

beforeAll(async () => {
  await boot();
  const roadmap = built.store.index.getByPath(ORIG)!;
  id = roadmap.id;
  const line = roadmap.tasks.find((t) => t.text.startsWith("dashboard API"))!.line;
  expect((await api("POST", "/api/tasks/blocks", { noteId: id, line, date: "2026-10-05", startMin: 840 })).status).toBe(200);
  for (const extra of ["History one.", "History two."]) {
    expect((await api("PUT", "/api/vault/note", { path: ORIG, content: `${built.store.index.get(id)!.content}\n${extra}\n` })).status).toBe(200);
  }
  await sleep(500);
  linkedFrom = await backlinks();
  expect(linkedFrom.length).toBeGreaterThanOrEqual(5);
  await originalIntact();
});

afterAll(async () => {
  await built.app.close();
  fs.rmSync(process.env.BASALT_DATA_DIR!, { recursive: true, force: true });
});

describe("a copy made while the server runs", () => {
  const COPY = "Engineering/Atlas Roadmap 1.md"; // Obsidian's "Make a copy"

  it("gets its own id; the original keeps everything", async () => {
    fs.copyFileSync(abs(ORIG), abs(COPY));
    await until(() => !!built.store.index.getByPath(COPY));
    await sleep(400); // and the watcher's echo of the stamp settles
    await originalIntact();
    await isOwnNote(COPY);
    expect(withoutId(read(COPY))).toBe(withoutId(read(ORIG))); // only the id changed
  });

  it("a task ticked by id is ticked in the original, not the copy", async () => {
    const line = built.store.index.get(id)!.tasks.find((t) => t.text.startsWith("permission test suite"))!.line;
    expect((await api("POST", "/api/tasks/status", { noteId: id, line, status: "done" })).status).toBe(200);
    expect(read(ORIG)).toMatch(/- \[x\] permission test suite/);
    expect(read(COPY)).toMatch(/- \[ \] permission test suite/);
  });

  it("deleting the copy leaves the original alone", async () => {
    fs.unlinkSync(abs(COPY));
    await until(() => !built.store.index.getByPath(COPY));
    await sleep(200);
    await originalIntact();
  });
});

describe("a copy written over another note", () => {
  it("keeps that note's identity", async () => {
    const made = await api("PUT", "/api/vault/note", { path: OTHER, content: "# other\n" });
    expect(made.status).toBe(200);
    otherId = made.json.id as string;
    await sleep(500);
    fs.copyFileSync(abs(ORIG), abs(OTHER)); // `cp "Atlas Roadmap.md" Other.md`
    await until(() => idAt(OTHER) === otherId);
    await sleep(400);
    expect(idAt(OTHER)).toBe(otherId);
    expect(built.store.index.get(otherId)?.path).toBe(OTHER);
    expect(built.store.index.get(otherId)?.content).toContain("# Atlas Roadmap");
    expect(replay(otherId)).toBe(read(OTHER));
    await originalIntact();
  });
});

describe("a new note written through Basalt with another note's id", () => {
  it("is given its own", async () => {
    const PASTED = "Engineering/Pasted.md";
    const res = await api("PUT", "/api/vault/note", { path: PASTED, content: read(ORIG) });
    expect(res.status).toBe(200);
    expect(res.json.id).not.toBe(id);
    await sleep(400);
    await isOwnNote(PASTED);
    await originalIntact();
  });
});

describe("a copy made while the server is down", () => {
  const EARLY = "Aardvark/Atlas Roadmap.md"; // walked before the original
  const LATE = "Zeta/Atlas Roadmap (conflicted copy).md"; // walked after it — it used to take the id over

  it("each copy gets its own id at boot, wherever the walk meets it", async () => {
    await built.app.close();
    for (const rel of [EARLY, LATE]) {
      fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
      fs.copyFileSync(abs(ORIG), abs(rel));
    }
    fs.copyFileSync(abs(ORIG), abs(OTHER)); // and over another note, again
    // An editor that saves atomically (temp file + rename) makes the original
    // the YOUNGEST file; the notes table still knows it is the note.
    await sleep(20);
    fs.writeFileSync(abs(`${ORIG}.tmp`), read(ORIG));
    fs.renameSync(abs(`${ORIG}.tmp`), abs(ORIG));
    await boot();
    await originalIntact();
    const early = await isOwnNote(EARLY);
    const late = await isOwnNote(LATE);
    expect(early).not.toBe(late);
    expect(idAt(OTHER)).toBe(otherId); // the note that was there stays itself
    expect(built.store.index.get(otherId)?.path).toBe(OTHER);
  });

  it("deleting one afterwards leaves the original alone", async () => {
    fs.unlinkSync(abs(EARLY));
    await until(() => !built.store.index.getByPath(EARLY));
    await sleep(200);
    await originalIntact();
  });
});

describe("a note renamed outside Basalt keeps its id", () => {
  // A rename is unlink(old) + add(new), and nothing promises the order.
  // Driven by hand with the watcher stopped, so each order really happens.
  const drive = (event: string, rel: string) =>
    (built.store as unknown as { handleExternalChange(e: string, r: string, a: string): void }).handleExternalChange(event, rel, abs(rel));

  for (const order of ["add first", "unlink first"] as const) {
    it(order, async () => {
      await built.store.close();
      const from = built.store.index.get(id)!.path;
      const to = order === "add first" ? "Engineering/Roadmap renamed.md" : "Renamed/Atlas Roadmap.md";
      fs.mkdirSync(path.dirname(abs(to)), { recursive: true });
      fs.renameSync(abs(from), abs(to));
      if (order === "add first") {
        drive("add", to);
        drive("unlink", from);
      } else {
        drive("unlink", from);
        drive("add", to);
      }
      expect(idAt(to)).toBe(id);
      expect(built.store.index.get(id)?.path).toBe(to);
      expect(built.store.index.getByPath(from)).toBeUndefined();
      expect(row(id)).toMatchObject({ path: to, deleted: false });
      expect(objects(id).every((o) => o.status !== "orphaned")).toBe(true);
      expect(replay(id)).toBe(read(to));
      // put it back for the next order, through a fresh boot
      await built.app.close();
      fs.renameSync(abs(to), abs(ORIG));
      await boot();
      await originalIntact();
    });
  }
});
