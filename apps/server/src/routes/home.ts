/**
 * Personal dashboard aggregates — one call that powers the Dashboard tab. Every
 * number is a view over the requester's readable vault (ACL-filtered like all
 * else): counts, a 14-day activity sparkline from note mtimes, this week's
 * booked hours, today's agenda (own events + task blocks), and the tasks most
 * worth doing next. Category colouring stays client-side (categories.ts).
 */
import { and, eq, gte, inArray, lte } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { tables, type Db } from "../db.js";
import type { VaultStore } from "../vaultStore.js";

const iso = (d: Date) => d.toISOString().slice(0, 10);

export async function homeRoutes(app: FastifyInstance, db: Db, store: VaultStore) {
  app.get("/api/home", { preHandler: [app.authenticate] }, async (req) => {
    const user = store.aclUser(req.userId);
    const grants = store.grants();
    const projects = store.projects();
    const notes = store.readable(user);
    const tasks = store.index.tasks(user, grants, projects);

    const open = tasks.filter((t) => !t.checked);
    const done = tasks.filter((t) => t.checked);

    // 14-day activity: readable notes last touched on each day.
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    const trend: { day: string; count: number }[] = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(today.getTime() - i * 86_400_000);
      const key = iso(d);
      trend.push({ day: key, count: notes.filter((n) => n.mtimeMs && iso(new Date(n.mtimeMs)) === key).length });
    }

    // This week's booked hours (my task blocks Mon–Sun).
    const monday = new Date(today);
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
    const sunday = new Date(monday.getTime() + 6 * 86_400_000);
    const myObjects = db.select().from(tables.taskObjects).where(eq(tables.taskObjects.assigneeId, user.id)).all();
    const myObjIds = myObjects.map((o) => o.id);
    const weekBlocks =
      myObjIds.length > 0
        ? db
            .select()
            .from(tables.taskBlocks)
            .where(and(inArray(tables.taskBlocks.taskObjectId, myObjIds), gte(tables.taskBlocks.date, iso(monday)), lte(tables.taskBlocks.date, iso(sunday))))
            .all()
        : [];
    const weekHours = Math.round((weekBlocks.reduce((s, b) => s + b.durationMin, 0) / 60) * 10) / 10;

    // Agenda for the next 7 days: my events + my task blocks, dated and sorted.
    const todayKey = iso(today);
    const weekEndKey = iso(new Date(today.getTime() + 6 * 86_400_000));
    const objById = new Map(myObjects.map((o) => [o.id, o]));
    const rangeBlocks = myObjIds.length
      ? db
          .select()
          .from(tables.taskBlocks)
          .where(and(inArray(tables.taskBlocks.taskObjectId, myObjIds), gte(tables.taskBlocks.date, todayKey), lte(tables.taskBlocks.date, weekEndKey)))
          .all()
      : [];
    const rangeEvents = db
      .select()
      .from(tables.events)
      .where(and(eq(tables.events.ownerId, user.id), gte(tables.events.date, todayKey), lte(tables.events.date, weekEndKey)))
      .all();
    const agenda = [
      ...rangeEvents.map((e) => ({ kind: "event" as const, date: e.date, title: e.title, startMin: e.startMin, durationMin: e.durationMin, noteId: null as string | null })),
      ...rangeBlocks.map((b) => {
        const obj = objById.get(b.taskObjectId);
        const note = obj ? store.index.get(obj.noteId) : undefined;
        const line = note?.tasks.find((t) => t.blockId === obj?.blockId);
        return { kind: "task" as const, date: b.date, title: line?.text ?? note?.title ?? "Task", startMin: b.startMin, durationMin: b.durationMin, noteId: note?.id ?? null };
      }),
    ].sort((a, b) => a.date.localeCompare(b.date) || a.startMin - b.startMin);

    // Focus: the open tasks most worth doing next.
    const todayStr = iso(today);
    const focus = [...open]
      .sort(
        (a, b) =>
          (a.priority ?? 4) - (b.priority ?? 4) ||
          (a.due ?? "9999").localeCompare(b.due ?? "9999") ||
          a.noteTitle.localeCompare(b.noteTitle),
      )
      .slice(0, 6)
      .map((t) => ({
        noteId: t.noteId,
        noteTitle: t.noteTitle,
        line: t.line,
        text: t.text,
        project: t.project,
        due: t.due ?? null,
        priority: t.priority ?? null,
        assignee: t.assignee ?? null,
        overdue: !!t.due && t.due < todayStr,
      }));

    return {
      user: { displayName: db.select().from(tables.users).where(eq(tables.users.id, user.id)).get()?.displayName ?? user.username, username: user.username },
      stats: {
        notes: notes.length,
        openTasks: open.length,
        doneTasks: done.length,
        weekHours,
      },
      trend,
      agenda,
      focus,
    };
  });
}
