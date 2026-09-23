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
import { advance, isoLocal, nextCharge, parseSubscriptions, promoteTaskLine } from "@basalt/core";
import { tables, type Db } from "../db.js";
import { financeNote } from "./finance.js";
import { icsEventsFor } from "./ics.js";
import { HttpError, type VaultStore } from "../vaultStore.js";
import { projectNoteFor } from "./projects.js";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const SNAP = 30;
export const DEFAULT_BLOCK_MIN = 120;

const snap = (min: number) => Math.round(min / SNAP) * SNAP;
const clampSlot = (startMin: number, durationMin: number) => {
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
}

export async function calendarRoutes(app: FastifyInstance, db: Db, store: VaultStore) {
  const auth = { preHandler: [app.authenticate] };

  const touch = (noteId: string, userId: string) => {
    const note = store.index.get(noteId);
    if (note) store.events.emit("note-changed", { noteId, path: note.path, authorId: userId });
  };

  /** Book a block of a task onto the calendar (auto-promoting the checkbox). */
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
    if (body.startMin === undefined) throw new HttpError(400, "startMin required");
    const user = store.aclUser(req.userId);
    const note = store.requireReadable(user, body.noteId);

    let taskBlockId = body.blockId;
    if (!taskBlockId) {
      const res = promoteTaskLine(note.content, body.line!);
      if (!res) throw new HttpError(409, "line is not a task");
      if (res.content !== note.content) store.write(user, note.path, res.content);
      taskBlockId = res.blockId;
    }
    let obj = store.taskObjectByBlock(note.id, taskBlockId);
    if (!obj) {
      const parsed = store.index.get(note.id)!.tasks.find((t) => t.blockId === taskBlockId);
      const assignee = parsed?.assignee
        ? db.select().from(tables.users).where(eq(tables.users.username, parsed.assignee)).get()
        : undefined;
      const now = Date.now();
      const fresh = {
        id: `task-${crypto.randomUUID().slice(0, 8)}`,
        noteId: note.id,
        blockId: taskBlockId,
        status: (parsed?.checked ? "done" : "todo") as "done" | "todo",
        assigneeId: assignee?.id ?? null,
        due: parsed?.due ?? null,
        plannedDate: null,
        description: "",
        createdAt: now,
        updatedAt: now,
      };
      db.insert(tables.taskObjects).values(fresh).run();
      obj = fresh;
    }

    // Default 2h, capped by whatever of the estimate is still unscheduled.
    const existing = db.select().from(tables.taskBlocks).where(eq(tables.taskBlocks.taskObjectId, obj.id)).all();
    const scheduledMin = existing.reduce((s, b) => s + b.durationMin, 0);
    const estimateMin = Math.round((body.estimateHours ?? 2) * 60);
    const remaining = Math.max(estimateMin - scheduledMin, SNAP);
    const requested = body.durationMin ?? Math.min(DEFAULT_BLOCK_MIN, remaining);
    const { start, duration } = clampSlot(body.startMin, requested);

    const block = {
      id: `blk-${crypto.randomUUID().slice(0, 8)}`,
      taskObjectId: obj.id,
      date: body.date,
      startMin: start,
      durationMin: duration,
      createdAt: Date.now(),
    };
    db.insert(tables.taskBlocks).values(block).run();
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
    store.requireReadable(user, obj.noteId);
    if (body.date && !DAY_RE.test(body.date)) throw new HttpError(400, "bad date");
    const { start, duration } = clampSlot(body.startMin ?? block.startMin, body.durationMin ?? block.durationMin);
    db.update(tables.taskBlocks)
      .set({ date: body.date ?? block.date, startMin: start, durationMin: duration })
      .where(eq(tables.taskBlocks.id, block.id))
      .run();
    touch(obj.noteId, user.id);
    return db.select().from(tables.taskBlocks).where(eq(tables.taskBlocks.id, block.id)).get();
  });

  app.delete<{ Params: { id: string } }>("/api/blocks/:id", auth, async (req) => {
    const block = db.select().from(tables.taskBlocks).where(eq(tables.taskBlocks.id, req.params.id)).get();
    if (!block) throw new HttpError(404, "block not found");
    const obj = db.select().from(tables.taskObjects).where(eq(tables.taskObjects.id, block.taskObjectId)).get();
    const user = store.aclUser(req.userId);
    if (obj) store.requireReadable(user, obj.noteId);
    db.delete(tables.taskBlocks).where(eq(tables.taskBlocks.id, block.id)).run();
    if (obj) touch(obj.noteId, user.id);
    return { ok: true };
  });

  // ---- events (meetings etc.) ----------------------------------------------

  app.post("/api/events", auth, async (req) => {
    const body = (req.body ?? {}) as { title?: string; date?: string; startMin?: number; durationMin?: number };
    if (!body.title?.trim() || body.title.length > 140) throw new HttpError(400, "title required (max 140)");
    if (!body.date || !DAY_RE.test(body.date)) throw new HttpError(400, "date must be YYYY-MM-DD");
    if (body.startMin === undefined) throw new HttpError(400, "startMin required");
    const { start, duration } = clampSlot(body.startMin, body.durationMin ?? 60);
    const event = {
      id: `ev-${crypto.randomUUID().slice(0, 8)}`,
      ownerId: req.userId,
      title: body.title.trim(),
      date: body.date,
      startMin: start,
      durationMin: duration,
      createdAt: Date.now(),
    };
    db.insert(tables.events).values(event).run();
    return event;
  });

  app.patch<{ Params: { id: string } }>("/api/events/:id", auth, async (req) => {
    const body = (req.body ?? {}) as { title?: string; date?: string; startMin?: number; durationMin?: number };
    const event = db.select().from(tables.events).where(eq(tables.events.id, req.params.id)).get();
    if (!event) throw new HttpError(404, "event not found");
    if (event.ownerId !== req.userId) throw new HttpError(403, "only the owner can edit an event");
    const { start, duration } = clampSlot(body.startMin ?? event.startMin, body.durationMin ?? event.durationMin);
    db.update(tables.events)
      .set({
        title: body.title?.trim() ? body.title.trim() : event.title,
        date: body.date && DAY_RE.test(body.date) ? body.date : event.date,
        startMin: start,
        durationMin: duration,
      })
      .where(eq(tables.events.id, event.id))
      .run();
    return db.select().from(tables.events).where(eq(tables.events.id, event.id)).get();
  });

  app.delete<{ Params: { id: string } }>("/api/events/:id", auth, async (req) => {
    const event = db.select().from(tables.events).where(eq(tables.events.id, req.params.id)).get();
    if (!event) throw new HttpError(404, "event not found");
    if (event.ownerId !== req.userId) throw new HttpError(403, "only the owner can delete an event");
    db.delete(tables.events).where(eq(tables.events.id, event.id)).run();
    return { ok: true };
  });

  /** Events in a date range, with owner usernames for lane filtering. */
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
      .where(and(gte(tables.events.date, from), lte(tables.events.date, to)))
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
      for (const [field, label] of [["start", "starts"], ["deadline", "due"]] as const) {
        const date = str(fm[field]);
        if (!DAY_RE.test(date) || !inRange(date)) continue;
        out.push({
          id: `ms-${p.key}-${field}`,
          kind: "milestone",
          date,
          title: `${p.name} ${label}`,
          noteId: note.id,
          line: null,
          source: p.name,
          amount: null,
          currency: null,
          overdue: field === "deadline" && date < today,
          priority: null,
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
          });
        }
      }
    }

    const ORDER: Record<DayMarker["kind"], number> = { milestone: 0, due: 1, charge: 2, income: 3 };
    return out.sort((a, b) => a.date.localeCompare(b.date) || ORDER[a.kind] - ORDER[b.kind] || a.title.localeCompare(b.title));
  });
}
