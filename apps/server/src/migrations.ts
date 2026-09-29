/**
 * One-shot data migrations: moves of state out of the database and into the
 * vault, which must run exactly once.
 *
 * "Once" matters because the file wins afterwards. If the task-status move ran
 * on every boot, a task set back to `[ ]` in Obsidian while the server was
 * down would be put back to `[/]` from the stale row on the next start. So a
 * migration records its name in `meta` when it has run, and never looks again.
 */
import { eq, inArray } from "drizzle-orm";
import { setTaskStatus, type AclUser } from "@basalt/core";
import { tables, type Db } from "./db.js";
import type { VaultStore } from "./vaultStore.js";

function once(db: Db, key: string, run: () => void): void {
  if (db.select().from(tables.meta).where(eq(tables.meta.key, key)).get()) return;
  run();
  db.insert(tables.meta).values({ key, value: new Date().toISOString() }).run();
}

/** The workspace owner edits on the migration's behalf — owners can edit every note. */
function ownerUser(db: Db, store: VaultStore): AclUser | null {
  const owner = db.select().from(tables.users).where(eq(tables.users.isOwner, true)).get();
  return owner ? store.aclUser(owner.id) : null;
}

/**
 * Audit B10: "working on it" and "blocked" lived on task_objects only. Write
 * each into its line as `[/]` / `[b]` — but only onto a plain `[ ]`: a line
 * someone has since ticked, or already marked, is newer than the row.
 */
function taskMarksIntoLines(db: Db, store: VaultStore): void {
  const rows = db.select().from(tables.taskObjects).where(inArray(tables.taskObjects.status, ["in-progress", "blocked"])).all();
  if (rows.length === 0) return;
  const owner = ownerUser(db, store);
  if (!owner) return;
  for (const row of rows) {
    const note = store.index.get(row.noteId);
    const line = note?.tasks.find((t) => t.blockId === row.blockId);
    if (!note || !line || line.status !== "todo") continue;
    const next = setTaskStatus(note.content, { blockId: row.blockId }, row.status as "in-progress" | "blocked");
    if (next !== null && next !== note.content) {
      try {
        store.write(owner, note.path, next);
        console.info(`[migrate] ${note.path}: task ^${row.blockId} marked ${row.status} in the file`);
      } catch (err) {
        console.error(`[migrate] ${note.path}: could not mark ^${row.blockId} — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}

export function runDataMigrations(db: Db, store: VaultStore): void {
  once(db, "b10-task-marks", () => taskMarksIntoLines(db, store));
}
