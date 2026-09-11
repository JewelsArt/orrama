/**
 * API-level integration tests: the §5 permission model enforced over real HTTP,
 * plus the file-is-source-of-truth loop (dashboard checkbox → Markdown edit).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.BASALT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "basalt-test-"));
process.env.BASALT_JWT_SECRET = "test-secret";

const { buildServer } = await import("../src/main.js");
const { tables } = await import("../src/db.js");

let app: Awaited<ReturnType<typeof buildServer>>["app"];
let db: Awaited<ReturnType<typeof buildServer>>["db"];
let store: Awaited<ReturnType<typeof buildServer>>["store"];
const tokens: Record<string, string> = {};

const api = async (method: string, url: string, user?: string, body?: unknown) => {
  const res = await app.inject({
    method: method as "GET",
    url,
    headers: user ? { authorization: `Bearer ${tokens[user]}` } : {},
    ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
  });
  return { status: res.statusCode, json: res.json() };
};

beforeAll(async () => {
  // Seed the same demo workspace the app ships with, then boot the server on it.
  await import("../src/seed.js");
  const built = await buildServer();
  app = built.app;
  db = built.db;
  store = built.store;
  for (const email of ["jules@basalt.dev", "erin@basalt.dev", "mara@basalt.dev"]) {
    const r = await api("POST", "/api/auth/login", undefined, { email, password: "basalt-demo" });
    expect(r.status).toBe(200);
    tokens[email.split("@")[0]!] = r.json.token;
  }
});

afterAll(async () => {
  await app.close();
  fs.rmSync(process.env.BASALT_DATA_DIR!, { recursive: true, force: true });
});

describe("auth", () => {
  it("rejects bad credentials and unauthenticated requests", async () => {
    expect((await api("POST", "/api/auth/login", undefined, { email: "erin@basalt.dev", password: "wrong!" })).status).toBe(401);
    expect((await api("GET", "/api/vault/tree")).status).toBe(401);
  });

  it("requires an invite for registration after the first user", async () => {
    const r = await api("POST", "/api/auth/register", undefined, {
      email: "x@x.dev", username: "xx", displayName: "X", password: "password123",
    });
    expect(r.status).toBe(403);
  });
});

describe("§5.4 leak rules over HTTP", () => {
  it("tree: erin never sees the #only/marketing note; mara never sees #only/engineering", async () => {
    const erin = await api("GET", "/api/vault/tree", "erin");
    const paths = erin.json.map((n: { path: string }) => n.path);
    expect(paths).toContain("Engineering/Atlas Roadmap.md");
    expect(paths).toContain("Marketing/Acme Relaunch Brief.md"); // #share/engineering
    expect(paths).not.toContain("Marketing/Surprise Campaign.md");

    const mara = await api("GET", "/api/vault/tree", "mara");
    const mPaths = mara.json.map((n: { path: string }) => n.path);
    expect(mPaths).toContain("Marketing/Surprise Campaign.md");
    expect(mPaths).not.toContain("Engineering/Incident Runbook.md");
    // root viewer grant exposes Welcome.md but NOT other teams' editor folders' restricted notes
    expect(mPaths).toContain("Welcome.md");
  });

  it("direct fetch of an unreadable note 404s (no existence confirmation)", async () => {
    const mara = await api("GET", "/api/vault/tree", "mara");
    expect(mara.status).toBe(200);
    const jules = await api("GET", "/api/vault/tree", "jules");
    const runbook = jules.json.find((n: { path: string }) => n.path === "Engineering/Incident Runbook.md");
    expect(runbook).toBeDefined();
    expect((await api("GET", `/api/vault/note/${runbook.id}`, "mara")).status).toBe(404);
    expect((await api("GET", `/api/vault/note/${runbook.id}`, "erin")).status).toBe(200);
  });

  it("search and manifest are ACL-filtered", async () => {
    const s = await api("GET", "/api/vault/search?q=teaser", "erin");
    expect(s.json).toEqual([]);
    const m = await api("GET", "/api/sync/manifest", "erin");
    expect(JSON.stringify(m.json)).not.toContain("Surprise Campaign");
    const m2 = await api("GET", "/api/sync/manifest", "mara");
    expect(JSON.stringify(m2.json)).toContain("Surprise Campaign");
  });

  it("share grants read but not write", async () => {
    const erin = await api("GET", "/api/vault/tree", "erin");
    const brief = erin.json.find((n: { path: string }) => n.path === "Marketing/Acme Relaunch Brief.md");
    const note = await api("GET", `/api/vault/note/${brief.id}`, "erin");
    expect(note.json.canEdit).toBe(false);
    const w = await api("PUT", "/api/vault/note", "erin", {
      path: "Marketing/Acme Relaunch Brief.md",
      content: note.json.content + "\nerin was here\n",
    });
    expect(w.status).toBe(403);
  });
});

describe("§5.3 abuse rules over HTTP", () => {
  it("rejects adding #only/<team> for a team the actor is not in", async () => {
    const erin = await api("GET", "/api/vault/tree", "erin");
    const arch = erin.json.find((n: { path: string }) => n.path === "Engineering/Atlas Architecture.md");
    const note = await api("GET", `/api/vault/note/${arch.id}`, "erin");
    const w = await api("PUT", "/api/vault/note", "erin", {
      path: "Engineering/Atlas Architecture.md",
      content: note.json.content + "\n#only/marketing\n",
    });
    expect(w.status).toBe(403);
    expect(w.json.error).toContain("only/marketing");
  });

  it("rejects self-lockout edits", async () => {
    const mara = await api("GET", "/api/vault/tree", "mara");
    const brief = mara.json.find((n: { path: string }) => n.path === "Marketing/Acme Relaunch Brief.md");
    const note = await api("GET", `/api/vault/note/${brief.id}`, "mara");
    // mara tries to hide the note from herself: #only/engineering (she's not in engineering)
    const w = await api("PUT", "/api/vault/note", "mara", {
      path: "Marketing/Acme Relaunch Brief.md",
      content: note.json.content.replace("#share/engineering", "#only/engineering"),
    });
    expect(w.status).toBe(403);
  });

  it("allows a member to lock a note to their own team", async () => {
    const erin = await api("GET", "/api/vault/tree", "erin");
    const arch = erin.json.find((n: { path: string }) => n.path === "Engineering/Atlas Architecture.md");
    const note = await api("GET", `/api/vault/note/${arch.id}`, "erin");
    const w = await api("PUT", "/api/vault/note", "erin", {
      path: "Engineering/Atlas Architecture.md",
      content: note.json.content + "\n#only/engineering\n",
    });
    expect(w.status).toBe(200);
    // and back out again (she's a member, so removal is fine)
    await api("PUT", "/api/vault/note", "erin", { path: "Engineering/Atlas Architecture.md", content: note.json.content });
  });
});

describe("tasks: file is the source of truth", () => {
  it("dashboard checkbox writes the Markdown file", async () => {
    const jules = await api("GET", "/api/vault/tree", "jules");
    const shared = jules.json.find((n: { path: string }) => n.path === "Shared/Meeting Notes 2026-07-01.md");
    const before = await api("GET", `/api/vault/note/${shared.id}`, "jules");
    const line = before.json.content.split("\n").findIndex((l: string) => l.includes("schedule next sync"));
    const r = await api("POST", "/api/tasks/check", "jules", { noteId: shared.id, line, checked: true });
    expect(r.status).toBe(200);

    const after = await api("GET", `/api/vault/note/${shared.id}`, "jules");
    expect(after.json.content.split("\n")[line]).toContain("- [x] schedule next sync");
    // and the actual file on disk changed
    const onDisk = fs.readFileSync(
      path.join(process.env.BASALT_DATA_DIR!, "vault", "Shared/Meeting Notes 2026-07-01.md"),
      "utf8",
    );
    expect(onDisk).toContain("- [x] schedule next sync");
    await api("POST", "/api/tasks/check", "jules", { noteId: shared.id, line, checked: false });
  });

  it("promotion creates a task object bound by block id; deleting the line orphans it", async () => {
    const erin = await api("GET", "/api/vault/tree", "erin");
    const arch = erin.json.find((n: { path: string }) => n.path === "Engineering/Atlas Architecture.md");
    const note = await api("GET", `/api/vault/note/${arch.id}`, "erin");
    const line = note.json.content.split("\n").findIndex((l: string) => l.includes("write ADR"));
    const p = await api("POST", "/api/tasks/promote", "erin", { noteId: arch.id, line });
    expect(p.status).toBe(200);
    expect(p.json.blockId).toMatch(/^t-/);

    // close the object → the box gets checked in the file (two-way binding)
    const patched = await api("PATCH", `/api/tasks/${p.json.id}`, "erin", { status: "done" });
    expect(patched.json.status).toBe("done");
    const after = await api("GET", `/api/vault/note/${arch.id}`, "erin");
    expect(after.json.content).toMatch(/- \[x\] write ADR.*\^t-/);

    // delete the line → orphaned, surfaced for triage
    const without = after.json.content.split("\n").filter((l: string) => !l.includes("write ADR")).join("\n");
    await api("PUT", "/api/vault/note", "erin", { path: "Engineering/Atlas Architecture.md", content: without });
    const dash = await api("GET", "/api/dashboard/engineering", "erin");
    expect(dash.json.orphaned.some((o: { id: string }) => o.id === p.json.id)).toBe(true);
  });

  it("gantt dates rewrite start:/due: tokens on the file line", async () => {
    const erin = await api("GET", "/api/vault/tree", "erin");
    const road = erin.json.find((n: { path: string }) => n.path === "Engineering/Atlas Roadmap.md");
    const note = await api("GET", `/api/vault/note/${road.id}`, "erin");
    const line = note.json.content.split("\n").findIndex((l: string) => l.includes("partial checkout spike"));
    const r = await api("POST", "/api/tasks/dates", "erin", { noteId: road.id, line, start: "2026-07-06", due: "2026-07-10" });
    expect(r.status).toBe(200);
    const after = await api("GET", `/api/vault/note/${road.id}`, "erin");
    expect(after.json.content.split("\n")[line]).toContain("start:2026-07-06 due:2026-07-10");

    // the dashboard parses the tokens back out for the Gantt view
    const dash = await api("GET", "/api/dashboard/engineering", "erin");
    const atlas = dash.json.projects.find((p: { project: string }) => p.project === "Atlas");
    const task = atlas.tasks.find((t: { text: string }) => t.text === "partial checkout spike");
    expect(task).toMatchObject({ start: "2026-07-06", due: "2026-07-10" });

    // invalid range is rejected; unreadable note stays a 404 (no existence leak)
    expect((await api("POST", "/api/tasks/dates", "erin", { noteId: road.id, line, start: "2026-07-12", due: "2026-07-10" })).status).toBe(400);
    expect((await api("POST", "/api/tasks/dates", "mara", { noteId: road.id, line, due: "2026-07-10" })).status).toBe(404);

    // null clears a token (bar dragged back to the unscheduled strip)
    await api("POST", "/api/tasks/dates", "erin", { noteId: road.id, line, start: null });
    const cleared = await api("GET", `/api/vault/note/${road.id}`, "erin");
    expect(cleared.json.content.split("\n")[line]).not.toContain("start:");
    expect(cleared.json.content.split("\n")[line]).toContain("due:2026-07-10");
  });

  it("status dropdown: done checks the box; in-progress is DB-only and auto-promotes", async () => {
    const jules = await api("GET", "/api/vault/tree", "jules");
    const shared = jules.json.find((n: { path: string }) => n.path === "Shared/Meeting Notes 2026-07-01.md");
    const notePath = path.join(process.env.BASALT_DATA_DIR!, "vault", "Shared/Meeting Notes 2026-07-01.md");
    const before = await api("GET", `/api/vault/note/${shared.id}`, "jules");
    const line = before.json.content.split("\n").findIndex((l: string) => l.includes("schedule next sync"));

    // in-progress: a checkbox can't hold it → promote the line, keep the box open,
    // and carry the status on the task object (DB), not the Markdown.
    const wip = await api("POST", "/api/tasks/status", "jules", { noteId: shared.id, line, status: "in-progress" });
    expect(wip.status).toBe(200);
    expect(wip.json.blockId).toMatch(/^t-/);
    const wipLine = fs.readFileSync(notePath, "utf8").split("\n").find((l) => l.includes("schedule next sync"))!;
    expect(wipLine).toContain("- [ ] schedule next sync"); // still open in the file
    expect(wipLine).toMatch(/\^t-/); // but promoted
    const tasks = await api("GET", "/api/tasks", "jules");
    expect(tasks.json.find((t: { blockId?: string }) => t.blockId === wip.json.blockId)?.object?.status).toBe("in-progress");

    // done: crosses into the checkbox, editing the real file on disk.
    const done = await api("POST", "/api/tasks/status", "jules", { noteId: shared.id, line, blockId: wip.json.blockId, status: "done" });
    expect(done.status).toBe(200);
    expect(fs.readFileSync(notePath, "utf8")).toMatch(/- \[x\] schedule next sync/);

    // back to todo → unchecks, leaving the note clean for later tests.
    await api("POST", "/api/tasks/status", "jules", { noteId: shared.id, line, blockId: wip.json.blockId, status: "todo" });
    expect(fs.readFileSync(notePath, "utf8")).toMatch(/- \[ \] schedule next sync/);
  });
});

describe("projects derive from notes", () => {
  it("a project/<slug> note auto-registers on the board; hiding it survives re-index", async () => {
    // Scaffold a project note (this is what the AI/MCP create_project tool does).
    const created = await api("POST", "/api/projects", "jules", { name: "Auto Test", domain: "professional" });
    expect(created.status).toBe(200);
    expect(created.json.key).toBe("project/auto-test");

    // It's on the board purely because the note carries the tag — no manual registration.
    let dash = await api("GET", "/api/dashboard/engineering", "jules");
    expect(dash.json.projects.some((p: { project: string }) => p.project === "Auto Test")).toBe(true);

    // Owner removes it → hidden (not deleted).
    const admin = await api("GET", "/api/admin/overview", "jules");
    const proj = admin.json.projects.find((p: { key: string }) => p.key === "project/auto-test");
    expect(proj).toBeTruthy();
    expect((await api("DELETE", `/api/admin/projects/${proj.id}`, "jules")).status).toBe(200);
    dash = await api("GET", "/api/dashboard/engineering", "jules");
    expect(dash.json.projects.some((p: { project: string }) => p.project === "Auto Test")).toBe(false);

    // Re-indexing the still-tagged note must NOT resurrect it (the whole point of hidden).
    const note = await api("GET", `/api/vault/note/${created.json.noteId}`, "jules");
    await api("PUT", "/api/vault/note", "jules", { path: created.json.path, content: note.json.content + "\n- [ ] another step\n", baseHash: note.json.hash });
    dash = await api("GET", "/api/dashboard/engineering", "jules");
    expect(dash.json.projects.some((p: { project: string }) => p.project === "Auto Test")).toBe(false);
  });

  it("promote adds project tags to an existing note", async () => {
    const jules = await api("GET", "/api/vault/tree", "jules");
    const shared = jules.json.find((n: { path: string }) => n.path === "Shared/Meeting Notes 2026-07-01.md");
    const r = await api("POST", "/api/projects/promote", "jules", { noteId: shared.id, domain: "professional" });
    expect(r.status).toBe(200);
    const after = await api("GET", `/api/vault/note/${shared.id}`, "jules");
    expect(after.json.content).toMatch(/project\//);
    expect(after.json.tags.some((t: { tag: string }) => /^project\//.test(t.tag))).toBe(true);
  });
});

describe("AI agent config", () => {
  it("owner sets custom agent instructions; they persist and are owner-only", async () => {
    const set = await api("POST", "/api/admin/ai/instructions", "jules", { instructions: "Be direct. Push me on deadlines." });
    expect(set.status).toBe(200);
    const overview = await api("GET", "/api/admin/overview", "jules");
    expect(overview.json.ai.instructions).toBe("Be direct. Push me on deadlines.");
    // a non-owner cannot change the agent's instructions
    expect((await api("POST", "/api/admin/ai/instructions", "erin", { instructions: "hijack" })).status).toBe(403);
  });
});

describe("dashboard", () => {
  it("computes real progress per project and per-member activity", async () => {
    const dash = await api("GET", "/api/dashboard/engineering", "erin");
    expect(dash.status).toBe(200);
    const atlas = dash.json.projects.find((p: { project: string }) => p.project === "Atlas");
    expect(atlas.total).toBeGreaterThan(4);
    expect(atlas.done).toBeGreaterThanOrEqual(2);
    const erinRow = dash.json.members.find((m: { username: string }) => m.username === "erin");
    expect(erinRow.inProgress.length).toBeGreaterThan(0); // seeded in-progress spike
  });

  it("mara cannot open the engineering dashboard", async () => {
    expect((await api("GET", "/api/dashboard/engineering", "mara")).status).toBe(404);
  });

  it("quick capture appends to the user's PERSONAL inbox, invisible to teammates", async () => {
    const r = await api("POST", "/api/capture", "mara", { text: "call the venue" });
    expect(r.status).toBe(200);
    const tree = await api("GET", "/api/vault/tree", "mara");
    const inbox = tree.json.find((n: { path: string }) => n.path === "Personal/mara/Inbox.md");
    const note = await api("GET", `/api/vault/note/${inbox.id}`, "mara");
    expect(note.json.content).toContain("- [ ] call the venue @mara");
    // personal space never reaches another member's tree or direct fetch
    const erinTree = await api("GET", "/api/vault/tree", "erin");
    expect(erinTree.json.some((n: { path: string }) => n.path.startsWith("Personal/mara"))).toBe(false);
    expect((await api("GET", `/api/vault/note/${inbox.id}`, "erin")).status).toBe(404);
  });

  it("a member can write in their own personal folder without any grant", async () => {
    const w = await api("PUT", "/api/vault/note", "erin", {
      path: "Personal/erin/Ideas.md",
      content: "---\ntitle: Ideas\n---\nquiet thoughts\n",
    });
    expect(w.status).toBe(200);
    const w2 = await api("PUT", "/api/vault/note", "mara", {
      path: "Personal/erin/Intrusion.md",
      content: "nope",
    });
    expect(w2.status).toBe(403);
  });
});

describe("AI", () => {
  it("reports unconfigured without a key and the dashboard stays fully useful", async () => {
    const s = await api("GET", "/api/ai/status", "erin");
    expect(s.json.configured).toBe(false);
    expect((await api("POST", "/api/ai/ask", "erin", { question: "what is atlas?" })).status).toBe(400);
  });

  it("suggested links work with zero AI config (pure local scoring)", async () => {
    const erin = await api("GET", "/api/vault/tree", "erin");
    const road = erin.json.find((n: { path: string }) => n.path === "Engineering/Atlas Roadmap.md");
    const rel = await api("GET", `/api/vault/note/${road.id}/related`, "erin");
    expect(rel.status).toBe(200);
    expect(Array.isArray(rel.json)).toBe(true);
  });
});

describe("graph + plan + profile", () => {
  it("graph is ACL-filtered: no nodes or edges for unreadable notes", async () => {
    const g = await api("GET", "/api/vault/graph", "erin");
    expect(g.status).toBe(200);
    const titles = g.json.nodes.map((n: { title: string }) => n.title);
    expect(titles).toContain("Atlas Roadmap");
    expect(titles).not.toContain("Surprise Campaign");
    const ids = new Set(g.json.nodes.map((n: { id: string }) => n.id));
    for (const e of g.json.edges) {
      expect(ids.has(e.from)).toBe(true);
      expect(ids.has(e.to)).toBe(true);
    }
  });

  it("plan estimates open project tasks with schedule + risk, heuristic without AI", async () => {
    const p = await api("GET", "/api/plan/engineering", "erin");
    expect(p.status).toBe(200);
    expect(p.json.source).toBe("heuristic");
    expect(p.json.totalHours).toBeGreaterThan(0);
    const erinRow = p.json.assignees.find((a: { assignee: string }) => a.assignee === "erin");
    expect(erinRow.tasks.length).toBeGreaterThan(0);
    for (const t of erinRow.tasks) {
      expect(t.estimateHours).toBeGreaterThan(0);
      expect(t.expectedFinish).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    // team scoping mirrors the dashboard
    expect((await api("GET", "/api/plan/engineering", "mara")).status).toBe(404);
  });

  it("plan without a team spans the whole vault, still ACL-filtered", async () => {
    const erin = await api("GET", "/api/plan", "erin");
    expect(erin.status).toBe(200);
    expect(erin.json.team).toBeNull();
    const erinTexts = erin.json.assignees.flatMap((a: { tasks: { text: string }[] }) => a.tasks).map((t: { text: string }) => t.text);
    expect(erinTexts).toContain("permission test suite");
    // the #only/marketing note is invisible to her here as everywhere else
    expect(erinTexts).not.toContain("book influencer slots");
  });

  it("day markers: dated work in range, and never someone else's restricted note", async () => {
    const from = "2026-07-06";
    const to = "2026-07-19";
    const erin = await api("GET", `/api/calendar/markers?from=${from}&to=${to}`, "erin");
    expect(erin.status).toBe(200);
    const titles = erin.json.map((m: { title: string }) => m.title);
    expect(titles).toContain("permission test suite"); // due 2026-07-15
    expect(titles).not.toContain("book influencer slots"); // #only/marketing, due 2026-07-11
    for (const m of erin.json) {
      expect(m.date >= from && m.date <= to).toBe(true);
      expect(["due", "milestone", "charge", "income"]).toContain(m.kind);
    }
    // mara owns that note, so for her it is simply a deadline
    const mara = await api("GET", `/api/calendar/markers?from=${from}&to=${to}`, "mara");
    expect(mara.json.map((m: { title: string }) => m.title)).toContain("book influencer slots");
    // a task due outside the window never leaks in
    expect(titles).not.toContain("dashboard API"); // due 2026-07-20
    expect((await api("GET", "/api/calendar/markers?from=whenever&to=2026-07-19", "erin")).status).toBe(400);
  });

  it("auto-plan proposes bookable slots and writes nothing", async () => {
    const before = db.select().from(tables.taskBlocks).all().length;
    const day = (offset: number) => {
      const d = new Date();
      d.setDate(d.getDate() + offset);
      return d.toISOString().slice(0, 10);
    };
    const from = day(7);
    const to = day(13);
    const r = await api("POST", "/api/plan/auto", "erin", { from, to });
    expect(r.status).toBe(200);
    expect(r.json.proposals.length).toBeGreaterThan(0);

    const perDay = new Map<string, { total: number; spans: { start: number; end: number }[] }>();
    for (const p of r.json.proposals) {
      expect(p.date >= from && p.date <= to).toBe(true);
      expect(new Date(`${p.date}T12:00:00Z`).getUTCDay()).not.toBe(0); // never a weekend
      expect(new Date(`${p.date}T12:00:00Z`).getUTCDay()).not.toBe(6);
      expect(p.startMin).toBeGreaterThanOrEqual(9 * 60);
      expect(p.startMin + p.durationMin).toBeLessThanOrEqual(18 * 60);
      expect(p.durationMin % 30).toBe(0);
      expect(p.durationMin).toBeLessThanOrEqual(120);
      const row = perDay.get(p.date) ?? { total: 0, spans: [] };
      row.total += p.durationMin;
      row.spans.push({ start: p.startMin, end: p.startMin + p.durationMin });
      perDay.set(p.date, row);
    }
    for (const [, row] of perDay) {
      expect(row.total).toBeLessThanOrEqual(r.json.hoursPerDay * 60);
      const spans = row.spans.sort((a, b) => a.start - b.start);
      for (let i = 1; i < spans.length; i++) expect(spans[i]!.start).toBeGreaterThanOrEqual(spans[i - 1]!.end);
    }
    // A proposal is a proposal: booking is the client's separate, explicit call.
    expect(db.select().from(tables.taskBlocks).all().length).toBe(before);
    expect((await api("POST", "/api/plan/auto", "erin", { from: to, to: from })).status).toBe(400);
  });

  it("schedule places a task on a day (auto-promoting) and back to backlog", async () => {
    const erin = await api("GET", "/api/vault/tree", "erin");
    const road = erin.json.find((n: { path: string }) => n.path === "Engineering/Atlas Roadmap.md");
    const note = await api("GET", `/api/vault/note/${road.id}`, "erin");
    const line = note.json.content.split("\n").findIndex((l: string) => l.includes("permission test suite"));
    const s = await api("POST", "/api/tasks/schedule", "erin", { noteId: road.id, line, date: "2026-07-06" });
    expect(s.status).toBe(200);
    expect(s.json.plannedDate).toBe("2026-07-06");
    expect(s.json.blockId).toMatch(/^t-/);
    // the plan reflects the placement
    const p = await api("GET", "/api/plan/engineering", "erin");
    const placed = p.json.assignees.flatMap((a: { tasks: { plannedDate: string | null; text: string }[] }) => a.tasks)
      .find((t: { text: string }) => t.text === "permission test suite");
    expect(placed.plannedDate).toBe("2026-07-06");
    // unschedule
    const u = await api("POST", "/api/tasks/schedule", "erin", { noteId: road.id, blockId: s.json.blockId, date: null });
    expect(u.json.plannedDate).toBeNull();
  });

  it("time blocks: default 2h capped by remaining estimate, resize, delete", async () => {
    const erin = await api("GET", "/api/vault/tree", "erin");
    const road = erin.json.find((n: { path: string }) => n.path === "Engineering/Atlas Roadmap.md");
    const note = await api("GET", `/api/vault/note/${road.id}`, "erin");
    const line = note.json.content.split("\n").findIndex((l: string) => l.includes("dashboard API"));
    const b1 = await api("POST", "/api/tasks/blocks", "erin", {
      noteId: road.id, line, date: "2026-07-06", startMin: 9 * 60, estimateHours: 3,
    });
    expect(b1.status).toBe(200);
    expect(b1.json.durationMin).toBe(120); // default 2h of the 3h estimate
    // second drop books only the remaining hour
    const b2 = await api("POST", "/api/tasks/blocks", "erin", {
      noteId: road.id, blockId: b1.json.taskObject.blockId, date: "2026-07-07", startMin: 14 * 60, estimateHours: 3,
    });
    expect(b2.json.durationMin).toBe(60);
    // plan reflects both blocks + scheduled/remaining bookkeeping
    const p = await api("GET", "/api/plan/engineering", "erin");
    const task = p.json.assignees.flatMap((a: { tasks: { text: string; blocks: unknown[]; scheduledHours: number; remainingHours: number }[] }) => a.tasks)
      .find((t: { text: string }) => t.text === "dashboard API");
    expect(task.blocks.length).toBe(2);
    expect(task.scheduledHours).toBe(3);
    expect(task.remainingHours).toBe(0);
    // resize with 30-min snapping, then delete
    const patched = await api("PATCH", `/api/blocks/${b1.json.id}`, "erin", { durationMin: 100 });
    expect(patched.json.durationMin).toBe(90);
    expect((await api("DELETE", `/api/blocks/${b1.json.id}`, "erin")).status).toBe(200);
    expect((await api("DELETE", `/api/blocks/${b2.json.id}`, "erin")).status).toBe(200);
  });

  it("events: owner-only edit, range query marks mine", async () => {
    const e = await api("POST", "/api/events", "mara", { title: "Acme kickoff call", date: "2026-07-07", startMin: 10 * 60, durationMin: 45 });
    expect(e.status).toBe(200);
    expect(e.json.durationMin).toBe(60); // snapped to 30-min grid, min 30 → 45→60? (rounded)
    const list = await api("GET", "/api/events?from=2026-07-06&to=2026-07-12", "erin");
    const found = list.json.find((x: { id: string }) => x.id === e.json.id);
    expect(found.username).toBe("mara");
    expect(found.mine).toBe(false);
    expect((await api("PATCH", `/api/events/${e.json.id}`, "erin", { title: "hijack" })).status).toBe(403);
    expect((await api("DELETE", `/api/events/${e.json.id}`, "mara")).status).toBe(200);
  });

  it("contacts: frontmatter view over #contact notes, personal ones stay private", async () => {
    const list = await api("GET", "/api/contacts", "erin");
    expect(list.status).toBe(200);
    const freek = list.json.find((c: { name: string }) => c.name === "Pieter Haans");
    expect(freek).toMatchObject({ sector: "Finance", company: "Scooperz", email: "p.haans@example.com" });
    // mara files a private contact in her personal vault; erin never sees it
    await api("PUT", "/api/vault/note", "mara", {
      path: "Personal/mara/Contacts/Secret Source.md",
      content: "---\ntitle: Secret Source\ntags: [contact]\nsector: Marketing\n---\n# Secret Source\n",
    });
    const maraList = await api("GET", "/api/contacts", "mara");
    expect(maraList.json.some((c: { name: string; personal: boolean }) => c.name === "Secret Source" && c.personal)).toBe(true);
    const erinList = await api("GET", "/api/contacts", "erin");
    expect(erinList.json.some((c: { name: string }) => c.name === "Secret Source")).toBe(false);
  });

  it("companies: alphabetical #company view, positions list, patch keeps the body, personal stays private", async () => {
    const list = await api("GET", "/api/companies", "erin");
    expect(list.status).toBe(200);
    const names = list.json.map((c: { name: string }) => c.name);
    expect([...names].sort((a: string, b: string) => a.localeCompare(b))).toEqual(names);
    const scooperz = list.json.find((c: { name: string }) => c.name === "Scooperz");
    expect(scooperz).toMatchObject({ sector: "Marketing", linkedin: "linkedin.com/company/scooperz" });
    expect(scooperz.positions).toContain("Data Analyst intern");

    // front-matter patch: card fields change, the note body survives untouched
    const patch = await api("PATCH", `/api/companies/${scooperz.id}`, "erin", {
      description: "Social-media agency in Amsterdam.",
      positions: ["Data Analyst intern", "BI Intern"],
    });
    expect(patch.status).toBe(200);
    const note = await api("GET", `/api/vault/note/${scooperz.id}`, "erin");
    expect(note.json.content).toContain("Social-media agency in Amsterdam.");
    expect(note.json.content).toContain("People here: [[Marijke Elzinga]]");
    const after = (await api("GET", "/api/companies", "erin")).json.find((c: { name: string }) => c.name === "Scooperz");
    expect(after.positions).toEqual(["Data Analyst intern", "BI Intern"]);

    // a contact note is not a company note
    const freek = (await api("GET", "/api/contacts", "erin")).json.find((c: { name: string }) => c.name === "Pieter Haans");
    expect((await api("PATCH", `/api/companies/${freek.id}`, "erin", { description: "nope" })).status).toBe(400);

    // mara's personal company never reaches erin
    await api("PUT", "/api/vault/note", "mara", {
      path: "Personal/mara/Companies/Stealth Co.md",
      content: "---\ntitle: Stealth Co\ntags: [company]\npositions: [Growth Lead]\n---\n# Stealth Co\n",
    });
    const maraList = await api("GET", "/api/companies", "mara");
    expect(maraList.json.some((c: { name: string; personal: boolean }) => c.name === "Stealth Co" && c.personal)).toBe(true);
    const erinList = await api("GET", "/api/companies", "erin");
    expect(erinList.json.some((c: { name: string }) => c.name === "Stealth Co")).toBe(false);
  });

  describe("project workspace", () => {
    let slug = "";

    it("assembles the project note into a workspace: header, sections, people, tasks", async () => {
      const created = await api("POST", "/api/projects", "jules", { name: "Thesis Forecasting", domain: "academic" });
      expect(created.status).toBe(200);
      slug = created.json.slug;

      await api("PATCH", `/api/projects/${slug}`, "jules", { prompt: "Help with the AMSIB thesis.", status: "on-track", deadline: "2027-01-18" });
      await api("POST", `/api/projects/${slug}/decisions`, "jules", { text: "scope to NL vs FR" });
      await api("POST", `/api/projects/${slug}/capture`, "jules", { text: "ask Ruben for the Q3 export" });
      await api("POST", `/api/projects/${slug}/capture`, "jules", { text: "book the defence room", task: true });
      const freek = (await api("GET", "/api/contacts", "jules")).json.find((c: { name: string }) => c.name === "Pieter Haans");
      expect((await api("POST", `/api/projects/${slug}/people`, "jules", { noteId: freek.id })).status).toBe(200);

      const w = await api("GET", `/api/projects/${slug}`, "jules");
      expect(w.status).toBe(200);
      expect(w.json).toMatchObject({ name: "Thesis Forecasting", status: "on-track", deadline: "2027-01-18", domain: "academic" });
      expect(w.json.prompt).toBe("Help with the AMSIB thesis.");
      expect(w.json.decisions[0]).toContain("scope to NL vs FR");
      expect(w.json.inbox).toContain("ask Ruben for the Q3 export");
      expect(w.json.people.map((p: { title: string }) => p.title)).toContain("Pieter Haans");
      // a captured task is a real checkbox in the note, so it joins the board
      expect(w.json.tasks.some((t: { text: string }) => t.text.includes("book the defence room"))).toBe(true);
      // sections live in the note itself — delete the DB and this rebuilds
      expect(w.json.content).toContain("## Prompt");
      expect(w.json.content).toContain("[[Pieter Haans]]");
      // and the same project is listed
      expect((await api("GET", "/api/projects", "jules")).json.some((p: { slug: string }) => p.slug === slug)).toBe(true);
    });

    it("detaching a person drops only their link from ## People", async () => {
      const contacts = (await api("GET", "/api/contacts", "jules")).json;
      const freek = contacts.find((c: { name: string }) => c.name === "Pieter Haans");
      const esther = contacts.find((c: { name: string }) => c.name === "Marijke Elzinga");
      await api("POST", `/api/projects/${slug}/people`, "jules", { noteId: esther.id });
      expect((await api("GET", `/api/projects/${slug}`, "jules")).json.people).toHaveLength(2);

      expect((await api("DELETE", `/api/projects/${slug}/people/${freek.id}`, "jules")).status).toBe(200);
      const after = (await api("GET", `/api/projects/${slug}`, "jules")).json;
      expect(after.people.map((p: { title: string }) => p.title)).toEqual(["Marijke Elzinga"]);
      // the section survives, and so does everything else in the note
      expect(after.content).toContain("## People");
      expect(after.content).toContain("## Prompt");
    });

    it("patching header fields leaves every other section alone", async () => {
      const before = (await api("GET", `/api/projects/${slug}`, "jules")).json;
      expect(before.people.length).toBeGreaterThan(0);
      expect(before.decisions.length).toBeGreaterThan(0);

      expect((await api("PATCH", `/api/projects/${slug}`, "jules", { status: "at-risk", deadline: "2027-01-18" })).status).toBe(200);

      const after = (await api("GET", `/api/projects/${slug}`, "jules")).json;
      expect(after.status).toBe("at-risk");
      expect(after.deadline).toBe("2027-01-18");
      expect(after.people.map((p: { title: string }) => p.title)).toEqual(before.people.map((p: { title: string }) => p.title));
      expect(after.decisions).toEqual(before.decisions);
      expect(after.prompt).toBe(before.prompt);
      expect(after.inbox).toEqual(before.inbox);
    });

    it("the board carries each project's lifecycle status from its note", async () => {
      const board = async () => (await api("GET", "/api/dashboard/engineering", "jules")).json.projects;
      const mine = (rows: { project: string; status?: string; slug?: string }[]) => rows.find((p) => p.project === "Thesis Forecasting");

      expect(mine(await board())).toMatchObject({ slug, status: "at-risk" });

      await api("PATCH", `/api/projects/${slug}`, "jules", { status: "sleeping" });
      expect(mine(await board())?.status).toBe("sleeping");

      await api("PATCH", `/api/projects/${slug}`, "jules", { status: "cancelled" });
      expect(mine(await board())?.status).toBe("cancelled");

      // waking it up is the same one field, and the note keeps everything else
      await api("PATCH", `/api/projects/${slug}`, "jules", { status: "on-track" });
      const w = (await api("GET", `/api/projects/${slug}`, "jules")).json;
      expect(w.status).toBe("on-track");
      expect(w.people.length).toBeGreaterThan(0);
      expect(w.tasks.length).toBeGreaterThan(0);
    });

    it("documents land beside the note; traversal and dotfiles are refused", async () => {
      const pdf = Buffer.from("%PDF-1.4 hello thesis").toString("base64");
      expect((await api("POST", `/api/projects/${slug}/files`, "jules", { name: "brief.pdf", dataBase64: pdf })).status).toBe(200);

      const w = await api("GET", `/api/projects/${slug}`, "jules");
      expect(w.json.files.map((f: { name: string }) => f.name)).toEqual(["brief.pdf"]);
      expect(fs.existsSync(path.join(store.vaultRoot, "04-Projects", slug, "files", "brief.pdf"))).toBe(true);

      const dl = await app.inject({
        method: "GET",
        url: `/api/projects/${slug}/files/brief.pdf`,
        headers: { authorization: `Bearer ${tokens.jules}` },
      });
      expect(dl.statusCode).toBe(200);
      expect(dl.body).toContain("hello thesis");
      expect(dl.headers["x-content-type-options"]).toBe("nosniff");

      for (const name of ["../../escape.pdf", "..", ".ssh", "a/b.pdf"]) {
        expect((await api("POST", `/api/projects/${slug}/files`, "jules", { name, dataBase64: "aGk=" })).status).toBe(400);
      }
      // an .html document is never rendered on our own origin
      expect((await api("POST", `/api/projects/${slug}/files`, "jules", { name: "x.html", dataBase64: "PHNjcmlwdD4x" })).status).toBe(200);
      const html = await app.inject({
        method: "GET",
        url: `/api/projects/${slug}/files/x.html`,
        headers: { authorization: `Bearer ${tokens.jules}` },
      });
      expect(html.headers["content-disposition"]).toContain("attachment");

      // erin reads 04-Projects through the root viewer grant, but may not upload there
      expect((await api("GET", `/api/projects/${slug}`, "erin")).status).toBe(200);
      expect((await api("POST", `/api/projects/${slug}/files`, "erin", { name: "sneak.pdf", dataBase64: "aGk=" })).status).toBe(403);

      expect((await api("DELETE", `/api/projects/${slug}/files/brief.pdf`, "jules")).status).toBe(200);
      expect((await api("GET", `/api/projects/${slug}`, "jules")).json.files.some((f: { name: string }) => f.name === "brief.pdf")).toBe(false);
    });

    it("spreadsheets come back as capped rows, and only for readable projects", async () => {
      const ExcelJS = (await import("exceljs")).default;
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("Deals");
      ws.addRow(["Company", "Stage", "Value"]);
      ws.addRow(["Scooperz", "Won", 12500]);
      ws.addRow(["Adyen", "Proposal", 4000]);
      // a gap: exceljs rows are sparse, and a hole must reach the client as ""
      const gap = ws.addRow([]);
      gap.getCell(1).value = "Mollie";
      gap.getCell(3).value = 900;
      const buf = Buffer.from(await wb.xlsx.writeBuffer());
      expect((await api("POST", `/api/projects/${slug}/files`, "jules", { name: "deals.xlsx", dataBase64: buf.toString("base64") })).status).toBe(200);

      const sheet = await api("GET", `/api/projects/${slug}/files/deals.xlsx/sheet`, "jules");
      expect(sheet.status).toBe(200);
      expect(sheet.json.sheets).toHaveLength(1);
      expect(sheet.json.sheets[0].name).toBe("Deals");
      expect(sheet.json.sheets[0].rows[0]).toEqual(["Company", "Stage", "Value"]);
      expect(sheet.json.sheets[0].rows[1]).toEqual(["Scooperz", "Won", "12500"]);
      // every cell is a string — no holes, no nulls
      expect(sheet.json.sheets[0].rows[3]).toEqual(["Mollie", "", "900"]);
      for (const row of sheet.json.sheets[0].rows) {
        for (const c of row) expect(typeof c).toBe("string");
      }
      expect(sheet.json.sheets[0].truncated).toBe(false);

      // wrong type, and a project the caller cannot read
      expect((await api("GET", `/api/projects/${slug}/files/x.html/sheet`, "jules")).status).toBe(400);
      expect((await api("GET", "/api/projects/skunkworks/files/deals.xlsx/sheet", "erin")).status).toBe(404);
    });

    it("a project the caller cannot read is a 404 — workspace, documents and list (§5.4)", async () => {
      await api("PUT", "/api/vault/note", "mara", {
        path: "Personal/mara/Skunkworks.md",
        content: "---\ntitle: Skunkworks\ntags:\n  - project\n  - project/skunkworks\n---\n# Skunkworks\n\n- [ ] secret step\n",
      });
      expect((await api("GET", "/api/projects/skunkworks", "mara")).status).toBe(200);
      expect((await api("GET", "/api/projects/skunkworks", "erin")).status).toBe(404);
      expect((await api("GET", "/api/projects/skunkworks/files/x.pdf", "erin")).status).toBe(404);
      expect((await api("POST", "/api/projects/skunkworks/files", "erin", { name: "x.pdf", dataBase64: "aGk=" })).status).toBe(404);
      expect((await api("GET", "/api/projects", "erin")).json.some((p: { slug: string }) => p.slug === "skunkworks")).toBe(false);
    });
  });

  it("home aggregates personal stats, deadlines, agenda and focus", async () => {
    const r = await api("GET", "/api/home", "erin");
    expect(r.status).toBe(200);
    expect(r.json.stats.notes).toBeGreaterThan(0);
    expect(r.json.stats.openTasks).toBeGreaterThanOrEqual(0);
    expect(r.json.stats.overdueTasks).toBeGreaterThanOrEqual(0);
    // deadlines: dated open tasks only, ascending, each flagged against today
    expect(Array.isArray(r.json.deadlines)).toBe(true);
    const dues = r.json.deadlines.map((d: { due: string }) => d.due);
    expect(dues).toEqual([...dues].sort());
    const today = new Date().toISOString().slice(0, 10);
    for (const d of r.json.deadlines) expect(d.overdue).toBe(d.due < today);
    expect(Array.isArray(r.json.agenda)).toBe(true);
    expect(r.json.focus.length).toBeGreaterThan(0);
    // focus is ACL-filtered: no #only/marketing task leaks to erin
    expect(r.json.focus.some((f: { text: string }) => f.text === "finalize budget")).toBe(false);
    // and sorted by priority (p1 before unprioritised)
    const prios = r.json.focus.map((f: { priority: number | null }) => f.priority ?? 4);
    expect(prios).toEqual([...prios].sort((a: number, b: number) => a - b));
  });

  it("profile PATCH updates avatar and rejects junk", async () => {
    const r = await api("PATCH", "/api/me", "mara", { avatar: "ember" });
    expect(r.json.avatar).toBe("ember");
    const r2 = await api("PATCH", "/api/me", "mara", { avatar: "<script>" });
    expect(r2.json.avatar).toBe("ember"); // junk ignored, not applied
  });

  it("appearance round-trips on the account", async () => {
    const appearance = {
      theme: "command",
      vision: "custom:p1",
      profiles: [{ id: "p1", name: "Mine", colors: ["#23d6ff", "#ff589d", "#08ea7a", "#a88dff", "#e09100", "#31b0ff", "#f289db"] }],
    };
    const r = await api("PATCH", "/api/me", "mara", { appearance });
    expect(r.json.appearance).toEqual(appearance);
    // A second device asking who it is gets the same palette back.
    const me = await api("GET", "/api/me", "mara");
    expect(me.json.appearance.profiles[0].colors[1]).toBe("#ff589d");
  });

  it("appearance rejects anything that is not a colour", async () => {
    // These values are written straight into CSS custom properties on the
    // client, so the grammar is the guard: six hex digits, nothing else.
    const bad = (colors: string[]) =>
      api("PATCH", "/api/me", "mara", {
        appearance: { profiles: [{ id: "p1", name: "x", colors }] },
      });
    const seven = (c: string) => [c, "#ff589d", "#08ea7a", "#a88dff", "#e09100", "#31b0ff", "#f289db"];
    expect((await bad(seven("url(http://evil/x)"))).status).toBe(400);
    expect((await bad(seven("red; background: url(x)"))).status).toBe(400);
    expect((await bad(seven("var(--anything)"))).status).toBe(400);
    expect((await bad(["#23d6ff"])).status).toBe(400); // wrong length
    const badMode = await api("PATCH", "/api/me", "mara", { appearance: { vision: "custom:../../etc" } });
    expect(badMode.status).toBe(400);
    // The good value from the previous test is still what the account holds.
    const me = await api("GET", "/api/me", "mara");
    expect(me.json.appearance.profiles[0].colors[0]).toBe("#23d6ff");
  });
});

describe("history (§10)", () => {
  it("keeps per-note versions from the update log", async () => {
    const jules = await api("GET", "/api/vault/tree", "jules");
    const shared = jules.json.find((n: { path: string }) => n.path === "Shared/Meeting Notes 2026-07-01.md");
    const h = await api("GET", `/api/vault/note/${shared.id}/history`, "jules");
    expect(h.status).toBe(200);
    // initial + check + uncheck from the round-trip above = ≥3 versions,
    // with the checked state visible in a middle version only
    expect(h.json.length).toBeGreaterThanOrEqual(3);
    const contents = h.json.map((v: { content: string }) => v.content);
    expect(contents.some((c: string) => c.includes("- [x] schedule next sync"))).toBe(true);
    expect(contents[0]).toContain("- [ ] schedule next sync");
    expect(contents[contents.length - 1]).toContain("- [ ] schedule next sync");
  });
});

describe("mcp, watcher", () => {
  it("watcher rebase: external edits update the index and Y.Doc", async () => {
    const p = path.join(process.env.BASALT_DATA_DIR!, "vault", "Welcome.md");
    const before = fs.readFileSync(p, "utf8");
    fs.writeFileSync(p, before + "\nwatcher test line\n");

    // Wait for debounce + watcher
    await new Promise((r) => setTimeout(r, 500));

    // Check through API
    const res = await api("GET", "/api/vault/tree", "jules");
    const welcome = res.json.find((n: { path: string }) => n.path === "Welcome.md");
    const note = await api("GET", `/api/vault/note/${welcome.id}`, "jules");
    expect(note.json.content).toContain("watcher test line");
  });

  /**
   * The regression this exists for: the watcher used to ignore any event for a
   * path the server had written within the last second, so an external edit
   * landing in that window was dropped — and dropped permanently, because
   * nothing re-read the file afterwards. Writing through the API and editing the
   * file immediately after is the exact shape of "I added a subscription, then
   * corrected a number in Obsidian, and the dashboard never noticed."
   */
  it("indexes an external edit that lands immediately after the app's own write", async () => {
    const p = path.join(process.env.BASALT_DATA_DIR!, "vault", "Welcome.md");
    const welcomeId = (await api("GET", "/api/vault/tree", "jules")).json.find(
      (n: { path: string }) => n.path === "Welcome.md",
    ).id;

    // 1. the app writes
    const viaApp = `${fs.readFileSync(p, "utf8")}\napp wrote this\n`;
    const w = await api("PUT", "/api/vault/note", "jules", { path: "Welcome.md", content: viaApp });
    expect(w.status).toBe(200);

    // 2. something else edits the same file straight away
    fs.writeFileSync(p, `${viaApp}edited on disk right after\n`);
    await new Promise((r) => setTimeout(r, 900));

    const note = await api("GET", `/api/vault/note/${welcomeId}`, "jules");
    expect(note.json.content).toContain("edited on disk right after");
  });

  it("does not re-index its own write when nothing else touched the file", async () => {
    const p = path.join(process.env.BASALT_DATA_DIR!, "vault", "Welcome.md");
    await api("PUT", "/api/vault/note", "jules", { path: "Welcome.md", content: "# Welcome\n\nquiet write\n" });
    const settled = fs.readFileSync(p, "utf8");
    await new Promise((r) => setTimeout(r, 900));
    // The echo changed nothing: the file is still exactly what was written.
    expect(fs.readFileSync(p, "utf8")).toBe(settled);
  });
});

/**
 * Path handling is part of the permission model, not plumbing around it: every
 * ACL decision is made about a *folder*, and the folder is derived from the path
 * the caller supplied. If that string is judged before it is canonicalised, the
 * two disagree — `Personal/<me>/../../X/n.md` reads as the caller's own personal
 * vault, then lands in X. Callers that go through `noteWriteSchema` are shielded
 * by its no-`..` regex, but `store.write` is also reached directly (the AI
 * `write_note` tool passes a model-supplied string), so the guarantee has to
 * live here.
 */
describe("vault path canonicalisation (§5)", () => {
  const vaultRoot = () => path.join(process.env.BASALT_DATA_DIR!, "vault");
  const mara = () => store.aclUser(db.select().from(tables.users).where(eq(tables.users.username, "mara")).get()!.id);

  it("does not let a personal-vault prefix launder a write into another team's folder", () => {
    // mara is marketing-only, so she has no edit grant on Engineering/. Once the
    // path is canonicalised the ACL sees "Engineering" and refuses on its own —
    // uncanonicalised it saw "Personal/mara/../.." and read that as her own space.
    expect(() => store.write(mara(), "Personal/mara/../../Engineering/planted.md", "# planted\n")).toThrow(
      /do not have edit access/,
    );
    expect(fs.existsSync(path.join(vaultRoot(), "Engineering/planted.md"))).toBe(false);
  });

  it("does not let one user write into another user's personal vault", () => {
    expect(() => store.write(mara(), "Personal/mara/../erin/planted.md", "# planted\n")).toThrow(
      /do not have edit access/,
    );
    expect(fs.existsSync(path.join(vaultRoot(), "Personal/erin/planted.md"))).toBe(false);
  });

  it("refuses to escape the vault root, including via a same-prefix sibling", () => {
    // Deliberately the owner: owners bypass every ACL check, so the path guard is
    // the only thing left standing. `path.join` + a bare startsWith(root) accepts
    // this — the resolved path begins with the root *string*, but the directory
    // is a sibling of the vault.
    const jules = store.aclUser(db.select().from(tables.users).where(eq(tables.users.username, "jules")).get()!.id);
    expect(jules.isOwner).toBe(true);
    expect(() => store.write(jules, "../vault-evil/planted.md", "# planted\n")).toThrow(/invalid path/);
    expect(fs.existsSync(path.join(process.env.BASALT_DATA_DIR!, "vault-evil"))).toBe(false);
    expect(() => store.write(jules, "/etc/basalt-planted.md", "# planted\n")).toThrow(/invalid path/);
  });

  it("still accepts a redundant but harmless path, normalised", () => {
    // Marketing may edit Shared/; "./" and doubled slashes are not an attack.
    const note = store.write(mara(), "Shared/./notes-canon.md", "# canon\n");
    expect(note.path).toBe("Shared/notes-canon.md");
    expect(fs.existsSync(path.join(vaultRoot(), "Shared/notes-canon.md"))).toBe(true);
  });

  it("rejects non-markdown targets", () => {
    expect(() => store.write(mara(), "Shared/.env", "SECRET=1\n")).toThrow();
  });
});

describe("production secret guard", () => {
  it("refuses to boot in production on a shipped placeholder", async () => {
    const { assertProductionSecrets } = await import("../src/env.js");
    // env.jwtSecret is "test-secret" here, so only the untouched key trips it.
    expect(() => assertProductionSecrets("production")).toThrow(/BASALT_SECRET_KEY/);
    expect(() => assertProductionSecrets("development")).not.toThrow();
  });
});
