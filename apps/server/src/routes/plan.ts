/**
 * Planning: estimate open tasks and lay them onto a schedule against deadlines.
 * Always works without AI (transparent heuristics, labeled as such); when a
 * workspace key is configured the estimates are refined by the model. ACL as
 * everywhere: planned tasks come from the requester's readable notes only.
 */
import crypto from "node:crypto";
import { and, eq, gte, lte } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { canEdit, isoLocal } from "@basalt/core";
import type { AclUser, VaultTask } from "@basalt/core";
import { tables, type Db } from "../db.js";
import { generateText } from "ai";
import { aiConfig, resolveModel, type AiConfig } from "../aiProvider.js";
import { icsEventsFor } from "./ics.js";
import { HttpError, type VaultStore } from "../vaultStore.js";

/**
 * The AI estimate call used to run on every Planning page load, with every open
 * task's text and no timeout — on a server with no request timeout, so one hung
 * TLS connection hung the page (audit, high). Now it gives up after
 * AI_TIMEOUT_MS and falls back to the heuristic like any other failure, and the
 * answer is kept for AI_CACHE_MS per (model, task list): reopening the tab with
 * the same open tasks sends nothing.
 */
const AI_TIMEOUT_MS = Number(process.env.BASALT_PLAN_AI_TIMEOUT_MS ?? 8000);
const AI_CACHE_MS = 6 * 60 * 60 * 1000;
const aiCache = new Map<string, { at: number; hours: number[] }>();

/**
 * Focused-hour estimates for a numbered task listing: cached, bounded in time,
 * and asked of whichever provider the workspace is configured for.
 */
async function estimatesFor(c: AiConfig, listing: string): Promise<number[]> {
  const key = crypto.createHash("sha256").update(`${c.provider}\n${c.baseUrl ?? ""}\n${c.model}\n${listing}`).digest("hex");
  const hit = aiCache.get(key);
  if (hit && Date.now() - hit.at < AI_CACHE_MS) return hit.hours;
  const { text } = await generateText({
    model: await resolveModel(c),
    system:
      "You estimate software/knowledge-work tasks. Reply with ONLY a JSON array of numbers: focused hours per task, same order as given. Be realistic, 0.5–16 range.",
    prompt: listing,
    maxOutputTokens: 1000,
    // The abort signal bounds the call either way; the SDK's default two
    // retries (≈6s of back-off on a 500) would only spend it, and pay twice.
    maxRetries: 0,
    abortSignal: AbortSignal.timeout(AI_TIMEOUT_MS),
  });
  const hours = JSON.parse(text.slice(text.indexOf("["), text.lastIndexOf("]") + 1)) as number[];
  if (!Array.isArray(hours)) throw new Error("estimates: not an array");
  aiCache.set(key, { at: Date.now(), hours });
  return hours;
}

interface PlannedTask {
  noteId: string;
  noteTitle: string;
  line: number;
  text: string;
  project: string | null;
  assignee: string | null;
  /**
   * The viewer's to plan: assigned to them, or assigned to nobody in a note
   * they can edit. The auto-scheduler and the Planning backlog both read this,
   * so they cannot disagree about whose work a task is.
   */
  forYou: boolean;
  due: string | null;
  priority: number | null;
  estimateHours: number;
  /** Working-day the task is expected to finish, given the queue before it. */
  expectedFinish: string;
  atRisk: boolean;
  /** Calendar placement, when the assignee has dragged it onto a day. */
  blockId: string | null;
  plannedDate: string | null;
  objectId: string | null;
  /** Time blocks booked on the calendar; estimate minus these = backlog remainder. */
  blocks: { id: string; date: string; startMin: number; durationMin: number }[];
  scheduledHours: number;
  remainingHours: number;
}

const HOURS_PER_DAY = 6; // focused hours, not office hours

/** Heuristic estimate: priority + how much the line says. Deliberately simple and inspectable. */
function heuristicEstimate(t: VaultTask): number {
  const base = t.priority === 1 ? 4 : t.priority === 2 ? 2.5 : 1.5;
  const words = t.text.split(/\s+/).length;
  return Math.round((base + Math.min(words / 8, 2)) * 2) / 2;
}

function addWorkingHours(fromMs: number, hours: number): Date {
  const d = new Date(fromMs);
  let remaining = hours;
  while (remaining > 0) {
    const step = Math.min(remaining, HOURS_PER_DAY);
    remaining -= step;
    d.setHours(d.getHours() + Math.round((step / HOURS_PER_DAY) * 24));
    if (d.getDay() === 6) d.setDate(d.getDate() + 2); // skip weekends
    if (d.getDay() === 0) d.setDate(d.getDate() + 1);
  }
  return d;
}

type Team = { id: string; slug: string; name: string; color: string };

/**
 * The plan itself: estimate every open task and lay it against its deadline.
 *
 * Split out of the route because three surfaces need the same numbers — the
 * Planning backlog, the auto-scheduler below, and the team-scoped endpoint the
 * permission tests pin. `team` is optional: Basalt is one user with one vault,
 * so the tab asks for the whole plan and the team form survives for the ACL
 * tests that assert a non-member cannot read another team's work.
 */
export async function buildPlan(db: Db, store: VaultStore, user: AclUser, team: Team | null) {
    const allProjects = db.select().from(tables.projects).all();
    const projectDefs = allProjects
      .filter((p) => !p.hidden && (team === null || p.teamId === team.id || p.teamId === null))
      .map((p) => ({ kind: p.kind, key: p.key, name: p.name }));
    const open = store.index
      .tasks(user, store.grants(), projectDefs)
      // The whole-vault plan (the Planning tab) takes every open task; a team
      // plan keeps to that team's projects. Requiring a project everywhere hid
      // 53 of Jules's 173 open tasks - his deadlines note among them.
      .filter((t) => !t.checked && (t.project !== null || team === null));
    const grants = store.grants();
    const editable = (noteId: string) => {
      const note = store.index.get(noteId);
      return note !== undefined && canEdit(user, note, grants);
    };

    // Estimates: heuristic first, AI refinement when configured.
    const estimates = new Map<string, number>();
    for (const t of open) estimates.set(`${t.noteId}:${t.line}`, heuristicEstimate(t));

    const ai = aiConfig(db);
    let source: "heuristic" | "ai" = "heuristic";
    if (ai && open.length > 0) {
      try {
        const listing = open
          .map((t, i) => `${i}. [${t.priority ? "p" + t.priority : "p?"}] ${t.text} (project: ${t.project})`)
          .join("\n");
        const hours = await estimatesFor(ai, listing);
        if (hours.length === open.length) {
          open.forEach((t, i) => {
            const h = Number(hours[i]);
            if (Number.isFinite(h) && h > 0 && h <= 40) estimates.set(`${t.noteId}:${t.line}`, Math.round(h * 2) / 2);
          });
          source = "ai";
        }
      } catch {
        // fall back silently to heuristics — planning must never break without AI
      }
    }

    const objects = db.select().from(tables.taskObjects).all();
    const objByKey = new Map(objects.map((o) => [`${o.noteId}:${o.blockId}`, o]));
    const allBlocks = db.select().from(tables.taskBlocks).all();
    const blocksByObj = new Map<string, typeof allBlocks>();
    for (const b of allBlocks) {
      const list = blocksByObj.get(b.taskObjectId) ?? [];
      list.push(b);
      blocksByObj.set(b.taskObjectId, list);
    }

    // Schedule per assignee: earliest deadline first, then priority.
    const sorted = [...open].sort(
      (a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999") || (a.priority ?? 4) - (b.priority ?? 4),
    );
    const cursors = new Map<string, number>();
    const now = Date.now();
    const planned: PlannedTask[] = sorted.map((t) => {
      const key = t.assignee ?? "(unassigned)";
      const start = cursors.get(key) ?? now;
      const est = estimates.get(`${t.noteId}:${t.line}`)!;
      const finish = addWorkingHours(start, est);
      cursors.set(key, finish.getTime());
      const finishDay = isoLocal(finish);
      const obj = t.blockId ? objByKey.get(`${t.noteId}:${t.blockId}`) : undefined;
      const blocks = (obj ? (blocksByObj.get(obj.id) ?? []) : []).map((b) => ({
        id: b.id,
        date: b.date,
        startMin: b.startMin,
        durationMin: b.durationMin,
      }));
      const scheduledHours = Math.round((blocks.reduce((s, b) => s + b.durationMin, 0) / 60) * 2) / 2;
      return {
        noteId: t.noteId,
        noteTitle: t.noteTitle,
        line: t.line,
        text: t.text,
        project: t.project,
        assignee: t.assignee ?? null,
        forYou: t.assignee ? t.assignee === user.username : editable(t.noteId),
        due: t.due ?? null,
        priority: t.priority ?? null,
        estimateHours: est,
        expectedFinish: finishDay,
        atRisk: t.due !== undefined && t.due !== null && finishDay > t.due,
        blockId: t.blockId ?? null,
        plannedDate: obj?.plannedDate ?? null,
        objectId: obj?.id ?? null,
        blocks,
        scheduledHours,
        remainingHours: Math.max(est - scheduledHours, 0),
      };
    });

    const byAssignee = new Map<string, { assignee: string; totalHours: number; tasks: PlannedTask[] }>();
    for (const p of planned) {
      const key = p.assignee ?? "(unassigned)";
      let row = byAssignee.get(key);
      if (!row) {
        row = { assignee: key, totalHours: 0, tasks: [] };
        byAssignee.set(key, row);
      }
      row.totalHours += p.estimateHours;
      row.tasks.push(p);
    }

    return {
      team: team ? { slug: team.slug, name: team.name, color: team.color } : null,
      source,
      hoursPerDay: HOURS_PER_DAY,
      generatedAt: now,
      assignees: [...byAssignee.values()].sort((a, b) => b.totalHours - a.totalHours),
      atRisk: planned.filter((p) => p.atRisk).length,
      totalHours: planned.reduce((s, p) => s + p.estimateHours, 0),
    };
}


/* ---------- auto-schedule ---------- */

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const SNAP = 30;
/** Where work is allowed to land. Not office hours — the part of the day the
 *  scheduler is willing to book on your behalf; anything else you drag. */
const WORK_START = 9 * 60;
const WORK_END = 18 * 60;
/** One sitting. Longer than this and a "plan" is really just a wall of colour. */
const MAX_CHUNK = 120;

interface Slot {
  start: number;
  end: number;
}

/** The gaps left in `[from, to)` once the busy intervals are removed. */
function freeSlots(busy: Slot[], from: number, to: number): Slot[] {
  const clipped = busy
    .filter((b) => b.end > from && b.start < to)
    .map((b) => ({ start: Math.max(b.start, from), end: Math.min(b.end, to) }))
    .sort((a, b) => a.start - b.start);
  const out: Slot[] = [];
  let cursor = from;
  for (const b of clipped) {
    if (b.start > cursor) out.push({ start: cursor, end: b.start });
    cursor = Math.max(cursor, b.end);
  }
  if (cursor < to) out.push({ start: cursor, end: to });
  return out.filter((s) => s.end - s.start >= SNAP);
}

export interface Proposal {
  noteId: string;
  line: number;
  blockId: string | null;
  text: string;
  project: string | null;
  due: string | null;
  atRisk: boolean;
  date: string;
  startMin: number;
  durationMin: number;
  estimateHours: number;
}

export async function planRoutes(app: FastifyInstance, db: Db, store: VaultStore) {
  const auth = { preHandler: [app.authenticate] };

  /** The whole vault's plan — what the Planning tab asks for. */
  app.get("/api/plan", auth, async (req) => buildPlan(db, store, store.aclUser(req.userId), null));

  app.get<{ Params: { teamSlug: string } }>("/api/plan/:teamSlug", auth, async (req) => {
    const user = store.aclUser(req.userId);
    const team = db.select().from(tables.teams).where(eq(tables.teams.slug, req.params.teamSlug)).get();
    if (!team) throw new HttpError(404, "team not found");
    if (!user.isOwner && !user.teams.includes(team.slug)) throw new HttpError(404, "team not found");
    return buildPlan(db, store, user, team);
  });

  /**
   * "Plan my week": propose where the unscheduled work fits, and write nothing.
   *
   * The tab is called Planning and until now it could only *record* a plan you
   * had already made in your head. This makes the obvious pass — most urgent
   * first, into the gaps that are actually free — and hands back a proposal the
   * client draws as ghost blocks. Booking is a second, explicit step through
   * the ordinary `POST /api/tasks/blocks`, so nothing appears on the calendar
   * that the user did not look at first, and one path still promotes the
   * checkbox and writes the block.
   *
   * Three rules do the work:
   *   - a day holds `hoursPerDay` of *task* time, counting what is already booked;
   *   - nothing is placed over an existing block, event, or subscribed-calendar
   *     occurrence, nor in the past;
   *   - work is never placed after its own deadline (an overdue task is free to
   *     land anywhere, since every day is already late).
   */
  app.post("/api/plan/auto", auth, async (req) => {
    const body = (req.body ?? {}) as { from?: string; to?: string };
    const { from, to } = body;
    if (!from || !to || !DAY_RE.test(from) || !DAY_RE.test(to) || to < from) throw new HttpError(400, "from/to required (YYYY-MM-DD)");
    const user = store.aclUser(req.userId);
    const plan = await buildPlan(db, store, user, null);

    const now = new Date();
    // Both from the same clock, in the same timezone. `today` used to be UTC
    // while `nowMin` was local, so at 01:30 in Amsterdam the scheduler offered
    // a workday that was already over, and at 20:00 in New York it dropped
    // tomorrow (audit).
    const today = isoLocal(now);
    const nowMin = now.getHours() * 60 + now.getMinutes();

    // Busy: my blocks, my events, and every subscribed-calendar occurrence.
    const readableIds = new Set(store.readable(user).map((n) => n.id));
    const objById = new Map(db.select().from(tables.taskObjects).all().map((o) => [o.id, o]));
    const busy = new Map<string, Slot[]>();
    const add = (date: string, start: number, duration: number) => {
      const list = busy.get(date) ?? [];
      list.push({ start, end: start + duration });
      busy.set(date, list);
    };
    const booked = new Map<string, number>();
    for (const b of db
      .select()
      .from(tables.taskBlocks)
      .where(and(gte(tables.taskBlocks.date, from), lte(tables.taskBlocks.date, to)))
      .all()) {
      const obj = objById.get(b.taskObjectId);
      if (!obj || !readableIds.has(obj.noteId)) continue;
      add(b.date, b.startMin, b.durationMin);
      booked.set(b.date, (booked.get(b.date) ?? 0) + b.durationMin);
    }
    for (const e of db
      .select()
      .from(tables.events)
      .where(and(eq(tables.events.ownerId, user.id), gte(tables.events.date, from), lte(tables.events.date, to)))
      .all())
      add(e.date, e.startMin, e.durationMin);
    for (const e of await icsEventsFor(db, user.id, user.username, from, to).catch(() => []))
      if (!e.allDay) add(e.date, e.startMin, e.durationMin);

    // The days on offer: weekdays in range that have not already happened.
    const days: { date: string; slots: Slot[]; left: number }[] = [];
    for (let t = Date.parse(`${from}T12:00:00Z`); t <= Date.parse(`${to}T12:00:00Z`); t += 86_400_000) {
      const d = new Date(t);
      const date = d.toISOString().slice(0, 10);
      if (date < today) continue;
      const dow = d.getUTCDay();
      if (dow === 0 || dow === 6) continue; // weekends are not the scheduler's to spend
      const open = date === today ? Math.max(WORK_START, Math.ceil(nowMin / SNAP) * SNAP) : WORK_START;
      if (open >= WORK_END) continue;
      const left = HOURS_PER_DAY * 60 - (booked.get(date) ?? 0);
      if (left < SNAP) continue;
      days.push({ date, slots: freeSlots(busy.get(date) ?? [], open, WORK_END), left });
    }

    // Most urgent first: what is already late, then what is heading that way,
    // then by deadline and priority. Anything undated waits its turn at the end.
    // Assigned to you, or to nobody in a note you can edit (PlannedTask.forYou).
    // Keyed on the assignee name alone, every task without an @mention -
    // 61 of 173 on the real vault - was invisible to the scheduler.
    const mine = plan.assignees.flatMap((a) => a.tasks).filter((t) => t.forYou && t.remainingHours > 0);
    const urgency = (t: (typeof mine)[number]) => (t.due && t.due < today ? 0 : t.atRisk ? 1 : t.due ? 2 : 3);
    const queue = [...mine].sort(
      (a, b) => urgency(a) - urgency(b) || (a.due ?? "9999").localeCompare(b.due ?? "9999") || (a.priority ?? 4) - (b.priority ?? 4),
    );

    const proposals: Proposal[] = [];
    let unplaced = 0;
    for (const task of queue) {
      let remaining = Math.round(task.remainingHours * 60);
      // A future deadline is a wall; an overdue task has no wall left to respect.
      const wall = task.due && task.due >= today ? task.due : null;
      let placedAny = false;
      for (const day of days) {
        if (remaining < SNAP) break;
        if (wall && day.date > wall) break;
        for (let i = 0; i < day.slots.length && remaining >= SNAP; i++) {
          const slot = day.slots[i]!;
          const room = Math.min(slot.end - slot.start, day.left, remaining, MAX_CHUNK);
          const duration = Math.floor(room / SNAP) * SNAP;
          if (duration < SNAP) continue;
          proposals.push({
            noteId: task.noteId,
            line: task.line,
            blockId: task.blockId,
            text: task.text,
            project: task.project,
            due: task.due,
            atRisk: task.atRisk,
            date: day.date,
            startMin: slot.start,
            durationMin: duration,
            estimateHours: task.estimateHours,
          });
          slot.start += duration;
          day.left -= duration;
          remaining -= duration;
          placedAny = true;
          if (day.left < SNAP) break;
        }
      }
      if (!placedAny) unplaced++;
    }

    return {
      from,
      to,
      hoursPerDay: HOURS_PER_DAY,
      proposals: proposals.sort((a, b) => a.date.localeCompare(b.date) || a.startMin - b.startMin),
      placedHours: Math.round((proposals.reduce((s, p) => s + p.durationMin, 0) / 60) * 2) / 2,
      unplaced,
    };
  });
}
