/**
 * The calendar: task time-blocks and events (meetings etc.).
 *
 * A task's estimate is a budget; blocks spend it. Dropping a task books a
 * default 2h block (capped by what's still unscheduled); the remainder stays
 * in the backlog until it's placed too. Events are personal rows — visible to
 * teammates who overlay your lane, like any shared work calendar.
 */
import crypto from "node:crypto";
import { and, eq, gte, lte } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { advance, isoLocal, nextCharge, parseSubscriptions, projectName, promoteTaskLine } from "@basalt/core";
import type { CalendarNotes } from "../calendarNotes.js";
import { tables, type Db } from "../db.js";
import { financeNote } from "./finance.js";
import { icsEventsFor } from "./ics.js";
import { HttpError, type VaultStore } from "../vaultStore.js";
import { projectNoteFor } from "./projects.js";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const SNAP = 30;
export const DEFAULT_BLOCK_MIN = 120;

const snap = (min: number) => Math.round(min / SNAP) * SNAP;
/** Snap to the half hour and keep the slot inside the day. */
export const clampSlot = (startMin: number, durationMin: number) => {
  const start = Math.max(0, Math.min(snap(startMin), 24 * 60 - SNAP));
  const duration = Math.max(SNAP, Math.min(snap(durationMin), 24 * 60 - start));
  return { start, duration };
};

/** A dated thing with no time of day: it belongs above the grid, not inside it. */
export interface DayMarker {
  id: string;
  kind: "due" | "milestone" | "charge" | "income";
  date: string;
  title: string;
  noteId: string | null;
  /** Line in the note, for a due task — what makes the chip open its task card. */
  line: number | null;
  /** Project name for work; null for money. */
  source: string | null;
  amount: number | null;
  currency: string | null;
  overdue: boolean;
  priority: number | null;
  /** A `#deadline` task (ParsedTask.key); false for everything else. */
  key: boolean;
}

export async function calendarRoutes(app: FastifyInstance, db: Db, store: VaultStore, calendar: CalendarNotes) {
  const auth = { preHandler: [app.authenticate] };

  const touch = (noteId: string, userId: string) => {
    const note = store.index.get(noteId);
    if (note) store.events.emit("note-changed", { noteId, path: note.path, authorId: userId });
  };

  /** A finite number of minutes, or a 400 — NaN would otherwise sail through the clamp. */
  const mins = (v: unknown, name: string): number => {
    if (typeof v !== "number" || !Number.isFinite(v)) throw new HttpError(400, `${name} must be a number of minutes`);
    return v;
  };
  const optMins = (v: unknown, name: string) => (v === undefined ? undefined : mins(v, name));
  const taskPath = (notePath: string) => notePath.replace(/\.md$/i, "");

  /**
   * Book a block of a task onto the calendar (auto-promoting the checkbox). The
   * block is a row in the booker's calendar note (calendarNotes.ts); writing
   * that note is what puts it in the table this returns from.
   */
  app.post("/api/tasks/blocks", auth, async (req) => {
    const body = (req.body ?? {}) as {
      noteId?: string;
      line?: number;
      blockId?: string;
      date?: string;
      startMin?: number;
      durationMin?: number;
      estimateHours?: number;
    };
    if (!body.noteId || (body.line === undefined && !body.blockId)) throw new HttpError(400, "noteId and line or blockId required");
    if (!body.date || !DAY_RE.test(body.date)) throw new HttpError(400, "date must be YYYY-MM-DD");
    const startMin = mins(body.startMin, "startMin");
    const durationMin = optMins(body.durationMin, "durationMin");
    const user = store.aclUser(req.userId);
    const note = store.requireEditable(user, body.noteId);

    let taskBlockId = body.blockId;
    if (!taskBlockId) {
      const res = promoteTaskLine(note.content, body.line!);
      if (!res) throw new HttpError(409, "line is not a task");
      if (res.content !== note.content) store.write(user, note.path, res.content);
      taskBlockId = res.blockId;
    }
    const task = store.index.get(note.id)?.tasks.find((t) => t.blockId === taskBlockId);
    if (!task) throw new HttpError(409, "task line no longer exists");
    const obj = store.ensureTaskObject(note.id, taskBlockId);

    // Default 2h, capped by whatever of the estimate is still unscheduled.
    const existing = db.select().from(tables.taskBlocks).where(eq(tables.taskBlocks.taskObjectId, obj.id)).all();
    const scheduledMin = existing.reduce((s, b) => s + b.durationMin, 0);
    const estimateMin = Math.round((typeof body.estimateHours === "number" && Number.isFinite(body.estimateHours) ? body.estimateHours : 2) * 60);
    const remaining = Math.max(estimateMin - scheduledMin, SNAP);
    const { start, duration } = clampSlot(startMin, durationMin ?? Math.min(DEFAULT_BLOCK_MIN, remaining));

    const id = `blk-${crypto.randomUUID().slice(0, 8)}`;
    calendar.put(user, { id, date: body.date, startMin: start, durationMin: duration, title: task.text, task: { notePath: taskPath(note.path), blockId: taskBlockId } });
    const block = db.select().from(tables.taskBlocks).where(eq(tables.taskBlocks.id, id)).get();
    if (!block) throw new HttpError(409, "the block could not be put on your calendar");
    touch(note.id, user.id);
    return { ...block, taskObject: obj };
  });

  app.patch<{ Params: { id: string } }>("/api/blocks/:id", auth, async (req) => {
    const body = (req.body ?? {}) as { date?: string; startMin?: number; durationMin?: number };
    const block = db.select().from(tables.taskBlocks).where(eq(tables.taskBlocks.id, req.params.id)).get();
    if (!block) throw new HttpError(404, "block not found");
    const obj = db.select().from(tables.taskObjects).where(eq(tables.taskObjects.id, block.taskObjectId)).get();
    if (!obj) throw new HttpError(404, "task not found");
    const user = store.aclUser(req.userId);
    const note = store.requireEditable(user, obj.noteId);
    if (body.date !== undefined && !DAY_RE.test(body.date)) throw new HttpError(400, "bad date");
    const { start, duration } = clampSlot(optMins(body.startMin, "startMin") ?? block.startMin, optMins(body.durationMin, "durationMin") ?? block.durationMin);
    const text = note.tasks.find((t) => t.blockId === obj.blockId)?.text ?? "";
    calendar.put(user, { id: block.id, date: body.date ?? block.date, startMin: start, durationMin: duration, title: text, task: { notePath: taskPath(note.path), blockId: obj.blockId } });
    touch(obj.noteId, user.id);
    return db.select().from(tables.taskBlocks).where(eq(tables.taskBlocks.id, block.id)).get();
  });

  app.delete<{ Params: { id: string } }>("/api/blocks/:id", auth, async (req) => {
    const block = db.select().from(tables.taskBlocks).where(eq(tables.taskBlocks.id, req.params.id)).get();
    if (!block) throw new HttpError(404, "block not found");
    const obj = db.select().from(tables.taskObjects).where(eq(tables.taskObjects.id, block.taskObjectId)).get();
    const user = store.aclUser(req.userId);
    if (obj) store.requireEditable(user, obj.noteId);
    calendar.remove(user, block.id);
    if (obj) touch(obj.noteId, user.id);
    return { ok: true };
  });

  // ---- events (meetings etc.) ----------------------------------------------

  app.post("/api/events", auth, async (req) => {
    const body = (req.body ?? {}) as { title?: string; date?: string; startMin?: number; durationMin?: number };
    if (typeof body.title !== "string" || !body.title.trim() || body.title.length > 140) throw new HttpError(400, "title required (max 140)");
    if (!body.date || !DAY_RE.test(body.date)) throw new HttpError(400, "date must be YYYY-MM-DD");
    const { start, duration } = clampSlot(mins(body.startMin, "startMin"), optMins(body.durationMin, "durationMin") ?? 60);
    const id = `ev-${crypto.randomUUID().slice(0, 8)}`;
    calendar.put(store.aclUser(req.userId), { id, title: body.title.trim(), date: body.date, startMin: start, durationMin: duration, task: null });
    const event = db.select().from(tables.events).where(eq(tables.events.id, id)).get();
    if (!event) throw new HttpError(409, "the event could not be put on your calendar");
    return event;
  });

  app.patch<{ Params: { id: string } }>("/api/events/:id", auth, async (req) => {
    const body = (req.body ?? {}) as { title?: string; date?: string; startMin?: number; durationMin?: number };
    const event = db.select().from(tables.events).where(eq(tables.events.id, req.params.id)).get();
    if (!event) throw new HttpError(404, "event not found");
    if (event.ownerId !== req.userId) throw new HttpError(403, "only the owner can edit an event");
    const { start, duration } = clampSlot(optMins(body.startMin, "startMin") ?? event.startMin, optMins(body.durationMin, "durationMin") ?? event.durationMin);
    calendar.put(store.aclUser(req.userId), {
      id: event.id,
      title: typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, 140) : event.title,
      date: body.date && DAY_RE.test(body.date) ? body.date : event.date,
      startMin: start,
      durationMin: duration,
      task: null,
    });
    return db.select().from(tables.events).where(eq(tables.events.id, event.id)).get();
  });

  app.delete<{ Params: { id: string } }>("/api/events/:id", auth, async (req) => {
    const event = db.select().from(tables.events).where(eq(tables.events.id, req.params.id)).get();
    if (!event) throw new HttpError(404, "event not found");
    if (event.ownerId !== req.userId) throw new HttpError(403, "only the owner can delete an event");
    calendar.remove(store.aclUser(req.userId), event.id);
    return { ok: true };
  });

  /**
   * Your events in a date range. Only yours: an event has no note and no team,
   * so nothing in the ACL could say who else may see it, and this used to hand
   * every account every other account's calendar (audit). The dashboard, the
   * planner and the ICS feed already filtered by owner; this was the one that
   * did not. `mine` stays for the client, and is now always true.
   */
  app.get<{ Querystring: { from?: string; to?: string } }>("/api/events", auth, async (req) => {
    const { from, to } = req.query;
    if (!from || !to || !DAY_RE.test(from) || !DAY_RE.test(to)) throw new HttpError(400, "from/to required (YYYY-MM-DD)");
    const rows = db
      .select({
        id: tables.events.id,
        title: tables.events.title,
        date: tables.events.date,
        startMin: tables.events.startMin,
        durationMin: tables.events.durationMin,
        ownerId: tables.events.ownerId,
        username: tables.users.username,
      })
      .from(tables.events)
      .innerJoin(tables.users, eq(tables.events.ownerId, tables.users.id))
      .where(and(eq(tables.events.ownerId, req.userId), gte(tables.events.date, from), lte(tables.events.date, to)))
      .all();
    const own = rows.map((r) => ({ ...r, mine: r.ownerId === req.userId }));
    // Subscribed external calendars (Google/Outlook/uni ICS): read-only layer,
    // returned only to the feed's owner — an external calendar is personal.
    const me = db.select().from(tables.users).where(eq(tables.users.id, req.userId)).get();
    const ics = me ? await icsEventsFor(db, req.userId, me.username, from, to) : [];
    return [...own, ...ics];
  });

  /**
   * Day markers: everything the vault has *dated* that is not an appointment.
   *
   * The grid used to draw blocks and events only, so a week with no meetings was
   * a blank 24-hour rectangle while the same vault held 44 dated tasks, a thesis
   * deadline and a subscription charge. None of these have a time of day, so
   * they are not calendar items — they are the band above the grid, the same
   * four sources the Dashboard agenda already unifies:
   *
   *   due        an open task's `due:` — the reason a week is busy at all
   *   milestone  a project's `start:`/`deadline:` front-matter
   *   charge     a subscription's next payment, expanded across the range
   *   income     the other ledger, same parser
   *
   * Money is expanded rather than taken from `next` alone: `next` is the one
   * charge after today, and a month view spans six weeks — a weekly charge owes
   * six marks, not one.
   */
  app.get<{ Querystring: { from?: string; to?: string } }>("/api/calendar/markers", auth, async (req) => {
    const { from, to } = req.query;
    if (!from || !to || !DAY_RE.test(from) || !DAY_RE.test(to)) throw new HttpError(400, "from/to required (YYYY-MM-DD)");
    const user = store.aclUser(req.userId);
    const today = isoLocal();
    const inRange = (d: string) => d >= from && d <= to;
    const out: DayMarker[] = [];

    for (const t of store.index.tasks(user, store.grants(), store.projects())) {
      if (t.checked || !t.due || !inRange(t.due)) continue;
      out.push({
        id: `due-${t.noteId}-${t.line}`,
        kind: "due",
        date: t.due,
        title: t.text,
        noteId: t.noteId,
        line: t.line,
        source: t.project,
        amount: null,
        currency: null,
        overdue: t.due < today,
        priority: t.priority ?? null,
        key: !!t.key,
      });
    }

    // Project milestones live in the note's front-matter, so they are read off
    // the note rather than the projects table (which stores neither date).
    const readable = store.readable(user);
    for (const p of db.select().from(tables.projects).all()) {
      if (p.hidden) continue;
      const note = projectNoteFor(readable, p.key);
      if (!note) continue;
      const fm = note.frontmatter as Record<string, unknown>;
      const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
      const name = projectName(note, p.name); // as on the board (COR-004)
      for (const [field, label] of [["start", "starts"], ["deadline", "due"]] as const) {
        const date = str(fm[field]);
        if (!DAY_RE.test(date) || !inRange(date)) continue;
        out.push({
          id: `ms-${p.key}-${field}`,
          kind: "milestone",
          date,
          title: `${name} ${label}`,
          noteId: note.id,
          line: null,
          source: name,
          amount: null,
          currency: null,
          overdue: field === "deadline" && date < today,
          priority: null,
          key: false,
        });
      }
    }

    for (const [kind, sign] of [["charge", -1], ["income", 1]] as const) {
      const ledger = financeNote(store, user, kind === "charge" ? "subscriptions" : "income");
      if (!ledger) continue;
      for (const row of parseSubscriptions(ledger.content, from)) {
        if (!row.next) continue;
        // `nextCharge` rolls a hand-maintained date forward to the first charge
        // that is not before `from`; `advance` walks the rest of the window.
        for (let d = nextCharge(row.next, row.cadence, from), guard = 0; d <= to && guard < 64; d = advance(d, row.cadence), guard++) {
          if (d < from) continue;
          out.push({
            id: `${kind}-${row.service}-${d}`,
            kind,
            date: d,
            title: row.service,
            noteId: ledger.id,
            line: null,
            source: null,
            amount: sign * row.amount,
            currency: row.currency,
            overdue: false,
            priority: null,
          key: false,
          });
        }
      }
    }

    const ORDER: Record<DayMarker["kind"], number> = { milestone: 0, due: 1, charge: 2, income: 3 };
    return out.sort((a, b) => a.date.localeCompare(b.date) || ORDER[a.kind] - ORDER[b.kind] || a.title.localeCompare(b.title));
  });
}
