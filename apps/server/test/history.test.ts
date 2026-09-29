/**
 * Note history (§10) over the Yjs update log: one replay per request (it was
 * one per row — O(n²)), a page at a time, one revision's text on its own, and
 * a log that is compacted instead of growing forever — without changing the
 * note or the text of any revision it keeps.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { asc, eq } from "drizzle-orm";
import * as Y from "yjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.BASALT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "basalt-history-"));
process.env.BASALT_VAULT_DIR = path.join(process.env.BASALT_DATA_DIR, "vault");
process.env.BASALT_JWT_SECRET = "test-secret";
process.env.BASALT_SECRET_KEY = "test-secret-key-0123456789abcdef";

await import("../src/seed.js");
const { buildServer } = await import("../src/main.js");
const { tables } = await import("../src/db.js");
const { compactNote, compactionRuns, replay } = await import("../src/history.js");

const DAY = 86_400_000;
let b: Awaited<ReturnType<typeof buildServer>>;
const tokens: Record<string, string> = {};
const get = async (who: string, url: string) => {
  const r = await b.app.inject({ method: "GET", url, headers: { authorization: `Bearer ${tokens[who]}` } });
  return { status: r.statusCode, json: r.statusCode === 200 ? r.json() : null };
};

/** A fresh log for `noteId`: one Yjs update per line typed, stamped at `times[i]`. */
function writeLog(noteId: string, times: number[]): string[] {
  b.db.delete(tables.ydocUpdates).where(eq(tables.ydocUpdates.noteId, noteId)).run();
  const doc = new Y.Doc();
  const text = doc.getText("content");
  const contents: string[] = [];
  times.forEach((at, i) => {
    let update: Uint8Array | null = null;
    doc.once("update", (u: Uint8Array) => (update = u));
    text.insert(text.length, `line ${i}\n`);
    contents.push(text.toString());
    b.db.insert(tables.ydocUpdates).values({ noteId, update: Buffer.from(update!).toString("base64"), authorId: i % 2 ? "u-a" : "u-b", createdAt: at }).run();
  });
  return contents;
}
const logOf = (noteId: string) => b.db.select().from(tables.ydocUpdates).where(eq(tables.ydocUpdates.noteId, noteId)).orderBy(asc(tables.ydocUpdates.id)).all();

beforeAll(async () => {
  b = await buildServer();
  for (const who of ["jules", "erin", "mara"]) {
    tokens[who] = (await b.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: `${who}@basalt.dev`, password: "basalt-demo" } })).json().token;
  }
});
afterAll(async () => {
  await b.app.close();
  fs.rmSync(process.env.BASALT_DATA_DIR!, { recursive: true, force: true });
});

describe("history, read", () => {
  it("a long log is one replay, not one per revision", async () => {
    const note = b.store.index.getByPath("Shared/Meeting Notes 2026-07-01.md")!;
    writeLog(note.id, Array.from({ length: 2500 }, () => Date.now()));
    const t0 = performance.now();
    const r = await get("jules", `/api/vault/note/${note.id}/history?limit=5`);
    const ms = performance.now() - t0;
    expect(r.status).toBe(200);
    expect(r.json.total).toBe(2500);
    expect(r.json.revisions).toHaveLength(5);
    // One pass is a few ms; the per-row rebuild was n(n+1)/2 ≈ 3.1M applications.
    expect(ms).toBeLessThan(1500);
  });

  it("pages newest first, and a revision's text matches the list's", async () => {
    const note = b.store.index.getByPath("Shared/Meeting Notes 2026-07-01.md")!;
    const contents = writeLog(note.id, Array.from({ length: 7 }, (_, i) => Date.now() + i));
    const p1 = await get("jules", `/api/vault/note/${note.id}/history?limit=3&content=1`);
    expect(p1.json.revisions.map((r: { content: string }) => r.content)).toEqual([contents[6], contents[5], contents[4]]);
    expect(p1.json.revisions[0].length).toBe(contents[6]!.length);
    const p2 = await get("jules", `/api/vault/note/${note.id}/history?limit=3&content=1&before=${p1.json.nextBefore}`);
    expect(p2.json.revisions.map((r: { content: string }) => r.content)).toEqual([contents[3], contents[2], contents[1]]);
    const p3 = await get("jules", `/api/vault/note/${note.id}/history?limit=3&before=${p2.json.nextBefore}`);
    expect(p3.json.revisions).toHaveLength(1);
    expect(p3.json.revisions[0].content).toBeUndefined(); // text only when asked
    expect(p3.json.nextBefore).toBeNull();

    const one = await get("jules", `/api/vault/note/${note.id}/history/${p1.json.revisions[1].seq}`);
    expect(one.json.content).toBe(contents[5]);
  });

  it("a revision is only served through its own note, and only to a reader", async () => {
    const shared = b.store.index.getByPath("Shared/Meeting Notes 2026-07-01.md")!;
    const engNote = b.store.index.getByPath("Engineering/Atlas Roadmap.md")!;
    const seq = logOf(engNote.id)[0]!.id;
    // mara (marketing) reads Shared but not Engineering: asking for an
    // Engineering revision through a note she CAN read must not leak it.
    expect((await get("mara", `/api/vault/note/${engNote.id}/history/${seq}`)).status).toBe(404);
    expect((await get("mara", `/api/vault/note/${shared.id}/history/${seq}`)).status).toBe(404);
    expect((await get("mara", `/api/vault/note/${engNote.id}/history`)).status).toBe(404);
    expect((await get("jules", `/api/vault/note/${engNote.id}/history/${seq}`)).status).toBe(200);
    expect((await get("jules", `/api/vault/note/${engNote.id}/history/abc`)).status).toBe(404);
  });
});

describe("history, compaction", () => {
  const now = Date.UTC(2026, 8, 29, 12);
  const at = (daysAgo: number, hour: number, min = 0) => now - daysAgo * DAY + (hour - 12) * 3_600_000 + min * 60_000;

  it("merges old runs by day, recent-ish runs by hour, and leaves today alone", () => {
    const times = [
      at(40, 9), at(40, 10), at(40, 15), // one day, 40 days ago → 1 row
      at(39, 9), // alone on its day → untouched
      at(10, 14, 5), at(10, 14, 20), at(10, 14, 50), // one hour, 10 days ago → 1 row
      at(10, 15, 1), // next hour → its own
      at(0, 11), at(0, 11, 1), at(0, 11, 2), // today → untouched
    ];
    const rows = times.map((createdAt, i) => ({ id: i + 1, update: "", authorId: null, createdAt }));
    expect(compactionRuns(rows, now).map((r) => r.map((x) => x.id))).toEqual([[1, 2, 3], [5, 6, 7]]);
  });

  it("keeps the note and every kept revision's text exactly as they were", async () => {
    const note = b.store.index.getByPath("Shared/Meeting Notes 2026-07-01.md")!;
    const times = [at(40, 9), at(40, 10), at(40, 15), at(39, 9), at(10, 14, 5), at(10, 14, 20), at(10, 14, 50), at(10, 15, 1), at(0, 11), at(0, 11, 1)];
    writeLog(note.id, times);
    const before = new Map<number, string>();
    const beforeRows = logOf(note.id);
    replay(beforeRows, (row, text) => before.set(row.id, text));

    expect(compactNote(b.db, note.id, now)).toBe(4); // 3→1 and 3→1
    const afterRows = logOf(note.id);
    expect(afterRows).toHaveLength(6);
    // The merged row keeps the run's first id and its last time; mixed authors → null.
    expect(afterRows[0]!.id).toBe(beforeRows[0]!.id);
    expect(afterRows[0]!.createdAt).toBe(times[2]);
    expect(afterRows[0]!.authorId).toBeNull();
    const after = new Map<number, string>();
    replay(afterRows, (row, text) => after.set(row.id, text));
    // First kept row now holds what the run's LAST row held; every other kept row is unchanged.
    expect(after.get(beforeRows[0]!.id)).toBe(before.get(beforeRows[2]!.id));
    for (const r of afterRows.slice(1)) {
      const merged = r.id === beforeRows[4]!.id;
      expect(after.get(r.id)).toBe(before.get(merged ? beforeRows[6]!.id : r.id));
    }
    expect([...after.values()].pop()).toBe([...before.values()].pop());
    expect(compactNote(b.db, note.id, now)).toBe(0); // idempotent
  });
});
