/**
 * Time blocks and events live in the vault, one Markdown note per person per
 * month (audit B10). The `task_blocks` and `events` tables are an index of
 * those notes and nothing more: delete the database, re-index, and every block
 * and event comes back with the same id.
 *
 *     ---
 *     calendar: jules
 *     month: "2026-10"
 *     ---
 *     | Date | Start | End | What | Task | id |
 *     | --- | --- | --- | --- | --- | --- |
 *     | 2026-10-03 | 09:00 | 11:00 | Draft chapter 3 | [[04-Projects/thesis#^t-ab12cd]] | blk-1a2b3c4d |
 *     | 2026-10-04 | 14:00 | 15:00 | Supervision |  | ev-9f8e7d6c |
 *
 * A row with a Task link is time booked on that task; one without is an event.
 * There is ONE write path: every route edits the note through
 * `VaultStore.write`, and the `note-changed` listener re-reads the note's
 * rows into the tables — the same thing that happens when the note is edited
 * in Obsidian. Rows are only taken as the named user's if that user can edit
 * the note (and, for a block, the task's note), and only from a calendar
 * folder; a row that fails a check stays in the file, it just is not on the
 * calendar.
 *
 * Notes go in `01-Me/Calendar/` (Jules's choice, 2026-09-29). A user who
 * cannot edit there gets `Personal/<username>/Calendar/`, which is theirs by
 * path under the ACL — and so does one whose `01-Me/Calendar/` note another
 * account could read. Events are "yours only" in /api/events, and a row in a
 * note the teams can search is not (audit ACL-009). Owners read everything
 * by design (permission model rule 4), so they are not "another account"
 * here; on a one-account install nothing moves.
 */
import crypto from "node:crypto";
import { eq, isNull } from "drizzle-orm";
import { canEdit, canRead, type AclNote, type AclUser, type IndexedNote } from "@orrama/core";
import { tables, type Db } from "./db.js";
import { HttpError, type VaultStore } from "./vaultStore.js";

export const CAL_DIR = "01-Me/Calendar";
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]?\d|2[0-4]):([0-5]\d)$/;
const ID_RE = /^(blk|ev)-[\w-]{1,40}$/;
const HEADER = "| Date | Start | End | What | Task | id |";
const SEPARATOR = "| --- | --- | --- | --- | --- | --- |";
const HEADER_RE = /^\|\s*date\s*\|\s*start\s*\|\s*end\s*\|\s*what\s*\|\s*task\s*\|\s*id\s*\|\s*$/i;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export interface CalRow {
  id: string;
  date: string;
  startMin: number;
  durationMin: number;
  /** An event's title; for a block, the task text when the row was written (display only). */
  title: string;
  task: { notePath: string; blockId: string } | null;
}

/** A row as found in a note: its line, and an id even when the cell is blank. */
interface FoundRow extends CalRow {
  line: number;
}

/** A date that exists: the shape alone lets a hand-typed 2026-02-30 through. */
const realDay = (d: string) => {
  const t = Date.parse(`${d}T00:00:00Z`);
  return DAY_RE.test(d) && Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === d;
};
const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
const minutes = (s: string): number | null => {
  const m = TIME_RE.exec(s.trim());
  if (!m) return null;
  const v = Number(m[1]) * 60 + Number(m[2]);
  return v <= 24 * 60 ? v : null;
};
const cellText = (s: string) => s.replace(/[\r\n]+/g, " ").replace(/\|/g, "\\|").trim();

/** Split a table line on unescaped pipes, keeping `[[…]]` whole. */
function cells(line: string): string[] | null {
  const t = line.trim();
  if (!t.startsWith("|")) return null;
  const out: string[] = [];
  let cur = "";
  let depth = 0;
  for (let i = 1; i < t.length; i++) {
    const c = t[i]!;
    if (c === "\\" && t[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (c === "[" && t[i + 1] === "[") {
      depth++;
      cur += "[[";
      i++;
    } else if (c === "]" && t[i + 1] === "]" && depth > 0) {
      depth--;
      cur += "]]";
      i++;
    } else if (c === "|" && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/**
 * Every row of the note's calendar table, in file order. Malformed rows are
 * skipped, not fatal. `owner` is the calendar's user (the note's `calendar:`).
 */
export function parseCalendarRows(owner: string, content: string): FoundRow[] {
  const lines = content.split("\n");
  const head = lines.findIndex((l) => HEADER_RE.test(l.trim()));
  if (head === -1) return [];
  const rows: FoundRow[] = [];
  const seen = new Map<string, number>();
  for (let i = head + 2; i < lines.length; i++) {
    const c = cells(lines[i]!);
    if (!c) break;
    const [date = "", start = "", end = "", what = "", task = "", idCell = ""] = c;
    const s = minutes(start);
    const e = minutes(end);
    if (!realDay(date) || s === null || e === null || e <= s) continue;
    const link = /^\[\[([^\]#|]+)#\^([\w-]+)\]\]$/.exec(task);
    const kind = link ? "blk" : "ev";
    let id = ID_RE.test(idCell) && idCell.startsWith(kind) ? idCell : "";
    if (!id) {
      // A row typed by hand has no id: derive one from what it says, so it is
      // stable across re-reads until the row itself changes. From the owner,
      // not the note: a copy of the note (Finder, `cp`, "Make a copy") has
      // its own note id, and keyed by note its rows came out as new events —
      // every one doubled. Keyed by owner they are the same ids, and the
      // copy's rows are skipped as taken, like rows that carry an id.
      const n = (seen.get(lines[i]!) ?? 0) + 1;
      seen.set(lines[i]!, n);
      id = `${kind}-${crypto.createHash("sha1").update(`${owner}\n${lines[i]}\n${n}`).digest("hex").slice(0, 8)}`;
    }
    rows.push({
      line: i,
      id,
      date,
      startMin: s,
      durationMin: e - s,
      title: what,
      task: link ? { notePath: link[1]!.trim(), blockId: link[2]! } : null,
    });
  }
  return rows;
}

export function renderRow(r: CalRow): string {
  const task = r.task ? `[[${r.task.notePath}#^${r.task.blockId}]]` : "";
  return `| ${r.date} | ${hhmm(r.startMin)} | ${hhmm(r.startMin + r.durationMin)} | ${cellText(r.title)} | ${task} | ${r.id} |`;
}

function monthNote(username: string, month: string): string {
  const [y, m] = month.split("-");
  return [
    "---",
    `calendar: ${username}`,
    `month: "${month}"`,
    "---",
    `# Calendar · ${MONTHS[Number(m) - 1]} ${y}`,
    "",
    "Time blocks and events from Basalt's Planning tab. Edit a row to move it, delete it to remove it; a row with a Task link is time booked on that task.",
    "",
    HEADER,
    SEPARATOR,
    "",
  ].join("\n");
}

/** Put `row` into `content`: replace the line with its id, or insert it in date order. */
export function placeRow(owner: string, content: string, row: CalRow): string {
  const lines = content.split("\n");
  const found = parseCalendarRows(owner, content);
  const hit = found.find((r) => r.id === row.id);
  if (hit) {
    lines[hit.line] = renderRow(row);
    return lines.join("\n");
  }
  const head = lines.findIndex((l) => HEADER_RE.test(l.trim()));
  if (head === -1) {
    const body = content.endsWith("\n") ? content : `${content}\n`;
    return `${body}\n${HEADER}\n${SEPARATOR}\n${renderRow(row)}\n`;
  }
  const key = `${row.date} ${String(row.startMin).padStart(4, "0")}`;
  const after = found.filter((r) => `${r.date} ${String(r.startMin).padStart(4, "0")}` <= key).pop();
  // Insert after the last earlier row, or after the separator; a table with
  // unparseable rows keeps them where they were.
  const at = after ? after.line + 1 : head + 2;
  lines.splice(at, 0, renderRow(row));
  return lines.join("\n");
}

export function dropRow(owner: string, content: string, id: string): string | null {
  const hit = parseCalendarRows(owner, content).find((r) => r.id === id);
  if (!hit) return null;
  const lines = content.split("\n");
  lines.splice(hit.line, 1);
  return lines.join("\n");
}

/** The calendar owner a note names, if it names one. */
export const ownerOf = (note: IndexedNote): string | null => {
  const v = (note.frontmatter as Record<string, unknown>)["calendar"];
  return typeof v === "string" && v.trim() ? v.trim() : null;
};
/**
 * Calendar notes count only where calendars live. Without this, a note saying
 * `calendar: jules` in any folder a teammate can edit would feed Jules's
 * calendar — an owner can edit everything, so the edit check alone passes.
 */
const inCalendarDir = (path: string, username: string) => path.startsWith(`${CAL_DIR}/`) || path.startsWith(`Personal/${username}/Calendar/`);
const monthOf = (note: IndexedNote): string | null => {
  const v = (note.frontmatter as Record<string, unknown>)["month"];
  const s = typeof v === "string" ? v : v instanceof Date ? v.toISOString().slice(0, 7) : "";
  return /^\d{4}-\d{2}$/.test(s) ? s : null;
};

export class CalendarNotes {
  constructor(
    private db: Db,
    private store: VaultStore,
  ) {}

  /** Re-read one note's rows into the tables whenever it changes, from anywhere. */
  listen(): void {
    this.store.events.on("note-changed", ({ noteId }: { noteId: string }) => {
      const note = this.store.index.get(noteId);
      if (note) this.sync(note);
    });
    this.store.events.on("note-removed", ({ noteId }: { noteId: string }) => this.clear(noteId));
  }

  /** Boot: every calendar note in the vault into the tables. */
  rebuildAll(): void {
    for (const note of this.store.index.all()) if (ownerOf(note)) this.sync(note);
  }

  private clear(noteId: string): void {
    this.db.delete(tables.events).where(eq(tables.events.calNoteId, noteId)).run();
    this.db.delete(tables.taskBlocks).where(eq(tables.taskBlocks.calNoteId, noteId)).run();
  }

  /** File → tables for one note. A note that stopped being a calendar loses its rows. */
  sync(note: IndexedNote): void {
    const username = ownerOf(note);
    const had =
      this.db.select({ id: tables.events.id }).from(tables.events).where(eq(tables.events.calNoteId, note.id)).get() ??
      this.db.select({ id: tables.taskBlocks.id }).from(tables.taskBlocks).where(eq(tables.taskBlocks.calNoteId, note.id)).get();
    if (!username) {
      if (had) this.clear(note.id);
      return;
    }
    const owner = this.db.select().from(tables.users).where(eq(tables.users.username, username)).get();
    const grants = this.store.grants();
    const acl = owner ? this.store.aclUser(owner.id) : null;
    const rows = acl && inCalendarDir(note.path, username) && canEdit(acl, note, grants) ? parseCalendarRows(username, note.content) : [];

    // createdAt survives a re-read; ids taken by another note's rows (a copied
    // calendar note) are this note's problem, not a crash.
    const created = new Map<string, number>();
    for (const r of this.db.select().from(tables.events).where(eq(tables.events.calNoteId, note.id)).all()) created.set(r.id, r.createdAt);
    for (const r of this.db.select().from(tables.taskBlocks).where(eq(tables.taskBlocks.calNoteId, note.id)).all()) created.set(r.id, r.createdAt);
    this.clear(note.id);
    // Taken = held by ANOTHER note. A row with no note is a legacy DB-only row
    // being adopted into this one (adoptLegacyRows): replace it, keep its age.
    const taken = (id: string) => {
      for (const t of [tables.events, tables.taskBlocks] as const) {
        const hit = this.db.select({ cal: t.calNoteId, createdAt: t.createdAt }).from(t).where(eq(t.id, id)).get();
        if (!hit) continue;
        if (hit.cal) return true;
        created.set(id, hit.createdAt);
        this.db.delete(t).where(eq(t.id, id)).run();
      }
      return false;
    };

    const now = Date.now();
    for (const r of rows) {
      if (taken(r.id)) {
        console.warn(`[calendar] ${note.path}: row ${r.id} is already in another calendar note — skipped`);
        continue;
      }
      const createdAt = created.get(r.id) ?? now;
      if (!r.task) {
        this.db.insert(tables.events).values({ id: r.id, ownerId: owner!.id, title: r.title || "(untitled)", date: r.date, startMin: r.startMin, durationMin: r.durationMin, createdAt, calNoteId: note.id }).run();
        continue;
      }
      const target = this.store.index.getByPath(`${r.task.notePath}.md`) ?? this.store.index.resolveLink(r.task.notePath);
      if (!target || !canEdit(acl!, target, grants) || !target.tasks.some((t) => t.blockId === r.task!.blockId)) continue;
      const obj = this.store.ensureTaskObject(target.id, r.task.blockId);
      this.db.insert(tables.taskBlocks).values({ id: r.id, taskObjectId: obj.id, date: r.date, startMin: r.startMin, durationMin: r.durationMin, createdAt, calNoteId: note.id }).run();
    }
  }

  /** Whether an account other than `user` (owners aside) could read `note` (ACL-009). */
  private exposed(user: AclUser, note: AclNote): boolean {
    const grants = this.store.grants();
    return this.db
      .select()
      .from(tables.users)
      .all()
      .some((u) => u.id !== user.id && !u.isOwner && canRead(this.store.aclUser(u.id), note, grants));
  }

  /** The note holding `user`'s calendar for `month`, created if there is none yet — one no other account can read. */
  private noteFor(user: AclUser, month: string): { path: string; content: string; id: string | null } {
    const mine = this.store.index
      .all()
      .find((n) => ownerOf(n) === user.username && monthOf(n) === month && inCalendarDir(n.path, user.username) && !this.exposed(user, n));
    if (mine) return { path: mine.path, content: mine.content, id: mine.id };
    const grants = this.store.grants();
    const shared: AclNote = { folder: CAL_DIR, onlyTeams: [], shareTeams: [] };
    const dir = canEdit(user, shared, grants) && !this.exposed(user, shared) ? CAL_DIR : `Personal/${user.username}/Calendar`;
    let path = `${dir}/${month}.md`;
    if (this.store.index.getByPath(path)) path = `${dir}/${month} ${user.username}.md`;
    return { path, content: monthNote(user.username, month), id: null };
  }

  /** The note a row currently lives in, or null for a new row. */
  private homeOf(id: string): IndexedNote | null {
    const ev = this.db.select().from(tables.events).where(eq(tables.events.id, id)).get();
    const blk = ev ? null : this.db.select().from(tables.taskBlocks).where(eq(tables.taskBlocks.id, id)).get();
    const noteId = ev?.calNoteId ?? blk?.calNoteId;
    return noteId ? (this.store.index.get(noteId) ?? null) : null;
  }

  /**
   * Write a row (new or changed) into its owner's month note. A row whose date
   * moved to another month leaves its old note for the new one. Writing the
   * note is what updates the tables (see `listen`).
   */
  put(user: AclUser, row: CalRow): void {
    if (!realDay(row.date)) throw new HttpError(400, "date must be a real YYYY-MM-DD day");
    const home = this.homeOf(row.id);
    const month = row.date.slice(0, 7);
    // A row in a note others can read moves to one they cannot when it is next written (ACL-009).
    if (home && monthOf(home) === month && ownerOf(home) === user.username && !this.exposed(user, home)) {
      this.store.write(user, home.path, placeRow(user.username, home.content, row));
      return;
    }
    // Out of the old note first: while it still holds the id, the new note's
    // re-read would see the id as taken by another note and skip the row.
    if (home) {
      const left = dropRow(ownerOf(home) ?? user.username, home.content, row.id);
      if (left !== null) this.store.write(user, home.path, left);
    }
    const target = this.noteFor(user, month);
    this.store.write(user, target.path, placeRow(user.username, target.content, row));
  }

  /** Take a row out of its note. */
  remove(user: AclUser, id: string): void {
    const home = this.homeOf(id);
    if (!home) throw new HttpError(404, "not on any calendar");
    const left = dropRow(ownerOf(home) ?? user.username, home.content, id);
    if (left !== null) this.store.write(user, home.path, left);
    else this.sync(home); // already gone from the file: the index just catches up
  }

  /**
   * One-shot (see migrations.ts): rows from before the calendar lived in the
   * vault — `cal_note_id` NULL — are written into their owner's notes. A
   * block belongs to its task's assignee, or else the workspace owner.
   */
  adoptLegacyRows(): number {
    let n = 0;
    const firstOwner = this.db.select().from(tables.users).where(eq(tables.users.isOwner, true)).get();
    for (const ev of this.db.select().from(tables.events).where(isNull(tables.events.calNoteId)).all()) {
      try {
        this.put(this.store.aclUser(ev.ownerId), { id: ev.id, date: ev.date, startMin: ev.startMin, durationMin: ev.durationMin, title: ev.title, task: null });
        n++;
      } catch (err) {
        console.error(`[migrate] event ${ev.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const legacyBlocks = this.db
      .select({ block: tables.taskBlocks, obj: tables.taskObjects })
      .from(tables.taskBlocks)
      .innerJoin(tables.taskObjects, eq(tables.taskBlocks.taskObjectId, tables.taskObjects.id))
      .where(isNull(tables.taskBlocks.calNoteId))
      .all();
    for (const { block, obj } of legacyBlocks) {
      const note = this.store.index.get(obj.noteId);
      const task = note?.tasks.find((t) => t.blockId === obj.blockId);
      const ownerId = obj.assigneeId ?? firstOwner?.id;
      if (!note || !task || !ownerId) {
        console.warn(`[migrate] block ${block.id}: its task line is gone — left out of the calendar notes`);
        continue;
      }
      try {
        this.put(this.store.aclUser(ownerId), {
          id: block.id,
          date: block.date,
          startMin: block.startMin,
          durationMin: block.durationMin,
          title: task.text,
          task: { notePath: note.path.replace(/\.md$/i, ""), blockId: obj.blockId },
        });
        n++;
      } catch (err) {
        console.error(`[migrate] block ${block.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // A row that could not be written stays as it was (DB-only) and was logged
    // above; deleting it would lose it outright.
    return n;
  }
}
