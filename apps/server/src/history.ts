/**
 * Note history over the Yjs update log (§10): read it in one pass, serve it a
 * page at a time, and keep the log from growing without bound.
 *
 * The old route rebuilt a fresh Y.Doc from `log.slice(0, i + 1)` for every
 * row — n(n+1)/2 update applications for n revisions — and returned every
 * revision's full text in one response. A note saved a few thousand times
 * (the editor autosaves) made that a multi-second, multi-megabyte request.
 *
 * Compaction merges runs of old updates with `Y.mergeUpdates`, which is
 * exactly equivalent to applying them in order: the note's state, and the
 * text of every revision that is kept, do not change. What goes is the
 * in-between: updates older than a day collapse to one per hour, older than
 * 30 days to one per day. A merged run keeps its first row's id (so the log's
 * order is untouched), its last row's time, and its author when there was
 * only one.
 */
import { and, asc, eq, inArray, lt } from "drizzle-orm";
import * as Y from "yjs";
import { applyUpdateB64, docContent } from "@orrama/sync";
import { tables, type Db } from "./db.js";

export interface LogRow {
  id: number;
  update: string;
  authorId: string | null;
  createdAt: number;
}

/** Call `each` with every row and the note's text right after it — one doc, one pass. */
export function replay(rows: LogRow[], each: (row: LogRow, content: string) => void): void {
  const doc = new Y.Doc();
  for (const row of rows) {
    applyUpdateB64(doc, row.update);
    each(row, docContent(doc));
  }
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Which bucket an update falls in: its own (recent), its hour, or its day. */
export function bucketOf(createdAt: number, now: number): string | null {
  const age = now - createdAt;
  if (age < DAY) return null;
  if (age < 30 * DAY) return `h${Math.floor(createdAt / HOUR)}`;
  return `d${Math.floor(createdAt / DAY)}`;
}

/** Contiguous runs of 2+ rows sharing a bucket — the only thing ever merged. */
export function compactionRuns(rows: LogRow[], now: number): LogRow[][] {
  const runs: LogRow[][] = [];
  let run: LogRow[] = [];
  let key: string | null = null;
  const flush = () => {
    if (run.length > 1) runs.push(run);
    run = [];
  };
  for (const row of rows) {
    const k = bucketOf(row.createdAt, now);
    if (k === null || k !== key) flush();
    key = k;
    if (k !== null) run.push(row);
  }
  flush();
  return runs;
}

/** Compact one note's log. Returns how many rows it removed. */
export function compactNote(db: Db, noteId: string, now = Date.now()): number {
  const rows = db
    .select()
    .from(tables.ydocUpdates)
    .where(and(eq(tables.ydocUpdates.noteId, noteId), lt(tables.ydocUpdates.createdAt, now - DAY)))
    .orderBy(asc(tables.ydocUpdates.id))
    .all();
  let removed = 0;
  // A run must be contiguous in the WHOLE log, not just among old rows — the
  // old rows are a prefix of it (ids and times both increase), so it is.
  for (const run of compactionRuns(rows, now)) {
    const merged = Buffer.from(Y.mergeUpdates(run.map((r) => new Uint8Array(Buffer.from(r.update, "base64"))))).toString("base64");
    const authors = new Set(run.map((r) => r.authorId));
    const [first, ...rest] = run;
    db.transaction((tx) => {
      tx.update(tables.ydocUpdates)
        .set({ update: merged, createdAt: run[run.length - 1]!.createdAt, authorId: authors.size === 1 ? first!.authorId : null })
        .where(eq(tables.ydocUpdates.id, first!.id))
        .run();
      tx.delete(tables.ydocUpdates).where(inArray(tables.ydocUpdates.id, rest.map((r) => r.id))).run();
    });
    removed += rest.length;
  }
  return removed;
}

/** Every note's log. Cheap when there is nothing to do; run at boot and daily. */
export function compactAll(db: Db, now = Date.now()): number {
  const ids = db.selectDistinct({ noteId: tables.ydocUpdates.noteId }).from(tables.ydocUpdates).where(lt(tables.ydocUpdates.createdAt, now - DAY)).all();
  let removed = 0;
  for (const { noteId } of ids) removed += compactNote(db, noteId, now);
  return removed;
}
