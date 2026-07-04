/**
 * API-level integration tests: the §5 permission model enforced over real HTTP,
 * plus the file-is-source-of-truth loop (dashboard checkbox → Markdown edit).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.BASALT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "basalt-test-"));
process.env.BASALT_JWT_SECRET = "test-secret";

const { buildServer } = await import("../src/main.js");

let app: Awaited<ReturnType<typeof buildServer>>["app"];
let db: Awaited<ReturnType<typeof buildServer>>["db"];
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

  it("profile PATCH updates avatar and rejects junk", async () => {
    const r = await api("PATCH", "/api/me", "mara", { avatar: "ember" });
    expect(r.json.avatar).toBe("ember");
    const r2 = await api("PATCH", "/api/me", "mara", { avatar: "<script>" });
    expect(r2.json.avatar).toBe("ember"); // junk ignored, not applied
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
