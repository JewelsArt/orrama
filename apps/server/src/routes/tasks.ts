import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { checkTaskSchema, promoteTaskSchema, updateTaskObjectSchema } from "@basalt/schema";
import { promoteTaskLine, setTaskChecked } from "@basalt/core";
import { tables, type Db } from "../db.js";
import { HttpError, type VaultStore } from "../vaultStore.js";

export async function taskRoutes(app: FastifyInstance, db: Db, store: VaultStore) {
  const auth = { preHandler: [app.authenticate] };

  /** All tasks visible to the requester, with project + task-object overlay. */
  app.get("/api/tasks", auth, async (req) => {
    const user = store.aclUser(req.userId);
    const tasks = store.index.tasks(user, store.grants(), store.projects());
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
    const note = store.requireReadable(user, body.noteId);
    const updated = setTaskChecked(note.content, { line: body.line, blockId: body.blockId }, body.checked);
    if (updated === null) throw new HttpError(409, "task line no longer exists");
    const saved = store.write(user, note.path, updated);
    if (body.checked) {
      const parsed = store.index.get(saved.id)?.tasks.find((t) => (body.blockId ? t.blockId === body.blockId : t.line === body.line));
      store.events.emit("task-completed", {
        noteId: saved.id, path: note.path, authorId: user.id,
        blockId: parsed?.blockId ?? body.blockId ?? null, text: parsed?.text ?? "",
      });
    }
    return { id: saved.id, checked: body.checked };
  });

  /** Promote a checkbox to a task object (spec §7.2). */
  app.post("/api/tasks/promote", auth, async (req) => {
    const body = promoteTaskSchema.parse(req.body);
    const user = store.aclUser(req.userId);
    const note = store.requireReadable(user, body.noteId);
    const res = promoteTaskLine(note.content, body.line);
    if (!res) throw new HttpError(409, "line is not a task");
    if (res.content !== note.content) store.write(user, note.path, res.content);
    let obj = store.taskObjectByBlock(note.id, res.blockId);
    if (!obj) {
      const parsed = store.index.get(note.id)!.tasks.find((t) => t.blockId === res.blockId);
      const assignee = parsed?.assignee
        ? db.select().from(tables.users).where(eq(tables.users.username, parsed.assignee)).get()
        : undefined;
      const now = Date.now();
      const fresh = {
        id: `task-${crypto.randomUUID().slice(0, 8)}`,
        noteId: note.id,
        blockId: res.blockId,
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
    return obj;
  });

  /**
   * Put a task on a calendar day (or take it off with date:null). Auto-promotes
   * the checkbox so the schedule survives line moves — the file keeps the task,
   * the object keeps the plan.
   */
  app.post("/api/tasks/schedule", auth, async (req) => {
    const body = (req.body ?? {}) as { noteId?: string; line?: number; blockId?: string; date?: string | null };
    if (!body.noteId || (body.line === undefined && !body.blockId)) throw new HttpError(400, "noteId and line or blockId required");
    if (body.date && !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) throw new HttpError(400, "date must be YYYY-MM-DD");
    const user = store.aclUser(req.userId);
    const note = store.requireReadable(user, body.noteId);

    let blockId = body.blockId;
    if (!blockId) {
      const res = promoteTaskLine(note.content, body.line!);
      if (!res) throw new HttpError(409, "line is not a task");
      if (res.content !== note.content) store.write(user, note.path, res.content);
      blockId = res.blockId;
    }
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
        status: (parsed?.checked ? "done" : "todo") as "done" | "todo",
        assigneeId: assignee?.id ?? null,
        due: parsed?.due ?? null,
        plannedDate: body.date ?? null,
        description: "",
        createdAt: now,
        updatedAt: now,
      };
      db.insert(tables.taskObjects).values(fresh).run();
      obj = fresh;
    } else {
      db.update(tables.taskObjects)
        .set({ plannedDate: body.date ?? null, updatedAt: now })
        .where(eq(tables.taskObjects.id, obj.id))
        .run();
      obj = { ...obj, plannedDate: body.date ?? null };
    }
    store.events.emit("note-changed", { noteId: note.id, path: note.path, authorId: user.id });
    return obj;
  });

  /** Update a task object; closing it checks the box in the file (two-way binding §7.2). */
  app.patch<{ Params: { id: string } }>("/api/tasks/:id", auth, async (req) => {
    const body = updateTaskObjectSchema.parse(req.body);
    const user = store.aclUser(req.userId);
    const obj = db.select().from(tables.taskObjects).where(eq(tables.taskObjects.id, req.params.id)).get();
    if (!obj) throw new HttpError(404, "task not found");
    const note = store.requireReadable(user, obj.noteId);

    if (body.status && body.status !== obj.status && (body.status === "done" || obj.status === "done")) {
      const updated = setTaskChecked(note.content, { blockId: obj.blockId }, body.status === "done");
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
