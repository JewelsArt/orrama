import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { checkTaskSchema, promoteTaskSchema, setTaskStatusSchema, taskDatesSchema, taskPlaceSchema, updateTaskObjectSchema, type SetTaskStatus } from "@basalt/schema";
import type { z } from "zod";
import { locateTask, promoteTaskLine, setTaskDates, setTaskStatus, type AclUser, type ParsedTask, type TaskLineRef } from "@basalt/core";
import { tables, type Db } from "../db.js";
import { HttpError, type VaultStore } from "../vaultStore.js";

type TaskDates = z.infer<typeof taskDatesSchema>;

/** What a 409 says when the task a client named is not in the note as it is now. */
export const TASK_GONE = "that task is not in the note as it is now — reload and try again";

/**
 * The task a request names, in the note as it is NOW (audit COR-001): by block
 * id, else by its text with the line as a hint — never by a line alone, which
 * the schemas already refuse. A 409 when it is gone or ambiguous; the client
 * reloads and asks again rather than edit the task that moved into its place.
 */
export function requireTask(content: string, ref: TaskLineRef): ParsedTask {
  const task = locateTask(content, ref);
  if (!task) throw new HttpError(409, TASK_GONE);
  return task;
}

/**
 * Set a task's board status (shared by the /api/tasks/status route and the AI
 * agent's set_task_status tool). Every status is the checkbox — `[ ]`, `[/]`,
 * `[b]`, `[x]` — so it is an edit to the file, and a promoted task object
 * follows it through reconcileTaskObjects. In-progress and blocked used to be
 * DB-only and were lost with the database (audit B10).
 */
export function applyTaskStatus(_db: Db, store: VaultStore, user: AclUser, body: SetTaskStatus) {
  const note = store.requireEditable(user, body.noteId);
  const task = requireTask(note.content, body);
  const saved = store.write(user, note.path, setTaskStatus(note.content, body, body.status)!);
  if (body.status === "done" && task.status !== "done") {
    store.events.emit("task-completed", { noteId: saved.id, path: note.path, authorId: user.id, blockId: task.blockId ?? null, text: task.text });
  }
  return { status: body.status, ...(task.blockId ? { blockId: task.blockId } : {}) };
}

/**
 * Set or clear a task's start:/due: on its line (and a promoted task's
 * object due). Shared by POST /api/tasks/dates and the agent's
 * set_task_dates, which had its own copy that skipped the YYYY-MM-DD check:
 * "next friday" went into the task's title, a newline moved its block id
 * to another line (audit AI-011). The body is taskDatesSchema's, parsed.
 */
export function applyTaskDates(db: Db, store: VaultStore, user: AclUser, body: TaskDates) {
  const note = store.requireEditable(user, body.noteId);
  const task = requireTask(note.content, body);
  const saved = store.write(user, note.path, setTaskDates(note.content, body, { start: body.start, due: body.due })!);
  // Keep a promoted object's due in sync so both views of the task agree.
  if (body.due !== undefined && task.blockId) {
    const obj = store.taskObjectByBlock(note.id, task.blockId);
    if (obj) db.update(tables.taskObjects).set({ due: body.due, updatedAt: Date.now() }).where(eq(tables.taskObjects.id, obj.id)).run();
  }
  return { id: saved.id, start: body.start, due: body.due };
}

/**
 * The block id of the task a request names, promoting its checkbox first when
 * it has none (scheduling and booking both need one). Shared by
 * /api/tasks/schedule, /api/tasks/blocks and the agent's schedule_block.
 */
export function promoteNamedTask(store: VaultStore, user: AclUser, note: { path: string; content: string }, ref: TaskLineRef): string {
  const res = promoteTaskLine(note.content, ref);
  if (!res) throw new HttpError(409, TASK_GONE);
  if (res.content !== note.content) store.write(user, note.path, res.content);
  return res.blockId;
}

export async function taskRoutes(app: FastifyInstance, db: Db, store: VaultStore) {
  const auth = { preHandler: [app.authenticate] };

  /** All tasks visible to the requester, with project + task-object overlay. */
  app.get("/api/tasks", auth, async (req) => {
    const user = store.aclUser(req.userId);
    const tasks = store.index.tasks(user, store.grants(), store.projects(user));
    const objects = db.select().from(tables.taskObjects).all();
    const objByKey = new Map(objects.map((o) => [`${o.noteId}:${o.blockId}`, o]));
    return tasks.map((t) => ({
      ...t,
      object: t.blockId ? (objByKey.get(`${t.noteId}:${t.blockId}`) ?? null) : null,
    }));
  });

  /**
   * Check/uncheck from anywhere (dashboard included): this EDITS THE FILE through
   * the normal write path — the Markdown stays the source of truth (spec §6.2).
   */
  app.post("/api/tasks/check", auth, async (req) => {
    const body = checkTaskSchema.parse(req.body);
    const user = store.aclUser(req.userId);
    const note = store.requireEditable(user, body.noteId);
    const task = requireTask(note.content, body);
    const saved = store.write(user, note.path, setTaskStatus(note.content, body, body.checked ? "done" : "todo")!);
    if (body.checked) {
      store.events.emit("task-completed", {
        noteId: saved.id, path: note.path, authorId: user.id,
        blockId: task.blockId ?? null, text: task.text,
      });
    }
    return { id: saved.id, checked: body.checked };
  });

  /** Set a task's board status from the Overview dropdown: a checkbox edit (see applyTaskStatus). */
  app.post("/api/tasks/status", auth, async (req) => {
    const body = setTaskStatusSchema.parse(req.body);
    return applyTaskStatus(db, store, store.aclUser(req.userId), body);
  });

  /**
   * Set/clear a task's start:/due: tokens (Gantt drag, resize, and scheduling
   * from the unscheduled strip). Like /check, this EDITS THE FILE — the dates
   * live on the Markdown line and survive a re-index (spec §7).
   */
  app.post("/api/tasks/dates", auth, async (req) => applyTaskDates(db, store, store.aclUser(req.userId), taskDatesSchema.parse(req.body)));

  /** Promote a checkbox to a task object (spec §7.2). */
  app.post("/api/tasks/promote", auth, async (req) => {
    const body = promoteTaskSchema.parse(req.body);
    const user = store.aclUser(req.userId);
    const note = store.requireEditable(user, body.noteId);
    const blockId = promoteNamedTask(store, user, note, body);
    let obj = store.taskObjectByBlock(note.id, blockId);
    if (!obj) {
      const parsed = store.index.get(note.id)!.tasks.find((t) => t.blockId === blockId);
      const assignee = parsed?.assignee
        ? db.select().from(tables.users).where(eq(tables.users.username, parsed.assignee)).get()
        : undefined;
      const now = Date.now();
      const fresh = {
        id: `task-${crypto.randomUUID().slice(0, 8)}`,
        noteId: note.id,
        blockId,
        status: parsed?.status ?? "todo",
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
    return obj;
  });

  /**
   * Put a task on a calendar day (or take it off with date:null). Auto-promotes
   * the checkbox so the schedule survives line moves — the file keeps the task,
   * the object keeps the plan.
   */
  app.post("/api/tasks/schedule", auth, async (req) => {
    const body = taskPlaceSchema.parse(req.body);
    const date = (req.body as { date?: unknown }).date as string | null | undefined;
    if (date && (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date))) throw new HttpError(400, "date must be YYYY-MM-DD");
    const user = store.aclUser(req.userId);
    const note = store.requireEditable(user, body.noteId);

    const blockId = promoteNamedTask(store, user, note, body);
    let obj = store.taskObjectByBlock(note.id, blockId);
    const now = Date.now();
    if (!obj) {
      const parsed = store.index.get(note.id)!.tasks.find((t) => t.blockId === blockId);
      const assignee = parsed?.assignee
        ? db.select().from(tables.users).where(eq(tables.users.username, parsed.assignee)).get()
        : undefined;
      const fresh = {
        id: `task-${crypto.randomUUID().slice(0, 8)}`,
        noteId: note.id,
        blockId,
        status: parsed?.status ?? "todo",
        assigneeId: assignee?.id ?? null,
        due: parsed?.due ?? null,
        plannedDate: date ?? null,
        description: "",
        createdAt: now,
        updatedAt: now,
      };
      db.insert(tables.taskObjects).values(fresh).run();
      obj = fresh;
    } else {
      db.update(tables.taskObjects)
        .set({ plannedDate: date ?? null, updatedAt: now })
        .where(eq(tables.taskObjects.id, obj.id))
        .run();
      obj = { ...obj, plannedDate: date ?? null };
    }
    store.events.emit("note-changed", { noteId: note.id, path: note.path, authorId: user.id });
    return obj;
  });

  /** Update a task object. A status change is written into the checkbox (two-way binding §7.2). */
  app.patch<{ Params: { id: string } }>("/api/tasks/:id", auth, async (req) => {
    const body = updateTaskObjectSchema.parse(req.body);
    const user = store.aclUser(req.userId);
    const obj = db.select().from(tables.taskObjects).where(eq(tables.taskObjects.id, req.params.id)).get();
    if (!obj) throw new HttpError(404, "task not found");
    const note = store.requireEditable(user, obj.noteId);

    if (body.status && body.status !== "orphaned" && body.status !== obj.status) {
      const updated = setTaskStatus(note.content, { blockId: obj.blockId }, body.status);
      if (updated !== null) store.write(user, note.path, updated); // file edit through CRDT
      if (body.status === "done") {
        const parsed = store.index.get(obj.noteId)?.tasks.find((t) => t.blockId === obj.blockId);
        store.events.emit("task-completed", {
          noteId: obj.noteId, path: note.path, authorId: user.id, blockId: obj.blockId, text: parsed?.text ?? "",
        });
      }
    }
    db.update(tables.taskObjects)
      .set({
        ...(body.status ? { status: body.status } : {}),
        ...(body.assigneeId !== undefined ? { assigneeId: body.assigneeId } : {}),
        ...(body.due !== undefined ? { due: body.due } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        updatedAt: Date.now(),
      })
      .where(eq(tables.taskObjects.id, obj.id))
      .run();
    return db.select().from(tables.taskObjects).where(eq(tables.taskObjects.id, obj.id)).get();
  });

  /** Comment thread on a promoted task (§7.2). */
  app.post<{ Params: { id: string } }>("/api/tasks/:id/comments", auth, async (req) => {
    const body = (req.body ?? {}) as { body?: string };
    if (!body.body || body.body.length > 10_000) throw new HttpError(400, "comment body required");
    const obj = db.select().from(tables.taskObjects).where(eq(tables.taskObjects.id, req.params.id)).get();
    if (!obj) throw new HttpError(404, "task not found");
    store.requireReadable(store.aclUser(req.userId), obj.noteId);
    const comment = {
      id: `c-${crypto.randomUUID().slice(0, 8)}`,
      taskId: obj.id,
      authorId: req.userId,
      body: body.body,
      createdAt: Date.now(),
    };
    db.insert(tables.taskComments).values(comment).run();
    return comment;
  });

  app.get<{ Params: { id: string } }>("/api/tasks/:id/comments", auth, async (req) => {
    const obj = db.select().from(tables.taskObjects).where(eq(tables.taskObjects.id, req.params.id)).get();
    if (!obj) throw new HttpError(404, "task not found");
    store.requireReadable(store.aclUser(req.userId), obj.noteId);
    return db.select().from(tables.taskComments).where(eq(tables.taskComments.taskId, obj.id)).all();
  });
}
