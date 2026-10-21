import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { checkTaskSchema, promoteTaskSchema, setTaskStatusSchema, taskCardQuerySchema, taskDatesSchema, taskDeleteSchema, taskEditSchema, taskMoveSchema, taskPlaceSchema, updateTaskObjectSchema, type SetTaskStatus, type TaskEdit, type TaskMove } from "@orrama/schema";
import type { z } from "zod";
import {
  canEdit, codeLines, editTaskLine, locateTask, noteLines, parseNote, placeTaskLine, projectName, projectSlugOf, promoteTaskLine, removeTaskLine, setTaskDates, setTaskStatus, taskWords,
  type AclUser, type IndexedNote, type ParsedTask, type TaskLineRef,
} from "@orrama/core";
import { tables, type Db } from "../db.js";
import { ownerOf, parseCalendarRows } from "../calendarNotes.js";
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

/** The workspace's own slots in a project note: never a place a step is moved to. */
const SLOTS = new Set(["prompt", "goals", "decisions", "inbox", "people"]);
/** Where a step goes in a project note when no section is named, as Add a step and New → Task put it. */
const STEPS_SECTION = "Tasks";
const inboxPath = (user: AclUser) => `Personal/${user.username}/Inbox.md`;
/** The inbox note as quick capture first writes it (routes/vault.ts, POST /api/capture). */
const inboxNote = (user: AclUser) => `---\ntitle: ${user.username}'s Inbox\n---\n# Inbox\n`;

/** The `##` headings of a note, in order, outside code. */
function sectionsOf(content: string): { line: number; text: string }[] {
  const { lines } = noteLines(content);
  const code = codeLines(lines);
  const out: { line: number; text: string }[] = [];
  lines.forEach((l, i) => {
    const m = /^(#{1,6})\s+(.*?)\s*$/.exec(l);
    if (m && !code[i]) out.push({ line: i, text: m[1]!.length === 2 ? m[2]!.replace(/(?:^|\s+)#+$/, "").trim() : "" });
  });
  return out;
}

/** The project a note belongs to, by key, and its note: what the card says it is "in". */
function projectOf(store: VaultStore, user: AclUser, note: IndexedNote) {
  const defs = store.projects(user);
  const key = store.index.projectKeyOf(note, defs);
  const slug = key ? projectSlugOf(key) : null;
  if (!key || !slug) return null;
  return { slug, name: projectName(store.projectNote(key), defs.find((d) => d.key === key)?.name ?? slug) };
}

/**
 * A step as its card shows it: the line, its words, the project and section it sits in, and
 * every place it can be moved to (each project whose note the caller can edit, with that note's
 * `##` sections, "Tasks" always among them).
 */
export function taskCard(store: VaultStore, user: AclUser, note: IndexedNote, task: ParsedTask) {
  const grants = store.grants();
  const heads = sectionsOf(note.content);
  const above = heads.filter((h) => h.line < task.line).at(-1);
  const places = store
    .projects(user)
    .flatMap((d) => {
      const slug = projectSlugOf(d.key);
      const pn = slug ? store.projectNote(d.key) : undefined;
      if (!slug || !pn || !canEdit(user, pn, grants)) return [];
      const sections = [...new Set(sectionsOf(pn.content).map((h) => h.text).filter((t) => t && !SLOTS.has(t.toLowerCase())))];
      if (!sections.some((t) => t.toLowerCase() === STEPS_SECTION.toLowerCase())) sections.push(STEPS_SECTION);
      return [{ slug, name: projectName(pn, d.name), sections }];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    task: { ...task, noteId: note.id, notePath: note.path, noteTitle: note.title, words: taskWords(task.raw) },
    canEdit: canEdit(user, note, grants),
    project: projectOf(store, user, note),
    section: above?.text || null,
    places,
    inInbox: note.path === inboxPath(user),
  };
}

/**
 * Change a step from its card: its words, dates, priority, key-deadline tag or box, each
 * written into its own line (core `editTaskLine`), a 409 when the line is gone. A promoted
 * step's object follows its due; a tick says "task-completed" like every other tick.
 */
export function applyTaskEdit(db: Db, store: VaultStore, user: AclUser, body: TaskEdit) {
  const note = store.requireEditable(user, body.noteId);
  const task = requireTask(note.content, body);
  let next: string | null;
  try {
    next = editTaskLine(note.content, body, body);
  } catch (e) {
    throw new HttpError(400, e instanceof Error ? e.message : "not a step");
  }
  const saved = next === note.content ? note : store.write(user, note.path, next!);
  if (body.due !== undefined && task.blockId) {
    const obj = store.taskObjectByBlock(note.id, task.blockId);
    if (obj) db.update(tables.taskObjects).set({ due: body.due, updatedAt: Date.now() }).where(eq(tables.taskObjects.id, obj.id)).run();
  }
  if (body.status === "done" && task.status !== "done") {
    store.events.emit("task-completed", { noteId: saved.id, path: note.path, authorId: user.id, blockId: task.blockId ?? null, text: task.text });
  }
  // The step as it is now: by its id, else on the same line (an edit never moves it).
  const now = store.index.get(saved.id)!;
  const after = (task.blockId ? now.tasks.find((t) => t.blockId === task.blockId) : now.tasks.find((t) => t.line === task.line)) ?? task;
  return taskCard(store, user, now, after);
}

/**
 * Move a step to another note (a project's, under one of its sections, or your inbox) or to
 * another section of its own. Another note is two writes, ordered so a crash between them can
 * only leave the step in both places, never in neither: the destination first, then a
 * promoted step's object and booked blocks follow it (task objects key on note + block id; a
 * block's row names `[[note#^id]]`), then the source loses the line. Run again after such a
 * crash, a promoted step finds itself already there and only leaves the source.
 */
export function applyTaskMove(db: Db, store: VaultStore, user: AclUser, body: TaskMove) {
  const source = store.requireEditable(user, body.noteId);
  const taken = removeTaskLine(source.content, body);
  if (!taken) throw new HttpError(409, TASK_GONE);
  const { task, line } = taken;

  // Where it goes: a project's note (one you can edit) and a section, or your inbox.
  let destPath: string;
  let destContent: string;
  let section: string | undefined;
  if ("inbox" in body.to) {
    destPath = inboxPath(user);
    const there = store.index.getByPath(destPath);
    destContent = there?.content ?? inboxNote(user);
  } else {
    const key = `project/${body.to.project.normalize("NFC")}`;
    const pn = store.projects(user).some((d) => d.key === key) ? store.projectNote(key) : undefined;
    if (!pn) throw new HttpError(404, "project not found");
    store.requireEditable(user, pn.id);
    destPath = pn.path;
    destContent = pn.content;
    section = body.to.section ?? STEPS_SECTION;
    if (SLOTS.has(section.toLowerCase())) throw new HttpError(400, "steps go under a section of their own, not the project's " + section);
  }

  // Within one note it is one write: out of its place, in at the end of the section.
  if (store.index.getByPath(destPath)?.id === source.id) {
    const placed = placeTaskLine(taken.content, line, section);
    const saved = store.write(user, source.path, placed!);
    return cardAfterMove(store, user, saved, task, line);
  }

  // 1. The destination. A promoted step already there (a move cut short) is not written twice.
  const already = task.blockId ? parseNote(destContent).tasks.find((t) => t.blockId === task.blockId) : undefined;
  if (already && taskWords(already.raw) !== taskWords(task.raw)) throw new HttpError(409, "the other note already has a step with this step's id");
  const dest = already ? store.index.getByPath(destPath)! : store.write(user, destPath, placeTaskLine(destContent, line, section)!);

  // 2. A promoted step's object, then the rows that booked time on it, follow it there.
  if (task.blockId) {
    const obj = store.taskObjectByBlock(source.id, task.blockId);
    if (obj) {
      const stale = store.taskObjectByBlock(dest.id, task.blockId);
      if (stale && stale.id !== obj.id) db.delete(tables.taskObjects).where(eq(tables.taskObjects.id, stale.id)).run();
      db.update(tables.taskObjects).set({ noteId: dest.id, updatedAt: Date.now() }).where(eq(tables.taskObjects.id, obj.id)).run();
      retargetBlocks(db, store, user, obj.id, task.blockId, dest.path);
    }
  }

  // 3. The source, as it is now.
  const fresh = store.index.get(source.id)!;
  const left = removeTaskLine(fresh.content, task.blockId ? { blockId: task.blockId } : body);
  if (left) store.write(user, fresh.path, left.content);
  return cardAfterMove(store, user, store.index.get(dest.id)!, task, line);
}

/** The card of a step just moved into `note`: by its id, else the last line with its words. */
function cardAfterMove(store: VaultStore, user: AclUser, note: IndexedNote, task: ParsedTask, line: string) {
  const now = store.index.get(note.id)!;
  const found = task.blockId ? now.tasks.find((t) => t.blockId === task.blockId) : now.tasks.filter((t) => t.raw === line).at(-1);
  return taskCard(store, user, now, found ?? task);
}

/**
 * Point every calendar row booked on a task object at the note it now lives in: the row's Task
 * cell `[[old/path#^t-id]]` becomes `[[new/path#^t-id]]`, nothing else on the line changes.
 * Rows in a calendar note the caller cannot edit stay as they are.
 */
function retargetBlocks(db: Db, store: VaultStore, user: AclUser, objectId: string, blockId: string, destPath: string) {
  const grants = store.grants();
  const target = destPath.replace(/\.md$/i, "");
  const calNotes = new Set(db.select().from(tables.taskBlocks).where(eq(tables.taskBlocks.taskObjectId, objectId)).all().flatMap((b) => (b.calNoteId ? [b.calNoteId] : [])));
  for (const id of calNotes) {
    const cal = store.index.get(id);
    const owner = cal && ownerOf(cal);
    if (!cal || !owner || !canEdit(user, cal, grants)) continue;
    const lines = cal.content.split("\n");
    let changed = false;
    for (const row of parseCalendarRows(owner, cal.content)) {
      if (row.task?.blockId !== blockId) continue;
      const was = lines[row.line]!;
      const now = was.replace(/\[\[[^\]#|]+#\^([\w-]+)\]\]/, (m, id: string) => (id === blockId ? `[[${target}#^${blockId}]]` : m));
      if (now !== was) {
        lines[row.line] = now;
        changed = true;
      }
    }
    if (changed) store.write(user, cal.path, lines.join("\n"));
  }
}

/** Delete a step: its line leaves its note, and nothing else does. A promoted step's object is orphaned, as for any deleted line. */
export function applyTaskDelete(store: VaultStore, user: AclUser, body: z.infer<typeof taskDeleteSchema>) {
  const note = store.requireEditable(user, body.noteId);
  const res = removeTaskLine(note.content, body);
  if (!res) throw new HttpError(409, TASK_GONE);
  store.write(user, note.path, res.content);
  return { ok: true, noteId: note.id };
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

  /** A step as its card shows it, with where it can go (TaskCard). */
  app.get("/api/tasks/card", auth, async (req) => {
    const q = taskCardQuerySchema.parse(req.query);
    const user = store.aclUser(req.userId);
    const note = store.requireReadable(user, q.noteId);
    return taskCard(store, user, note, requireTask(note.content, q));
  });

  /** Change a step from its card: words, due, start, priority, key deadline, status (applyTaskEdit). */
  app.post("/api/tasks/edit", auth, async (req) => applyTaskEdit(db, store, store.aclUser(req.userId), taskEditSchema.parse(req.body)));

  /** Move a step to a project's section or your inbox (applyTaskMove). */
  app.post("/api/tasks/move", auth, async (req) => applyTaskMove(db, store, store.aclUser(req.userId), taskMoveSchema.parse(req.body)));

  /** Delete a step's line (applyTaskDelete). */
  app.post("/api/tasks/delete", auth, async (req) => applyTaskDelete(store, store.aclUser(req.userId), taskDeleteSchema.parse(req.body)));

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
