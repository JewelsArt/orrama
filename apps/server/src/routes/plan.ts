/**
 * Planning: estimate open tasks and lay them onto a schedule against deadlines.
 * Always works without AI (transparent heuristics, labeled as such); when a
 * workspace key is configured the estimates are refined by the model. ACL as
 * everywhere: planned tasks come from the requester's readable notes only.
 */
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { VaultTask } from "@basalt/core";
import { tables, type Db } from "../db.js";
import { decryptSecret } from "../secrets.js";
import { HttpError, type VaultStore } from "../vaultStore.js";

interface PlannedTask {
  noteId: string;
  noteTitle: string;
  line: number;
  text: string;
  project: string | null;
  assignee: string | null;
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

export async function planRoutes(app: FastifyInstance, db: Db, store: VaultStore) {
  const auth = { preHandler: [app.authenticate] };

  app.get<{ Params: { teamSlug: string } }>("/api/plan/:teamSlug", auth, async (req) => {
    const user = store.aclUser(req.userId);
    const team = db.select().from(tables.teams).where(eq(tables.teams.slug, req.params.teamSlug)).get();
    if (!team) throw new HttpError(404, "team not found");
    if (!user.isOwner && !user.teams.includes(team.slug)) throw new HttpError(404, "team not found");

    const allProjects = db.select().from(tables.projects).all();
    const projectDefs = allProjects
      .filter((p) => !p.hidden && (p.teamId === team.id || p.teamId === null))
      .map((p) => ({ kind: p.kind, key: p.key, name: p.name }));
    const open = store.index
      .tasks(user, store.grants(), projectDefs)
      .filter((t) => !t.checked && t.project !== null);

    // Estimates: heuristic first, AI refinement when configured.
    const estimates = new Map<string, number>();
    for (const t of open) estimates.set(`${t.noteId}:${t.line}`, heuristicEstimate(t));

    const ws = db.select().from(tables.workspace).all()[0];
    let source: "heuristic" | "ai" = "heuristic";
    if (ws?.aiProvider === "anthropic" && ws.aiKeyEncrypted && ws.aiModel && open.length > 0) {
      try {
        const listing = open
          .map((t, i) => `${i}. [${t.priority ? "p" + t.priority : "p?"}] ${t.text} (project: ${t.project})`)
          .join("\n");
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": decryptSecret(ws.aiKeyEncrypted),
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: ws.aiModel,
            max_tokens: 1000,
            system:
              "You estimate software/knowledge-work tasks. Reply with ONLY a JSON array of numbers: focused hours per task, same order as given. Be realistic, 0.5–16 range.",
            messages: [{ role: "user", content: listing }],
          }),
        });
        if (res.ok) {
          const data = (await res.json()) as { content: { type: string; text?: string }[] };
          const text = data.content.find((b) => b.type === "text")?.text ?? "";
          const arr = JSON.parse(text.slice(text.indexOf("["), text.lastIndexOf("]") + 1)) as number[];
          if (Array.isArray(arr) && arr.length === open.length) {
            open.forEach((t, i) => {
              const h = Number(arr[i]);
              if (Number.isFinite(h) && h > 0 && h <= 40) estimates.set(`${t.noteId}:${t.line}`, Math.round(h * 2) / 2);
            });
            source = "ai";
          }
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
      const finishDay = finish.toISOString().slice(0, 10);
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
      team: { slug: team.slug, name: team.name, color: team.color },
      source,
      hoursPerDay: HOURS_PER_DAY,
      generatedAt: now,
      assignees: [...byAssignee.values()].sort((a, b) => b.totalHours - a.totalHours),
      atRisk: planned.filter((p) => p.atRisk).length,
      totalHours: planned.reduce((s, p) => s + p.estimateHours, 0),
    };
  });
}
