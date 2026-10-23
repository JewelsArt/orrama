/**
 * The calendar: task time-blocks and events (meetings etc.).
 *
 * A task's estimate is a budget; blocks spend it. Dropping a task books a
 * default 2h block (capped by what's still unscheduled); the remainder stays
 * in the backlog until it's placed too. Events are personal rows — visible to
 * teammates who overlay your lane, like any shared work calendar.
 */
import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { chargeDates, isoLocal, parseSubscriptions, type AclUser } from "@orrama/core";
import { eventWriteSchema, taskPlaceSchema } from "@orrama/schema";
import type { z } from "zod";
import { ownEvents, parseRepeat, repeatCell, seriesOf, type CalendarNotes, type CalRow } from "../calendarNotes.js";
import { tables, type Db } from "../db.js";
import { financeNote } from "./finance.js";
import { expandIcsReport, ownVEvent } from "../ics.js";
import { icsEventsFor } from "./ics.js";
import { HttpError, type VaultStore } from "../vaultStore.js";
import { promoteNamedTask } from "./tasks.js";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
type TaskPlace = z.infer<typeof taskPlaceSchema>;
type EventWrite = z.infer<typeof eventWriteSchema>;
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

/**
 * Book a block of a task onto the booker's calendar: promote the checkbox,
 * then write the row into their calendar note (calendarNotes.ts), which is
 * what puts it in task_blocks. The one way a task is scheduled — Planning's
 * route, the in-app agent and (through that route) the MCP server — so they
 * cannot drift apart again: MCP's schedule_block once set only the DB-only
 * planned_date, and nothing appeared on any calendar (audit AI-005).
 * `durationMin` defaults to 2h, capped by what of the estimate is unbooked.
 */
export function bookTaskBlock(
  db: Db,
  store: VaultStore,
  calendar: CalendarNotes,
  user: AclUser,
  ref: TaskPlace,
  slot: { date: string; startMin: number; durationMin?: number; estimateHours?: number },
) {
  const note = store.requireEditable(user, ref.noteId);
  const taskBlockId = promoteNamedTask(store, user, note, ref);
  const task = store.index.get(note.id)?.tasks.find((t) => t.blockId === taskBlockId);
  if (!task) throw new HttpError(409, "task line no longer exists");
  const taskObject = store.ensureTaskObject(note.id, taskBlockId);

  const existing = db.select().from(tables.taskBlocks).where(eq(tables.taskBlocks.taskObjectId, taskObject.id)).all();
  const scheduledMin = existing.reduce((s, b) => s + b.durationMin, 0);
  const estimateMin = Math.round((typeof slot.estimateHours === "number" && Number.isFinite(slot.estimateHours) ? slot.estimateHours : 2) * 60);
  const remaining = Math.max(estimateMin - scheduledMin, SNAP);
  const { start, duration } = clampSlot(slot.startMin, slot.durationMin ?? Math.min(DEFAULT_BLOCK_MIN, remaining));

  const id = `blk-${crypto.randomUUID().slice(0, 8)}`;
  calendar.put(user, { id, date: slot.date, startMin: start, durationMin: duration, title: task.text, task: { notePath: note.path.replace(/\.md$/i, ""), blockId: taskBlockId } });
  const block = db.select().from(tables.taskBlocks).where(eq(tables.taskBlocks.id, id)).get();
  if (!block) throw new HttpError(409, "the block could not be put on your calendar");
  const fresh = store.index.get(note.id);
  if (fresh) store.events.emit("note-changed", { noteId: note.id, path: fresh.path, authorId: user.id });
  return { block, taskObject };
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
      text?: string;
      date?: string;
      startMin?: number;
      durationMin?: number;
      estimateHours?: number;
    };
    const ref = taskPlaceSchema.parse(body);
    if (!body.date || !DAY_RE.test(body.date)) throw new HttpError(400, "date must be YYYY-MM-DD");
    const startMin = mins(body.startMin, "startMin");
    const durationMin = optMins(body.durationMin, "durationMin");
    const user = store.aclUser(req.userId);
    const { block, taskObject } = bookTaskBlock(db, store, calendar, user, ref, { date: body.date, startMin, durationMin, estimateHours: body.estimateHours });
    return { ...block, taskObject };
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

  /**
   * Typed minutes kept inside the day, to five minutes: a typed 10:15 stays
   * 10:15 (the hour grid's drag snaps to the half hour itself).
   */
  const fitEvent = (startMin: number, durationMin: number) => {
    const start = Math.max(0, Math.min(Math.round(startMin / 5) * 5, 24 * 60 - 5));
    const duration = Math.max(5, Math.min(Math.round(durationMin / 5) * 5, 24 * 60 - start));
    return { start, duration };
  };

  /** The event's row as its calendar note holds it. */
  const rowOf = (e: typeof tables.events.$inferSelect): CalRow => ({
    id: e.id,
    title: e.title,
    date: e.date,
    startMin: e.startMin,
    durationMin: e.durationMin,
    task: null,
    ...(e.allDay && { allDay: true }),
    ...(e.place && { place: e.place }),
    ...(e.notes && { notes: e.notes }),
    ...(e.repeat && { repeat: e.repeat }),
  });

  /** A row with `change` applied: what was sent replaces what was there; an emptied place or notes goes. */
  const changed = (row: CalRow, change: EventWrite): CalRow => {
    const allDay = change.allDay ?? !!row.allDay;
    // An all-day event given hours again starts at 09:00 for an hour unless told otherwise.
    const { start, duration } = allDay ? { start: 0, duration: 24 * 60 } : fitEvent(change.startMin ?? (row.allDay ? 9 * 60 : row.startMin), change.durationMin ?? (row.allDay ? 60 : row.durationMin));
    const text = (v: string | undefined, was: string | undefined) => (v === undefined ? was : v.trim() || undefined);
    const next: CalRow = { id: row.id, title: change.title ?? row.title, date: change.date ?? row.date, startMin: start, durationMin: duration, task: null };
    if (allDay) next.allDay = true;
    const place = text(change.place, row.place);
    const notes = text(change.notes, row.notes);
    if (place) next.place = place;
    if (notes) next.notes = notes;
    if (row.repeat) next.repeat = row.repeat;
    return next;
  };

  /** The Repeat cell for `repeat` on a series that starts `date`, keeping the days already left out. */
  const repeatFor = (repeat: EventWrite["repeat"], date: string, skip: string[] = []): string | undefined => {
    if (!repeat) return undefined;
    if (repeat.until && repeat.until < date) throw new HttpError(400, "the repeat ends before the event starts");
    return repeatCell({ ...repeat, skip: skip.filter((d) => d > date && (!repeat.until || d <= repeat.until)) });
  };

  /** `ev-1a2b3c4d@2026-10-30` → the event and the day of it; a bare id has no day. */
  const splitId = (raw: string): { id: string; day: string | null } => {
    const at = raw.lastIndexOf("@");
    return at > 0 && DAY_RE.test(raw.slice(at + 1)) ? { id: raw.slice(0, at), day: raw.slice(at + 1) } : { id: raw, day: null };
  };

  /** Your event by id (or a day of it), or a 404 / 403. */
  const ownEvent = (raw: string, userId: string, verb: string) => {
    const { id, day } = splitId(raw);
    const event = db.select().from(tables.events).where(eq(tables.events.id, id)).get();
    if (!event) throw new HttpError(404, "event not found");
    if (event.ownerId !== userId) throw new HttpError(403, `only the owner can ${verb} an event`);
    const series = parseRepeat(event.repeat);
    // A day that is not one of the series' is no day of it (an old link, a skipped day).
    if (day && series && !expandIcsReport([ownVEvent(seriesOf(event))], day, day).occurrences.some((o) => o.date === day)) throw new HttpError(404, "the event doesn't fall on that day");
    return { event, day: series ? day : null, series };
  };

  const shiftDay = (iso: string, days: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
  const daysFrom = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);

  const eventById = (id: string) => {
    const event = db.select().from(tables.events).where(eq(tables.events.id, id)).get();
    if (!event) throw new HttpError(409, "the event could not be put on your calendar");
    return event;
  };

  app.post("/api/events", auth, async (req) => {
    const body = eventWriteSchema.parse(req.body ?? {});
    if (!body.title) throw new HttpError(400, "title required (max 140)");
    if (!body.date) throw new HttpError(400, "date must be YYYY-MM-DD");
    if (!body.allDay && body.startMin === undefined) throw new HttpError(400, "startMin must be a number of minutes");
    const id = `ev-${crypto.randomUUID().slice(0, 8)}`;
    const row = changed({ id, title: body.title, date: body.date, startMin: body.startMin ?? 9 * 60, durationMin: 60, task: null }, body);
    const repeat = repeatFor(body.repeat, body.date);
    calendar.put(store.aclUser(req.userId), { ...row, ...(repeat && { repeat }) });
    return eventById(id);
  });

  /**
   * Change an event. On a day of a repeating one (`<id>@<day>`), `scope` "one" (the default:
   * a drag moves the one you dragged) leaves that day out of the series and makes it an event
   * of its own with the change; "all" changes the series, and a typed day moves every day of it
   * by as many days. Jules, 23 Oct 2026: "this one" and "all" only, no "this and following".
   */
  app.patch<{ Params: { id: string } }>("/api/events/:id", auth, async (req) => {
    const body = eventWriteSchema.parse(req.body ?? {});
    const { event, day, series } = ownEvent(req.params.id, req.userId, "edit");
    const user = store.aclUser(req.userId);
    const row = rowOf(event);
    if (day && series && body.scope !== "all") {
      const id = `ev-${crypto.randomUUID().slice(0, 8)}`;
      const one = changed({ ...row, id, date: day, repeat: undefined }, { ...body, repeat: undefined });
      // The day of its own first, then out of the series: a crash between shows it twice, never not at all.
      calendar.put(user, one);
      calendar.put(user, { ...row, repeat: repeatCell({ ...series, skip: [...series.skip, day] }) });
      return eventById(id);
    }
    if (day && series) {
      const shift = body.date ? daysFrom(day, body.date) : 0;
      const next = changed(row, { ...body, date: shiftDay(event.date, shift) });
      const skip = series.skip.map((d) => shiftDay(d, shift));
      const repeat = body.repeat === undefined ? repeatFor({ every: series.every, interval: series.interval, until: series.until }, next.date, skip) : repeatFor(body.repeat, next.date, skip);
      calendar.put(user, { ...next, repeat });
      return eventById(event.id);
    }
    const next = changed(row, body);
    const repeat = body.repeat === undefined ? next.repeat : repeatFor(body.repeat, next.date, series?.skip);
    calendar.put(user, { ...next, repeat });
    return eventById(event.id);
  });

  /** Delete an event; on a day of a repeating one, `?scope=one` (the default) leaves that day out, `all` deletes the series. */
  app.delete<{ Params: { id: string }; Querystring: { scope?: string } }>("/api/events/:id", auth, async (req) => {
    const { event, day, series } = ownEvent(req.params.id, req.userId, "delete");
    const user = store.aclUser(req.userId);
    if (day && series && req.query.scope !== "all") calendar.put(user, { ...rowOf(event), repeat: repeatCell({ ...series, skip: [...series.skip, day] }) });
    else calendar.remove(user, event.id);
    return { ok: true };
  });

  /**
   * Your events in a date range, each repeating one expanded to its days (`ownEvents`). Only
   * yours: an event has no note and no team, so nothing in the ACL could say who else may see
   * it, and this used to hand every account every other account's calendar (audit). The
   * dashboard, the planner and the ICS feed already filtered by owner; this was the one that
   * did not. `mine` stays for the client, and is now always true.
   */
  app.get<{ Querystring: { from?: string; to?: string } }>("/api/events", auth, async (req) => {
    const { from, to } = req.query;
    if (!from || !to || !DAY_RE.test(from) || !DAY_RE.test(to)) throw new HttpError(400, "from/to required (YYYY-MM-DD)");
    const me = db.select().from(tables.users).where(eq(tables.users.id, req.userId)).get();
    if (!me) return [];
    const own = ownEvents(db, req.userId, from, to).map((o) => {
      const details = { ...(o.place && { location: o.place }), ...(o.notes && { description: o.notes }) };
      return {
        id: o.id,
        title: o.title,
        date: o.date,
        startMin: o.startMin,
        durationMin: o.durationMin,
        ownerId: req.userId,
        username: me.username,
        mine: true,
        ...(o.allDay && { allDay: true }),
        ...(Object.keys(details).length > 0 && { details }),
        ...(o.repeat && { repeat: o.repeat, seriesId: o.seriesId! }),
      };
    });
    // Subscribed external calendars (Google/Outlook/uni ICS): read-only layer,
    // returned only to the feed's owner — an external calendar is personal.
    const ics = await icsEventsFor(db, req.userId, me.username, from, to);
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

    for (const t of store.index.tasks(user, store.grants(), store.projects(user))) {
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
    // The project's own note, the same whoever asks, among the projects the
    // caller can read (store.projects, audit ACL-002).
    for (const p of store.projects(user)) {
      const note = p.kind === "tag" ? store.projectNote(p.key) : undefined;
      if (!note) continue;
      const fm = note.frontmatter as Record<string, unknown>;
      const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
      const name = p.name; // named by its note, as on the board (COR-004)
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
        if (!row.anchor) continue;
        // Every charge in the window, each counted from the note's own date —
        // chaining `advance` lost a 31st after the first short month, and
        // starting at `next` dropped the charges before it (audit FIN-003).
        for (const d of chargeDates(row.anchor, row.cadence, from, to)) {
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
