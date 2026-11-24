/**
 * Make a project from a note (N2): the project is made once, by the same path New → Project
 * takes, with the `project` and `project/<key>` tags; the note joins it by its tag and moves
 * only when asked; its tasks count once; a note in another project is asked about first; a
 * refusal leaves nothing behind; and the page's Undo (move back, delete the project, give the
 * old project back) puts the note's bytes back as they were.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessionOf, signedIn } from "./helpers/session.js";

process.env.ORRAMA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-project-from-note-"));
process.env.ORRAMA_VAULT_DIR = path.join(process.env.ORRAMA_DATA_DIR, "vault");
process.env.ORRAMA_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.ORRAMA_SECRET_KEY = "test-secret-key-0123456789abcdef";

await import("../src/seed.js");
const { buildServer } = await import("../src/main.js");
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
const disk = (rel: string) => fs.readFileSync(path.join(VAULT, rel), "utf8");
const exists = (rel: string) => fs.existsSync(path.join(VAULT, rel));
const projectsDir = () => (exists("04-Projects") ? fs.readdirSync(path.join(VAULT, "04-Projects")).sort() : []);
const board = async () => (await api("GET", "/api/projects")).json as { slug: string; name: string; total: number; done: number }[];

/** The page's Undo, in its order: the note back first (or the trash would take it with the folder), then the project, then the old project. */
const undo = async (made: { slug: string; note: { path: string; from: string; moved: boolean; id: string }; left: string | null }) => {
  if (made.note.moved) expect((await api("POST", "/api/vault/move", { fromPath: made.note.path, toPath: made.note.from, links: true })).status).toBe(200);
  expect((await api("POST", `/api/projects/${made.slug}/trash`)).status).toBe(200);
  if (made.left) expect((await api("POST", `/api/projects/${made.left.slice("project/".length)}/notes`, { noteId: made.note.id })).status).toBe(200);
};

beforeAll(async () => {
  built = await buildServer();
  token = sessionOf(await built.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "jules@orrama.dev", password: "orrama-demo" } }));
});
afterAll(async () => {
  await built.app.close();
  closeDb(built.db);
});

const KITCHEN = "---\ntitle: Kitchen redo\ntags:\n  - home\n---\n# Kitchen redo\n\n- [ ] Measure the wall\n- [ ] Ask for quotes\n- [x] Pick a colour\n";

describe("making a project from a note", () => {
  it("makes one project with both tags, tags the note, leaves it where it is, and counts its tasks once", async () => {
    const id = await put("Ideas/Kitchen redo.md", KITCHEN);
    const before = projectsDir();
    const made = await api("POST", "/api/projects/from-note", { noteId: id });
    expect(made.status).toBe(200);
    expect(made.json).toMatchObject({ slug: "kitchen-redo", key: "project/kitchen-redo", note: { id, path: "Ideas/Kitchen redo.md", from: "Ideas/Kitchen redo.md", moved: false }, left: null, tasks: 2 });
    // One new file in 04-Projects: the project's note, made by the scaffold, with both tags.
    expect(projectsDir()).toEqual([...before, "kitchen-redo.md"].sort());
    const projectNote = disk("04-Projects/kitchen-redo.md");
    expect(projectNote).toMatch(/tags:\n {2}- project\n {2}- project\/kitchen-redo\n/);
    expect(projectNote).toContain("title: Kitchen redo");
    // Its tasks are the note's: no "First step", nothing copied.
    expect(projectNote).not.toMatch(/- \[ \]/);
    expect(projectNote).toContain("## Tasks");
    // The note: the tag added to its list, nothing else changed.
    expect(disk("Ideas/Kitchen redo.md").replace(/^id: n-[^\n]*\n/m, "")).toBe(KITCHEN.replace("  - home\n", "  - home\n  - project/kitchen-redo\n"));
    const page = (await api("GET", "/api/projects/kitchen-redo")).json;
    expect(page.notes.map((n: { id: string }) => n.id)).toEqual([id]);
    expect(page.tasks.map((t: { text: string }) => t.text).sort()).toEqual(["Ask for quotes", "Measure the wall", "Pick a colour"]);
    expect({ total: page.total, done: page.done }).toEqual({ total: 3, done: 1 });
    const row = (await board()).find((p) => p.slug === "kitchen-redo")!;
    expect({ name: row.name, total: row.total, done: row.done }).toEqual({ name: "Kitchen redo", total: 3, done: 1 });
  });

  it("asks before a second project: the same note again is a 409, and nothing more is made", async () => {
    const id = (await api("GET", "/api/vault/tree")).json.find((n: { path: string }) => n.path === "Ideas/Kitchen redo.md").id;
    const before = projectsDir();
    const again = await api("POST", "/api/projects/from-note", { noteId: id });
    expect(again.status).toBe(409);
    expect(again.json.error).toBe("This note is already in Kitchen redo.");
    expect(projectsDir()).toEqual(before);
  });

  it("refuses a project's own note", async () => {
    const own = (await api("GET", "/api/projects/kitchen-redo")).json.noteId;
    const res = await api("POST", "/api/projects/from-note", { noteId: own, anyway: true });
    expect(res.status).toBe(400);
  });

  it("Undo puts the note's bytes back and takes the project off the board", async () => {
    const id = await put("Ideas/Porch.md", "---\ntitle: Porch\n---\nPaint it.\n- [ ] Sand the rail\n");
    const bytes = disk("Ideas/Porch.md");
    const made = (await api("POST", "/api/projects/from-note", { noteId: id })).json;
    expect(disk("Ideas/Porch.md")).not.toBe(bytes);
    await undo(made);
    expect(disk("Ideas/Porch.md")).toBe(bytes);
    expect((await board()).some((p) => p.slug === "porch")).toBe(false);
    expect(exists("04-Projects/porch.md")).toBe(false);
  });

  it("moves the note into the project's folder only when asked, and Undo moves it back", async () => {
    const id = await put("Ideas/Shed.md", "---\ntitle: Shed\n---\n- [ ] Pour the base\n");
    const link = await put("Ideas/Links to shed.md", "See [[Ideas/Shed]].\n");
    const bytes = disk("Ideas/Shed.md");
    const made = (await api("POST", "/api/projects/from-note", { noteId: id, move: true })).json;
    expect(made.note).toMatchObject({ path: "04-Projects/shed/Shed.md", from: "Ideas/Shed.md", moved: true });
    expect(exists("Ideas/Shed.md")).toBe(false);
    expect(disk("04-Projects/shed/Shed.md")).toContain("project/shed");
    // A link that named the note by its path follows it, as Move to… does.
    expect(disk("Ideas/Links to shed.md")).toContain("[[04-Projects/shed/Shed]]");
    expect((await api("GET", "/api/projects/shed")).json.notes.map((n: { id: string }) => n.id)).toEqual([id]);

    await undo(made);
    expect(disk("Ideas/Shed.md")).toBe(bytes);
    expect(disk("Ideas/Links to shed.md")).toContain("[[Ideas/Shed]]");
    expect(exists("04-Projects/shed")).toBe(false);
    expect((await api("GET", `/api/vault/note/${link}`)).status).toBe(200);
  });

  it("writes the name, area, group and due date onto the project note", async () => {
    const id = await put("Ideas/Bike trip.md", "---\ntitle: Bike trip\n---\nNotes.\n");
    const made = await api("POST", "/api/projects/from-note", { noteId: id, name: "Tour of Zeeland", area: "work", group: "Trips", deadline: "2027-05-01" });
    expect(made.status).toBe(200);
    expect(made.json.slug).toBe("tour-of-zeeland");
    const text = disk("04-Projects/tour-of-zeeland.md");
    expect(text).toMatch(/^area: Work$/m);
    expect(text).toMatch(/^group: Trips$/m);
    expect(text).toMatch(/^deadline: "?2027-05-01"?$/m);
    // A note without open tasks gets the scaffold's first step.
    expect(text).toContain("- [ ] First step");
    expect(disk("Ideas/Bike trip.md")).toContain("project/tour-of-zeeland");
  });

  it("refuses a day that isn't one, an area that doesn't exist and unreadable properties, making nothing", async () => {
    const id = await put("Ideas/Pond.md", "---\ntitle: Pond\n---\n- [ ] Dig\n");
    const broken = await put("Ideas/Broken.md", "---\ntitle: [unclosed\n---\n- [ ] x\n");
    const before = projectsDir();
    const boardBefore = (await board()).length;
    expect((await api("POST", "/api/projects/from-note", { noteId: id, deadline: "2027-02-30" })).status).toBe(400);
    expect((await api("POST", "/api/projects/from-note", { noteId: id, area: "Nowhere" })).status).toBe(400);
    expect((await api("POST", "/api/projects/from-note", { noteId: broken })).status).toBe(409);
    expect(projectsDir()).toEqual(before);
    // Refused before anything was made: not even a project note in the trash.
    expect(exists(".trash/04-Projects/broken.md")).toBe(false);
    expect((await board()).length).toBe(boardBefore);
    expect(disk("Ideas/Pond.md")).not.toContain("project/");
  });

  it("a move that can't happen leaves the note as it was and the project in the trash", async () => {
    const id = await put("Ideas/Deck.md", "---\ntitle: Deck\n---\n- [ ] Boards\n");
    const bytes = disk("Ideas/Deck.md");
    // The folder already holds a note of that name: the move is refused.
    await put("04-Projects/deck/Deck.md", "Someone else's.\n");
    const res = await api("POST", "/api/projects/from-note", { noteId: id, move: true });
    expect(res.status).toBe(409);
    expect(disk("Ideas/Deck.md")).toBe(bytes);
    expect((await board()).some((p) => p.name === "Deck")).toBe(false);
  });

  it("a new project anyway takes the note out of its old one, and Undo gives it back", async () => {
    const old = (await api("POST", "/api/projects", { name: "Allotment" })).json;
    const id = await put("Ideas/Beds.md", "---\ntitle: Beds\ntags:\n  - garden\n---\n- [ ] Weed\n");
    expect((await api("POST", `/api/projects/${old.slug}/notes`, { noteId: id })).status).toBe(200);
    const inOld = disk("Ideas/Beds.md");
    const made = await api("POST", "/api/projects/from-note", { noteId: id, anyway: true });
    expect(made.status).toBe(200);
    expect(made.json.left).toBe(`project/${old.slug}`);
    const tagged = disk("Ideas/Beds.md");
    expect(tagged).toContain(`project/${made.json.slug}`);
    expect(tagged).not.toContain(`project/${old.slug}\n`);
    expect((await api("GET", `/api/projects/${old.slug}`)).json.notes).toEqual([]);

    await undo(made.json);
    expect(disk("Ideas/Beds.md")).toBe(inOld);
    expect((await api("GET", `/api/projects/${old.slug}`)).json.notes.map((n: { id: string }) => n.id)).toEqual([id]);
  });
});
