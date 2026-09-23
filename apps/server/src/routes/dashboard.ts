import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { canRead } from "@basalt/core";
import { tables, type Db } from "../db.js";
import { HttpError, type VaultStore } from "../vaultStore.js";
import { projectNoteFor } from "./projects.js";

/**
 * The team command center (spec §6). Every number here is a view over the vault,
 * computed from the REQUESTER's readable notes — the dashboard can never show a
 * user an aggregate derived from notes they cannot read (§5.4).
 */
export async function dashboardRoutes(app: FastifyInstance, db: Db, store: VaultStore) {
  const auth = { preHandler: [app.authenticate] };

  app.get<{ Params: { teamSlug: string } }>("/api/dashboard/:teamSlug", auth, async (req) => {
    const user = store.aclUser(req.userId);
    const team = db.select().from(tables.teams).where(eq(tables.teams.slug, req.params.teamSlug)).get();
    if (!team) throw new HttpError(404, "team not found");
    if (!user.isOwner && !user.teams.includes(team.slug)) throw new HttpError(404, "team not found");

    const grants = store.grants();
    const allProjects = db.select().from(tables.projects).all();
    const teamProjects = allProjects.filter((p) => !p.hidden && (p.teamId === team.id || p.teamId === null));
    const projectDefs = teamProjects.map((p) => ({ kind: p.kind, key: p.key, name: p.name }));
    const domainByName = new Map(teamProjects.map((p) => [p.name, p.domain ?? null]));
    // The workspace page is addressed by slug, so the board carries it.
    const slugByName = new Map(teamProjects.map((p) => [p.name, p.key.startsWith("project/") ? p.key.slice("project/".length) : p.key]));
    // Lifecycle lives in the project note's front-matter (sleeping, cancelled,
    // on-track…), so the board reads it from the note, not from a column.
    const readable = store.readable(user);
    const statusByName = new Map(
      teamProjects.map((p) => {
        const note = projectNoteFor(readable, p.key);
        const raw = note?.frontmatter["status"];
        return [p.name, typeof raw === "string" ? raw.trim().toLowerCase() : ""];
      }),
    );
    const idByName = new Map(teamProjects.map((p) => [p.name, p.id]));

    // Progress + open tasks, from the requester's readable universe only.
    const progress = store.index.progress(user, grants, projectDefs);
    const tasks = store.index.tasks(user, grants, projectDefs);
    const objects = db.select().from(tables.taskObjects).all();
    const objByKey = new Map(objects.map((o) => [`${o.noteId}:${o.blockId}`, o]));

    // Active work floats up, done sinks to the bottom, so the board reads as
    // "what's left": in-progress → to-do → blocked → done.
    const statusRank = (t: { checked: boolean; object: { status?: string } | null }) =>
      t.checked ? 3 : t.object?.status === "in-progress" ? 0 : t.object?.status === "blocked" ? 2 : 1;
    const byProject = progress.map((p) => ({
      ...p,
      projectId: idByName.get(p.project) ?? null,
      slug: slugByName.get(p.project) ?? null,
      status: statusByName.get(p.project) ?? "",
      domain: domainByName.get(p.project) ?? null,
      // ALL steps (done + open) so the board reads like a plan, not just a to-do list.
      tasks: tasks
        .filter((t) => t.project === p.project)
        .map((t) => ({
          ...t,
          object: t.blockId ? (objByKey.get(`${t.noteId}:${t.blockId}`) ?? null) : null,
        }))
        .sort((a, b) => statusRank(a) - statusRank(b) || (a.priority ?? 4) - (b.priority ?? 4) || (a.due ?? "9999").localeCompare(b.due ?? "9999")),
    }));

    // Who's working on what: team members, their open/in-progress tasks, last edit.
    const memberRows = db
      .select({ user: tables.users })
      .from(tables.memberships)
      .innerJoin(tables.users, eq(tables.memberships.userId, tables.users.id))
      .where(eq(tables.memberships.teamId, team.id))
      .all();
    const lastEdits = store.lastEdits();
    const members = memberRows.map(({ user: m }) => {
      const open = tasks.filter((t) => !t.checked && t.assignee === m.username);
      const inProgress = open.filter((t) => {
        const o = t.blockId ? objByKey.get(`${t.noteId}:${t.blockId}`) : null;
        return o?.status === "in-progress";
      });
      const edit = lastEdits.get(m.id);
      let lastNote: { id: string; title: string; at: number } | null = null;
      if (edit) {
        const note = store.index.get(edit.noteId);
        // Presence never leaks note identity the requester can't read (§5.4).
        if (note && canRead(user, note, grants)) lastNote = { id: note.id, title: note.title, at: edit.at };
        else lastNote = null;
      }
      return {
        id: m.id,
        username: m.username,
        displayName: m.displayName,
        avatar: m.avatar,
        openTasks: open.length,
        inProgress: inProgress.map((t) => ({ text: t.text, noteId: t.noteId, project: t.project })),
        assigned: open.slice(0, 5).map((t) => ({ text: t.text, noteId: t.noteId, due: t.due, priority: t.priority })),
        lastEdit: lastNote,
      };
    });

    // Orphaned promoted tasks surface here for triage — never silently deleted (§7.2).
    const orphaned = objects
      .filter((o) => o.status === "orphaned")
      .filter((o) => {
        const n = store.index.get(o.noteId);
        return n && canRead(user, n, grants);
      })
      .map((o) => ({ id: o.id, noteId: o.noteId, blockId: o.blockId, updatedAt: o.updatedAt }));

    // Registered projects with no checkbox tasks yet still belong on the board.
    const seen = new Set(byProject.map((p) => p.project));
    const emptyProjects = projectDefs
      .filter((d) => !seen.has(d.name))
      .map((d) => ({ project: d.name, projectId: idByName.get(d.name) ?? null, total: 0, done: 0, assignees: [] as string[], lastActivityMs: undefined, domain: domainByName.get(d.name) ?? null, tasks: [] as (typeof byProject)[number]["tasks"] }));
    const projects = [...byProject, ...emptyProjects].sort((a, b) => a.project.localeCompare(b.project));

    return { team, projects, members, orphaned };
  });

  /** Teams the requester can open dashboards for (left rail). */
  app.get("/api/teams", auth, async (req) => {
    const user = store.aclUser(req.userId);
    const teams = db.select().from(tables.teams).all();
    const visible = user.isOwner ? teams : teams.filter((t) => user.teams.includes(t.slug));
    const grants = store.grants();
    return visible.map((team) => {
      const defs = db
        .select()
        .from(tables.projects)
        .all()
        .filter((p) => p.teamId === team.id || p.teamId === null)
        .map((p) => ({ kind: p.kind, key: p.key, name: p.name }));
      const progress = store.index.progress(user, grants, defs);
      const total = progress.reduce((s, p) => s + p.total, 0);
      const done = progress.reduce((s, p) => s + p.done, 0);
      return { ...team, total, done };
    });
  });

  /** Workspace members (for @assignee chips and admin screens). */
  app.get("/api/members", auth, async () => {
    return db
      .select({
        id: tables.users.id,
        username: tables.users.username,
        displayName: tables.users.displayName,
        isOwner: tables.users.isOwner,
        avatar: tables.users.avatar,
      })
      .from(tables.users)
      .all();
  });
}
