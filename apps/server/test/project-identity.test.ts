/**
 * A project is its tag (audit COR-004, COR-006, REG-017).
 *
 * - COR-004: every aggregate joined tasks to projects by display NAME — the
 *   title of whichever tagged note was indexed first. Two projects whose notes
 *   share a title were one card with both task lists, and a project could be
 *   named after its chapter draft.
 * - COR-006: an inline `#project/x` in a note's body made it a member, and the
 *   workspace decided membership with only its own definition, so a note
 *   tagged with two projects counted in one on the list and both on the pages.
 * - REG-017: registration, the board and the routes used three slug grammars;
 *   `project/my_thesis` got a card every route answered 404.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.ORRAMA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-project-identity-"));
process.env.ORRAMA_VAULT_DIR = path.join(process.env.ORRAMA_DATA_DIR, "vault");
process.env.ORRAMA_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.ORRAMA_SECRET_KEY = "test-secret-key-0123456789abcdef";

const VAULT = process.env.ORRAMA_VAULT_DIR;
fs.mkdirSync(VAULT, { recursive: true });
await import("../src/seed.js");

const put = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(VAULT, rel)), { recursive: true });
  fs.writeFileSync(path.join(VAULT, rel), text);
};
// Two projects whose project notes are both called "Plan".
put("04-Projects/alpha.md", "---\ntitle: Plan\ntags: [project/alpha]\n---\n- [ ] alpha one\n- [x] alpha two\n");
put("04-Projects/beta.md", "---\ntitle: Plan\ntags: [project/beta]\n---\n- [ ] beta one\n");
// A project note with no title: of its own.
put("04-Projects/untitled.md", "---\ntags: [project/untitled]\n---\n# Project \u2014 Untitled\n\n- [ ] something\n");
// A chapter draft tagged into a project with a project note of its own.
put("04-Projects/thesis.md", "---\ntitle: Graduation Thesis\ntags: [project/thesis]\ndeadline: 2026-11-30\n---\n- [ ] defend\n");
put("04-Projects/thesis/ch1.md", "---\ntitle: Chapter One\ntags: [project/thesis]\n---\n- [ ] write ch1\n");
// A daily note that only mentions a project; a note tagged with two.
put("Daily/2026-10-01.md", "# Thursday\n\nWorked on #project/alpha today.\n\n- [ ] buy milk\n- [ ] call the dentist\n");
put("Notes/shared.md", "---\ntags: [project/alpha, project/beta]\n---\n- [ ] shared one\n- [ ] shared two\n");
// Slugs every other surface accepts.
put("Notes/My thesis.md", "---\ntitle: My Thesis\ntags: [project/my_thesis]\n---\n- [ ] underscore\n");
put("Notes/R\u00e9union.md", "---\ntitle: R\u00e9union\ntags: [project/r\u00e9union]\n---\n- [ ] accent\n");
put("Notes/Nested.md", "---\ntags: [project/thesis/2026]\n---\n- [ ] nested\n");
// Registered by the old grammar (no length cap) before this fix, still in the database.
const LONG = "x".repeat(70);
put("Notes/Long.md", `---\ntitle: Long\ntags: [project/${LONG}]\n---\n- [ ] long\n`);

const { buildServer } = await import("../src/main.js");
const { tables } = await import("../src/db.js");

let b: Awaited<ReturnType<typeof buildServer>>;
let token = "";
const get = async (url: string) => {
  const res = await b.app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
  return { status: res.statusCode, json: res.json() };
};
type Row = { slug: string; key: string; name: string; total: number; done: number };
const list = async () => (await get("/api/projects")).json as Row[];
const row = async (slug: string) => (await list()).find((p) => p.slug === slug)!;
const workspace = async (slug: string) => (await get(`/api/projects/${encodeURIComponent(slug)}`)).json as { name: string; total: number; tasks: { text: string }[]; notes: { path: string }[] };
const board = async () =>
  ((await get("/api/dashboard/engineering")).json.projects as { project: string; slug?: string | null; total: number; tasks: { text: string }[] }[]);

beforeAll(async () => {
  b = await buildServer();
  token = (await b.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "jules@orrama.dev", password: "orrama-demo" } })).json().token;
});
afterAll(async () => {
  await b.app.close();
  fs.rmSync(process.env.ORRAMA_DATA_DIR!, { recursive: true, force: true });
});

describe("projects are told apart by key, not name (COR-004)", () => {
  it("two projects called \"Plan\" keep their own totals and tasks on every surface", async () => {
    const alpha = await row("alpha");
    const beta = await row("beta");
    expect([alpha.name, beta.name]).toEqual(["Plan", "Plan"]);
    expect([alpha.total, alpha.done]).toEqual([4, 1]); // its own two + the two-project note's two
    expect([beta.total, beta.done]).toEqual([1, 0]);
    expect((await workspace("alpha")).tasks.map((t) => t.text).sort()).toEqual(["alpha one", "alpha two", "shared one", "shared two"]);
    expect((await workspace("beta")).tasks.map((t) => t.text)).toEqual(["beta one"]);

    const cards = (await board()).filter((p) => p.slug === "alpha" || p.slug === "beta");
    expect(cards.map((c) => [c.slug, c.total]).sort()).toEqual([["alpha", 4], ["beta", 1]]);
    expect(cards.find((c) => c.slug === "beta")!.tasks.map((t) => t.text)).toEqual(["beta one"]);
  });

  it("a project is named by its project note, whatever the row froze", async () => {
    // Registration named the row after the first tagged note it met — after a
    // rebuild, walk order. Simulate the chapter winning.
    b.db.update(tables.projects).set({ name: "Chapter One" }).where(eq(tables.projects.key, "project/thesis")).run();
    expect((await row("thesis")).name).toBe("Graduation Thesis");
    expect((await workspace("thesis")).name).toBe("Graduation Thesis");
    expect((await board()).find((p) => p.slug === "thesis")!.project).toBe("Graduation Thesis");
    const tasks = (await get("/api/tasks")).json as { text: string; project: string | null }[];
    expect(tasks.find((t) => t.text === "write ch1")!.project).toBe("Graduation Thesis");
    // Planning (its backlog) and the calendar's milestones say the same.
    const plan = (await get("/api/plan")).json as { assignees: { tasks: { text: string; project: string | null }[] }[] };
    expect(plan.assignees.flatMap((a) => a.tasks).find((t) => t.text === "write ch1")!.project).toBe("Graduation Thesis");
    const markers = (await get("/api/calendar/markers?from=2026-01-01&to=2026-12-31")).json as { kind: string; source: string | null; title: string }[];
    expect(markers.filter((m) => m.kind === "milestone").map((m) => m.title)).toContain("Graduation Thesis due");
  });

  it("a project note with no title: keeps the name the project already had", async () => {
    b.db.update(tables.projects).set({ name: "Untitled Project" }).where(eq(tables.projects.key, "project/untitled")).run();
    expect((await row("untitled")).name).toBe("Untitled Project");
    expect((await workspace("untitled")).name).toBe("Untitled Project");
    expect((await board()).find((p) => p.slug === "untitled")!.project).toBe("Untitled Project");
  });
});

describe("membership is the front-matter tag, the same on every surface (COR-006)", () => {
  it("a body mention of #project/alpha joins nothing", async () => {
    const ws = await workspace("alpha");
    expect(ws.tasks.map((t) => t.text)).not.toContain("buy milk");
    expect(ws.notes.map((n) => n.path)).not.toContain("Daily/2026-10-01.md");
    const tasks = (await get("/api/tasks")).json as { text: string; project: string | null }[];
    expect(tasks.find((t) => t.text === "buy milk")!.project).toBeNull();
  });

  it("every project's list total equals its workspace total", async () => {
    for (const p of await list()) {
      expect([p.slug, (await workspace(p.slug)).total]).toEqual([p.slug, p.total]);
    }
  });
});

describe("one slug grammar (REG-017)", () => {
  it("a project tagged project/my_thesis is on the list and opens, board included", async () => {
    expect((await row("my_thesis")).name).toBe("My Thesis");
    expect((await get("/api/projects/my_thesis")).status).toBe(200);
    expect((await get("/api/projects/my_thesis/board")).status).toBe(200);
    expect((await board()).find((p) => p.project === "My Thesis")!.slug).toBe("my_thesis");
  });

  it("so does a slug in another script", async () => {
    expect((await row("r\u00e9union")).total).toBe(1);
    expect((await get(`/api/projects/${encodeURIComponent("r\u00e9union")}`)).status).toBe(200);
    expect((await get(`/api/projects/${encodeURIComponent("re\u0301union")}`)).status).toBe(200); // decomposed in the URL
  });

  it("a nested tag is no project anywhere", async () => {
    expect((await list()).some((p) => p.key.startsWith("project/thesis/"))).toBe(false);
    expect(b.db.select().from(tables.projects).all().some((p) => p.key === "project/thesis/2026")).toBe(false);
  });

  it("a project registered under the old grammar gets no card that cannot open", async () => {
    b.db.insert(tables.projects).values({ id: "p-legacy", kind: "tag", key: `project/${LONG}`, name: "Long", teamId: null, domain: null, hidden: null }).run();
    expect((await list()).some((p) => p.key === `project/${LONG}`)).toBe(false);
    const card = (await board()).find((p) => p.project === "Long");
    expect(card?.slug ?? null).toBeNull();
    expect((await get(`/api/projects/${LONG}`)).status).toBe(404);
  });

  it("a slug that could leave the folder is still not a project", async () => {
    for (const bad of ["..", "a.b", "a%2Fb", "-x", "_x"]) expect((await get(`/api/projects/${bad}`)).status).toBe(404);
  });
});
