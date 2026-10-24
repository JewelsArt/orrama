/**
 * The project page's own changes (stage 1, 1E): rename, delete to the trash and back, a
 * project removed from the board put back, an existing note added and taken off, a decision,
 * an inbox line or a goal changed and removed, an inbox line made a step, a document renamed
 * and put in the trash. Each is checked in the note's bytes, as a person would have typed it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessionOf, signedIn } from "./helpers/session.js";

process.env.ORRAMA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-project-actions-"));
process.env.ORRAMA_VAULT_DIR = path.join(process.env.ORRAMA_DATA_DIR, "vault");
process.env.ORRAMA_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.ORRAMA_SECRET_KEY = "test-secret-key-0123456789abcdef";

await import("../src/seed.js");
const { buildServer } = await import("../src/main.js");
const { tables } = await import("../src/db.js");
const { closeDb } = await import("./helpers/db.js");

type Built = Awaited<ReturnType<typeof buildServer>>;
let built: Built;
let token = "";
const VAULT = process.env.ORRAMA_VAULT_DIR;

const api = async (method: string, url: string, body?: unknown) => {
  const res = await built.app.inject({ method: method as "GET", url, headers: signedIn(token), ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}) });
  return { status: res.statusCode, json: (() => { try { return res.json(); } catch { return null; } })() };
};
const put = async (rel: string, content: string) => {
  const r = await api("PUT", "/api/vault/note", { path: rel, content });
  expect(r.status).toBe(200);
  return r.json.id as string;
};
/** A note's bytes, less the `id:` line the first index stamps into it. */
const onDisk = (rel: string) => fs.readFileSync(path.join(VAULT, rel), "utf8").replace(/^id: n-[^\n]*\n/m, "");
const exists = (rel: string) => fs.existsSync(path.join(VAULT, rel));
const b64 = (s: string) => Buffer.from(s).toString("base64");
const row = (key: string) => built.db.select().from(tables.projects).where(eq(tables.projects.key, key)).get();
const boardSlugs = async () => ((await api("GET", "/api/projects")).json as { slug: string }[]).map((p) => p.slug);

beforeAll(async () => {
  built = await buildServer();
  token = sessionOf(await built.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "jules@orrama.dev", password: "orrama-demo" } }));
});
afterAll(async () => {
  await built.app.close();
  closeDb(built.db);
});

describe("a new project", () => {
  it("is scaffolded with its first step under ## Tasks, where Add a step puts the next ones", async () => {
    const made = await api("POST", "/api/projects", { name: "Garden shed" });
    expect(made.status).toBe(200);
    await api("POST", `/api/projects/${made.json.slug}/capture`, { text: "Buy timber", task: true });
    const text = onDisk(made.json.path);
    expect(text).toMatch(/## Tasks\n\n- \[ \] First step\n- \[ \] Buy timber\n/);
    expect(text.match(/## Tasks/g)).toHaveLength(1);
  });

  it("keeps letters of any script in its key (Thèse is thèse, not th-se)", async () => {
    const made = await api("POST", "/api/projects", { name: "Thèse de fin d'études" });
    expect(made.json.slug).toBe("thèse-de-fin-d-études");
    expect((await api("GET", `/api/projects/${encodeURIComponent(made.json.slug)}`)).json.name).toBe("Thèse de fin d'études");
  });

  it("with a name whose key is taken gets the next free key, never joining or replacing the other", async () => {
    // A note elsewhere already carries project/orchard: a second "Orchard" must not join it.
    await put("Ideas/Orchard plan.md", "---\ntitle: Orchard plan\ntags: [project/orchard]\n---\n- [ ] dig\n");
    const made = await api("POST", "/api/projects", { name: "Orchard" });
    expect(made.status).toBe(200);
    expect(made.json.slug).toBe("orchard-2");
    expect(onDisk("Ideas/Orchard plan.md")).toContain("project/orchard]");
    expect((await api("GET", "/api/projects/orchard")).json.path).toBe("Ideas/Orchard plan.md");
  });

  it("never takes the key of a note at the conventional path in another case, tagged or not", async () => {
    await put("04-Projects/Mill.md", "---\ntitle: Mill notes\n---\nnot a project\n");
    const made = await api("POST", "/api/projects", { name: "Mill" });
    expect(made.json.slug).toBe("mill-2");
    expect(onDisk("04-Projects/Mill.md")).toBe("---\ntitle: Mill notes\n---\nnot a project\n");
  });

  it("Make this a project on a note whose key is taken picks a free one (it joined the other project silently)", async () => {
    await put("04-Projects/kiln.md", "---\ntitle: Kiln\ntags: [project, project/kiln]\nstatus: planned\n---\n# Kiln\n");
    const id = await put("Ideas/Kiln.md", "---\ntitle: Kiln\n---\nA second kiln idea.\n");
    const res = await api("POST", "/api/projects/promote", { noteId: id });
    expect(res.json.key).toBe("project/kiln-2");
    expect(onDisk("Ideas/Kiln.md")).toContain("project/kiln-2");
    expect(onDisk("Ideas/Kiln.md")).not.toMatch(/project\/kiln\b(?!-)/);
  });
});

describe("rename", () => {
  it("writes title: and the # heading that said the old name; the key, the file and the tags stay", async () => {
    await put("04-Projects/pottery.md", "---\ntitle: Pottery\ntags: [project, project/pottery]\nstatus: on-track\n---\n# Pottery\n\nSome words about Pottery.\n");
    await put("Ideas/Glazes.md", "---\ntitle: Glazes\ntags: [project/pottery]\n---\nnotes\n");
    expect((await api("PATCH", "/api/projects/pottery", { name: "Ceramics studio" })).status).toBe(200);
    expect(onDisk("04-Projects/pottery.md")).toBe("---\ntitle: Ceramics studio\ntags: [project, project/pottery]\nstatus: on-track\n---\n# Ceramics studio\n\nSome words about Pottery.\n");
    expect(onDisk("Ideas/Glazes.md")).toContain("project/pottery");
    const w = (await api("GET", "/api/projects/pottery")).json;
    expect(w.name).toBe("Ceramics studio");
    expect(w.slug).toBe("pottery");
  });

  it("adds title: to a note that had none and leaves a heading that said something else", async () => {
    await put("04-Projects/loom.md", "---\ntags: [project/loom]\n---\n# Weaving notes\n");
    await api("PATCH", "/api/projects/loom", { name: "Loom" });
    expect(onDisk("04-Projects/loom.md")).toBe("---\ntags: [project/loom]\ntitle: Loom\n---\n# Weaving notes\n");
  });

  it("refuses an empty name, and properties it can't read, writing nothing", async () => {
    expect((await api("PATCH", "/api/projects/loom", { name: "   " })).status).toBe(400);
    await put("04-Projects/broken.md", "---\ntags: [project/broken]\ntitle: [unclosed\n---\n# Broken\n");
    const before = onDisk("04-Projects/broken.md");
    expect((await api("PATCH", "/api/projects/broken", { name: "Fixed" })).status).toBe(409);
    expect(onDisk("04-Projects/broken.md")).toBe(before);
  });
});

describe("dates", () => {
  it("a cleared date removes its line instead of writing start: \"\"", async () => {
    await api("PATCH", "/api/projects/loom", { start: "2026-11-02", deadline: "2026-12-01" });
    expect(onDisk("04-Projects/loom.md")).toContain("start: 2026-11-02");
    await api("PATCH", "/api/projects/loom", { start: "" });
    const text = onDisk("04-Projects/loom.md");
    expect(text).not.toContain("start:");
    expect(text).toContain("deadline: 2026-12-01");
  });
});

const BAKERY = [
  "---",
  "title: Bakery",
  "tags: [project, project/bakery]",
  "---",
  "# Bakery",
  "",
  "## Decisions",
  "- **2026-10-01** — Sourdough only",
  "- **2026-10-05** — Open on Sundays",
  "",
  "## Inbox",
  "- Ask about the oven",
  "- Flour supplier list",
  "",
  "## Goals",
  "- [ ] Break even",
  "  - by March",
  "",
  "## Tasks",
  "",
  "- [ ] Sign the lease",
  "",
].join("\n");

describe("decisions, inbox lines and goals", () => {
  it("a decision's words change and its day stays", async () => {
    await put("04-Projects/bakery.md", BAKERY);
    const r = await api("PATCH", "/api/projects/bakery/lines", { section: "decisions", index: 1, text: "**2026-10-05** — Open on Sundays", to: "Open on Saturdays" });
    expect(r.status).toBe(200);
    expect(onDisk("04-Projects/bakery.md")).toBe(BAKERY.replace("Open on Sundays", "Open on Saturdays"));
  });

  it("an edit to a line that moved since the page was read is a 409, and nothing is written", async () => {
    const before = onDisk("04-Projects/bakery.md");
    const r = await api("PATCH", "/api/projects/bakery/lines", { section: "decisions", index: 0, text: "**2026-10-05** — Open on Saturdays", to: "x" });
    expect(r.status).toBe(409);
    expect(onDisk("04-Projects/bakery.md")).toBe(before);
  });

  it("an inbox line is removed, and another becomes a step under ## Tasks", async () => {
    await api("POST", "/api/projects/bakery/lines/remove", { section: "inbox", index: 1, text: "Flour supplier list" });
    let text = onDisk("04-Projects/bakery.md");
    expect(text).toContain("## Inbox\n- Ask about the oven\n\n## Goals");
    expect((await api("POST", "/api/projects/bakery/lines/step", { section: "inbox", index: 0, text: "Ask about the oven" })).status).toBe(200);
    text = onDisk("04-Projects/bakery.md");
    expect(text).toContain("## Inbox\n\n## Goals");
    expect(text).toContain("## Tasks\n\n- [ ] Sign the lease\n- [ ] Ask about the oven\n");
    expect((await api("POST", "/api/projects/bakery/lines/step", { section: "decisions", index: 0, text: "**2026-10-01** — Sourdough only" })).status).toBe(400);
  });

  it("a goal is added, a nested one changed with its indent and checkbox, one removed", async () => {
    await api("POST", "/api/projects/bakery/goals", { text: "Hire a baker" });
    await api("PATCH", "/api/projects/bakery/lines", { section: "goals", index: 1, text: "by March", to: "by April" });
    await api("POST", "/api/projects/bakery/lines/remove", { section: "goals", index: 0, text: "Break even" });
    expect(onDisk("04-Projects/bakery.md")).toContain("## Goals\n  - by April\n- Hire a baker\n\n## Tasks");
    expect((await api("GET", "/api/projects/bakery")).json.goals).toEqual(["by April", "Hire a baker"]);
  });

  it("a change with no words is refused (removing is its own action)", async () => {
    expect((await api("PATCH", "/api/projects/bakery/lines", { section: "goals", index: 1, text: "Hire a baker", to: " " })).status).toBe(400);
  });
});

describe("an existing note joins and leaves", () => {
  it("Add writes the project tag (moving it from another project); Remove takes only that tag off", async () => {
    const id = await put("Ideas/Rye starter.md", "---\ntitle: Rye starter\ntags: [baking, project/pottery]\n---\nfeed daily\n");
    const found = (await api("GET", "/api/projects/bakery/notes/candidates?q=rye")).json as { id: string; project: string | null }[];
    expect(found.find((n) => n.id === id)?.project).toBe("Ceramics studio");
    expect((await api("POST", "/api/projects/bakery/notes", { noteId: id })).status).toBe(200);
    expect(onDisk("Ideas/Rye starter.md")).toBe("---\ntitle: Rye starter\ntags:\n  - baking\n  - project/bakery\n---\nfeed daily\n");
    expect(((await api("GET", "/api/projects/bakery")).json.notes as { id: string }[]).map((n) => n.id)).toContain(id);
    expect(((await api("GET", "/api/projects/bakery/notes/candidates?q=rye")).json as { id: string }[]).map((n) => n.id)).not.toContain(id);

    expect((await api("DELETE", `/api/projects/bakery/notes/${id}`)).status).toBe(200);
    expect(onDisk("Ideas/Rye starter.md")).toBe("---\ntitle: Rye starter\ntags:\n  - baking\n---\nfeed daily\n");
  });

  it("a note with no properties gets them; another project's own note can't join", async () => {
    const id = await put("Ideas/Loose.md", "Just text.\n");
    await api("POST", "/api/projects/bakery/notes", { noteId: id });
    expect(onDisk("Ideas/Loose.md")).toBe("---\ntags:\n  - project/bakery\n---\nJust text.\n");
    const own = built.store.index.getByPath("04-Projects/pottery.md")!.id;
    expect((await api("POST", "/api/projects/bakery/notes", { noteId: own })).status).toBe(400);
    expect(onDisk("04-Projects/pottery.md")).toContain("project/pottery");
  });
});

describe("delete", () => {
  it("says what goes and what stays, then puts the note, its folder's notes and its files in the trash", async () => {
    await put("04-Projects/fair.md", "---\ntitle: Craft fair\ntags: [project, project/fair]\nstatus: on-track\n---\n# Craft fair\n\n## Tasks\n\n- [ ] Book a stand\n");
    await put("04-Projects/fair/Stand plan.md", "---\ntitle: Stand plan\ntags: [project/fair]\n---\nplan\n");
    await put("Meetings/Fair call.md", "---\ntitle: Fair call\ntags: [meeting, project/fair]\n---\nwe spoke\n");
    expect((await api("POST", "/api/projects/fair/files", { name: "flyer.pdf", dataBase64: b64("%PDF-1.4 x") })).status).toBe(200);
    expect((await api("GET", "/api/projects/fair/board")).status).toBe(200);

    const plan = (await api("GET", "/api/projects/fair/removal")).json;
    expect(plan.note.title).toBe("Craft fair");
    expect(plan.inFolder.map((n: { title: string }) => n.title)).toEqual(["Stand plan"]);
    expect(plan.files).toBe(1);
    expect(plan.elsewhere.map((n: { title: string }) => n.title)).toEqual(["Fair call"]);
    expect(plan.canDelete).toBe(true);

    const res = await api("POST", "/api/projects/fair/trash");
    expect(res.status).toBe(200);
    expect(res.json.trashed[0]).toBe(".trash/04-Projects/fair.md");
    expect(res.json.trashed).toEqual(expect.arrayContaining([".trash/04-Projects/fair/Stand plan.md", ".trash/04-Projects/fair/files/flyer.pdf"]));
    expect(exists("04-Projects/fair.md")).toBe(false);
    expect(exists("04-Projects/fair")).toBe(false);
    expect(exists(".trash/04-Projects/fair/files/flyer.pdf")).toBe(true);
    // The note elsewhere stays and loses only the project.
    expect(onDisk("Meetings/Fair call.md")).toBe("---\ntitle: Fair call\ntags:\n  - meeting\n---\nwe spoke\n");
    expect(res.json.untagged).toEqual([built.store.index.getByPath("Meetings/Fair call.md")!.id]);
    // Off the board, its registration gone, so no empty "Craft fair" lingers for the owner.
    expect(await boardSlugs()).not.toContain("fair");
    expect(row("project/fair")).toBeUndefined();
    const dash = (await api("GET", "/api/dashboard")).json.projects as { project: string }[];
    expect(dash.map((p) => p.project)).not.toContain("Craft fair");
    expect((await api("GET", "/api/projects/fair")).status).toBe(404);
  });

  it("restoring the note from the trash puts the project back on the board", async () => {
    expect((await api("POST", "/api/vault/trash/restore", { path: ".trash/04-Projects/fair.md" })).status).toBe(200);
    expect(await boardSlugs()).toContain("fair");
    expect((await api("POST", "/api/vault/trash/restore", { path: ".trash/04-Projects/fair/files/flyer.pdf" })).status).toBe(200);
    expect(((await api("GET", "/api/projects/fair")).json.files as { name: string }[]).map((f) => f.name)).toEqual(["flyer.pdf"]);
  });

  it("a project note trashed from Notes takes its registration with it too", async () => {
    await put("04-Projects/drift.md", "---\ntitle: Drift\ntags: [project, project/drift]\n---\n# Drift\n");
    expect(row("project/drift")).toBeDefined();
    expect((await api("POST", "/api/vault/trash", { path: "04-Projects/drift.md" })).status).toBe(200);
    expect(row("project/drift")).toBeUndefined();
  });
});

describe("removed from the board", () => {
  it("is listed on its shelf with its name and put back", async () => {
    const id = row("project/loom")!.id;
    expect((await api("DELETE", `/api/admin/projects/${id}`)).status).toBe(200);
    expect(await boardSlugs()).not.toContain("loom");
    const hidden = (await api("GET", "/api/admin/projects/hidden")).json as { id: string; slug: string; name: string }[];
    expect(hidden).toContainEqual({ id, slug: "loom", name: "Loom" });
    expect((await api("POST", `/api/admin/projects/${id}/back`)).status).toBe(200);
    expect(await boardSlugs()).toContain("loom");
    expect((await api("GET", "/api/admin/projects/hidden")).json).not.toContainEqual(expect.objectContaining({ id }));
  });
});

describe("documents", () => {
  it("rename keeps the extension, refuses another one, a taken name and a path, and the board's card follows", async () => {
    await api("POST", "/api/projects/bakery/files", { name: "menu.pdf", dataBase64: b64("%PDF menu") });
    await api("POST", "/api/projects/bakery/files", { name: "prices.pdf", dataBase64: b64("%PDF prices") });
    const board = (await api("GET", "/api/projects/bakery/board")).json;
    const { canEdit: _c, ...saved } = board;
    expect((await api("PUT", "/api/projects/bakery/board", saved)).status).toBe(200);
    const card = (board.nodes as { id: string; file?: string }[]).find((n) => n.file?.endsWith("/menu.pdf"))!;

    const r = await api("POST", "/api/projects/bakery/files/menu.pdf/rename", { to: "Winter menu" });
    expect(r.status).toBe(200);
    expect(r.json.name).toBe("Winter menu.pdf");
    expect(exists("04-Projects/bakery/files/Winter menu.pdf")).toBe(true);
    expect(exists("04-Projects/bakery/files/menu.pdf")).toBe(false);
    const after = (await api("GET", "/api/projects/bakery/board")).json.nodes as { id: string; file?: string }[];
    expect(after.find((n) => n.id === card.id)?.file).toBe("04-Projects/bakery/files/Winter menu.pdf");

    expect((await api("POST", "/api/projects/bakery/files/prices.pdf/rename", { to: "prices.docx" })).status).toBe(400);
    expect((await api("POST", "/api/projects/bakery/files/prices.pdf/rename", { to: "winter MENU.pdf" })).status).toBe(409);
    expect((await api("POST", "/api/projects/bakery/files/prices.pdf/rename", { to: "../escape" })).status).toBe(400);
    expect((await api("POST", "/api/projects/bakery/files/prices.pdf/rename", { to: "a/b" })).status).toBe(400);
    expect(exists("04-Projects/bakery/files/prices.pdf")).toBe(true);
  });

  it("delete puts the file in the trash, where it can be restored", async () => {
    const r = await api("DELETE", "/api/projects/bakery/files/prices.pdf");
    expect(r.status).toBe(200);
    expect(r.json.trashPath).toBe(".trash/04-Projects/bakery/files/prices.pdf");
    expect(exists("04-Projects/bakery/files/prices.pdf")).toBe(false);
    const trash = (await api("GET", "/api/vault/trash")).json as { path: string; kind: string }[];
    expect(trash).toContainEqual(expect.objectContaining({ path: ".trash/04-Projects/bakery/files/prices.pdf", kind: "file" }));
    expect((await api("POST", "/api/vault/trash/restore", { path: r.json.trashPath })).status).toBe(200);
    expect(onDisk("04-Projects/bakery/files/prices.pdf")).toBe("%PDF prices");
  });
});

describe("a folder project", () => {
  it("follows its folder when the folder is renamed", async () => {
    await put("Studio/Brief.md", "# Brief\n");
    built.db.insert(tables.projects).values({ id: "p-studio", kind: "folder", key: "Studio", name: "Studio", teamId: null, domain: null, hidden: null, noteId: null }).run();
    expect((await api("POST", "/api/vault/folder/move", { from: "Studio", to: "Workshop" })).status).toBe(200);
    expect(built.db.select().from(tables.projects).where(eq(tables.projects.id, "p-studio")).get()?.key).toBe("Workshop");
  });
});
