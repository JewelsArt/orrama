/**
 * Rename, move and the trash, for notes and folders (stage 1, 1C). Nothing in Orrama could be
 * renamed, moved or deleted from a screen; these are the routes the Notes page calls, and the
 * shared client (apps/web/src/noteActions.ts) that the people, area and project pages will.
 *
 * Jules, 21 Oct 2026: deleting moves to `.trash/` in the notes folder (recoverable, travels with
 * a backup, emptied by hand), and a rename takes the exact `[[links]]` that named the note with
 * it. Over real HTTP on the seeded workspace: jules owns it, erin is in engineering, mara in
 * marketing and cannot read `Engineering/`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { liveSocket, sessionOf, signedIn } from "./helpers/session.js";

process.env.ORRAMA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-note-actions-"));
process.env.ORRAMA_VAULT_DIR = path.join(process.env.ORRAMA_DATA_DIR, "vault");
process.env.ORRAMA_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.ORRAMA_SECRET_KEY = "test-secret-key-0123456789abcdef";

await import("../src/seed.js");
const { buildServer } = await import("../src/main.js");
const { tables } = await import("../src/db.js");
const { eq } = await import("drizzle-orm");

const VAULT = process.env.ORRAMA_VAULT_DIR;
let b: Awaited<ReturnType<typeof buildServer>>;
const tokens: Record<string, string> = {};

const api = async (method: string, url: string, who: string, body?: unknown) => {
  const res = await b.app.inject({
    method: method as "GET",
    url,
    headers: signedIn(tokens[who]),
    ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
  });
  let json: any = null;
  try {
    json = res.json();
  } catch {
    /* not JSON */
  }
  return { status: res.statusCode, json };
};
const put = (who: string, p: string, content: string) => api("PUT", "/api/vault/note", who, { path: p, content });
const tree = async (who: string) => (await api("GET", "/api/vault/tree", who)).json as { id: string; path: string; title: string }[];
const disk = (rel: string) => fs.readFileSync(path.join(VAULT, rel), "utf8");
const onDisk = (rel: string) => fs.existsSync(path.join(VAULT, rel));

beforeAll(async () => {
  b = await buildServer();
  for (const who of ["jules", "erin", "mara"]) {
    const res = await b.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: `${who}@orrama.dev`, password: "orrama-demo" } });
    expect(res.statusCode).toBe(200);
    tokens[who] = sessionOf(res);
  }
});
afterAll(async () => {
  await b.app.close();
  fs.rmSync(process.env.ORRAMA_DATA_DIR!, { recursive: true, force: true });
});

describe("the trash", () => {
  it("a trashed note leaves every surface, and comes back as the same note: id, text, history, tasks", async () => {
    const roadmap = (await tree("erin")).find((n) => n.path === "Engineering/Atlas Roadmap.md")!;
    const before = await api("GET", `/api/vault/note/${roadmap.id}`, "erin");
    const history = (await api("GET", `/api/vault/note/${roadmap.id}/history`, "erin")).json.total as number;
    const bytes = disk("Engineering/Atlas Roadmap.md");
    const objects = () => b.db.select().from(tables.taskObjects).where(eq(tables.taskObjects.noteId, roadmap.id)).all();
    expect(objects()[0]!.status).not.toBe("orphaned");

    const trashed = await api("POST", "/api/vault/trash", "erin", { path: "Engineering/Atlas Roadmap.md" });
    expect(trashed.status).toBe(200);
    expect(trashed.json).toEqual({ path: "Engineering/Atlas Roadmap.md", trashPath: ".trash/Engineering/Atlas Roadmap.md" });
    // Byte for byte, at its own path under .trash/.
    expect(onDisk("Engineering/Atlas Roadmap.md")).toBe(false);
    expect(disk(".trash/Engineering/Atlas Roadmap.md")).toBe(bytes);
    expect((await tree("erin")).some((n) => n.id === roadmap.id)).toBe(false);
    expect((await api("GET", `/api/vault/note/${roadmap.id}`, "erin")).status).toBe(404);
    expect(objects()[0]!.status).toBe("orphaned");

    const list = (await api("GET", "/api/vault/trash", "erin")).json as { path: string; from: string; title: string; kind: string; canRestore: boolean }[];
    expect(list).toContainEqual(expect.objectContaining({ path: ".trash/Engineering/Atlas Roadmap.md", from: "Engineering/Atlas Roadmap.md", title: "Atlas Roadmap", kind: "note", canRestore: true }));

    const back = await api("POST", "/api/vault/trash/restore", "erin", { path: ".trash/Engineering/Atlas Roadmap.md" });
    expect(back.status).toBe(200);
    expect(back.json).toEqual({ path: "Engineering/Atlas Roadmap.md", id: roadmap.id });
    expect(disk("Engineering/Atlas Roadmap.md")).toBe(bytes);
    expect(onDisk(".trash/Engineering")).toBe(false); // the emptied folder in the trash goes too
    const after = await api("GET", `/api/vault/note/${roadmap.id}`, "erin");
    expect(after.json.content).toBe(before.json.content);
    expect((await api("GET", `/api/vault/note/${roadmap.id}/history`, "erin")).json.total).toBeGreaterThanOrEqual(history);
    expect(objects()[0]!.status).toBe("in-progress");
  });

  it("restores beside the note when its place is taken now", async () => {
    expect((await put("jules", "Ideas/Reading.md", "# Reading\n\nfirst\n")).status).toBe(200);
    expect((await api("POST", "/api/vault/trash", "jules", { path: "Ideas/Reading.md" })).status).toBe(200);
    expect((await put("jules", "Ideas/Reading.md", "# Reading\n\nsecond\n")).status).toBe(200);
    const back = await api("POST", "/api/vault/trash/restore", "jules", { path: ".trash/Ideas/Reading.md" });
    expect(back.json.path).toBe("Ideas/Reading (2).md");
    expect(disk("Ideas/Reading (2).md")).toContain("first");
    expect(disk("Ideas/Reading.md")).toContain("second");
  });

  it("two notes trashed from one place both wait in the trash", async () => {
    expect((await put("jules", "Ideas/Twice.md", "# one\n")).status).toBe(200);
    await api("POST", "/api/vault/trash", "jules", { path: "Ideas/Twice.md" });
    expect((await put("jules", "Ideas/Twice.md", "# two\n")).status).toBe(200);
    const second = await api("POST", "/api/vault/trash", "jules", { path: "Ideas/Twice.md" });
    expect(second.json.trashPath).toBe(".trash/Ideas/Twice (2).md");
    expect(disk(".trash/Ideas/Twice.md")).toContain("one");
    expect(disk(".trash/Ideas/Twice (2).md")).toContain("two");
  });

  it("nothing can be written into, moved into or read from the trash as a note", async () => {
    expect((await put("jules", ".trash/Sneaky.md", "# hi\n")).status).toBe(400);
    expect((await put("jules", ".Trash/Sneaky.md", "# hi\n")).status).toBe(400);
    expect((await api("POST", "/api/vault/move", "jules", { fromPath: "Welcome.md", toPath: ".trash/Welcome.md" })).status).toBe(400);
    expect((await api("POST", "/api/vault/folder", "jules", { folder: ".trash/x" })).status).toBe(400);
    expect((await api("POST", "/api/vault/trash/restore", "jules", { path: ".trash/../Welcome.md" })).status).toBe(400);
    expect((await api("POST", "/api/vault/trash/restore", "jules", { path: ".trash/Nothing here.md" })).status).toBe(404);
    expect(onDisk(".trash/Sneaky.md")).toBe(false);
  });

  it("a .trash that is a link elsewhere is refused, and nothing moves", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-trash-link-"));
    const trash = path.join(VAULT, ".trash");
    const moved = fs.existsSync(trash) ? `${trash}-kept` : null;
    if (moved) fs.renameSync(trash, moved);
    try {
      fs.symlinkSync(outside, trash, "dir");
    } catch {
      if (moved) fs.renameSync(moved, trash);
      return; // no symlinks on this runner (platform.ts canSymlink): nothing to probe
    }
    try {
      expect((await put("jules", "Ideas/Kept.md", "# kept\n")).status).toBe(200);
      const r = await api("POST", "/api/vault/trash", "jules", { path: "Ideas/Kept.md" });
      expect(r.status).toBe(409);
      expect(onDisk("Ideas/Kept.md")).toBe(true);
      expect(fs.readdirSync(outside)).toEqual([]);
    } finally {
      fs.unlinkSync(trash);
      if (moved) fs.renameSync(moved, trash);
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("the trash is invisible to every surface (leak test)", () => {
  const SECRET = "Quarterly trash leak probe";
  beforeAll(async () => {
    expect((await put("jules", `Ideas/${SECRET}.md`, `---\ntags: [probe-tag]\n---\n# ${SECRET}\n\n- [ ] probe task\nlinks to [[Welcome]]\n`)).status).toBe(200);
    expect((await api("POST", "/api/vault/trash", "jules", { path: `Ideas/${SECRET}.md` })).status).toBe(200);
  });

  it.each([
    ["/api/vault/tree"],
    ["/api/vault/search?q=Quarterly"],
    ["/api/vault/tags"],
    ["/api/vault/graph"],
    ["/api/vault/folders"],
    ["/api/sync/manifest"],
    ["/api/projects"],
    ["/api/notes/overview"],
    ["/api/graph/entities"],
    ["/api/dashboard/engineering"],
  ])("%s says nothing of it", async (url) => {
    const r = await api("GET", url, "jules");
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.json)).not.toContain("Quarterly");
    expect(JSON.stringify(r.json)).not.toContain("probe task");
    expect(JSON.stringify(r.json)).not.toContain(".trash");
  });

  it("the note it linked to has no backlink from it", async () => {
    const welcome = (await tree("jules")).find((n) => n.path === "Welcome.md")!;
    const note = await api("GET", `/api/vault/note/${welcome.id}`, "jules");
    expect(JSON.stringify(note.json.backlinks)).not.toContain("Quarterly");
  });

  it("after a restart it is still not indexed", async () => {
    await b.store.close();
    b.store.load();
    await b.store.watching;
    expect(b.store.index.all().some((n) => n.path.toLowerCase().startsWith(".trash/"))).toBe(false);
  });

  it("another person's trashed note is not in your trash, and you can't restore or empty it", async () => {
    expect((await put("erin", "Engineering/Eng only draft.md", "# Eng only draft\n")).status).toBe(200);
    expect((await api("POST", "/api/vault/trash", "erin", { path: "Engineering/Eng only draft.md" })).status).toBe(200);
    expect((await put("mara", "Personal/mara/Mine.md", "# Mine\n")).status).toBe(200);
    expect((await api("POST", "/api/vault/trash", "mara", { path: "Personal/mara/Mine.md" })).status).toBe(200);

    const maras = JSON.stringify((await api("GET", "/api/vault/trash", "mara")).json);
    expect(maras).toContain("Personal/mara/Mine.md");
    expect(maras).not.toContain("Eng only draft");
    // jules's Ideas/ note: mara reads the root (a viewer there), so she saw it in the tree and sees
    // it here, but can't put it back.
    expect((await api("GET", "/api/vault/trash", "mara")).json).toContainEqual(expect.objectContaining({ title: SECRET, canRestore: false }));
    expect((await api("POST", "/api/vault/trash/restore", "mara", { path: `.trash/Ideas/${SECRET}.md` })).status).toBe(403);
    expect(JSON.stringify((await api("GET", "/api/vault/trash", "erin")).json)).not.toContain("Personal/mara");

    expect((await api("POST", "/api/vault/trash/restore", "mara", { path: ".trash/Engineering/Eng only draft.md" })).status).toBe(404);
    const emptied = await api("POST", "/api/vault/trash/empty", "mara");
    expect(emptied.status).toBe(200);
    expect(onDisk(".trash/Personal/mara/Mine.md")).toBe(false);
    expect(onDisk(".trash/Engineering/Eng only draft.md")).toBe(true);
    expect(emptied.json.kept).toBeGreaterThan(0);
  });
});

describe("empty the trash", () => {
  it("removes only what is under .trash/, and the trash folder with it", async () => {
    expect((await put("jules", "Ideas/Gone for good.md", "# gone\n")).status).toBe(200);
    await api("POST", "/api/vault/trash", "jules", { path: "Ideas/Gone for good.md" });
    const notes = (await tree("jules")).length;
    const r = await api("POST", "/api/vault/trash/empty", "jules");
    expect(r.status).toBe(200);
    expect(r.json.removed).toBeGreaterThan(0);
    expect(r.json.kept).toBe(0);
    expect(onDisk(".trash")).toBe(false);
    expect((await tree("jules")).length).toBe(notes);
    expect((await api("GET", "/api/vault/trash", "jules")).json).toEqual([]);
  });

  it("removes a link in the trash as a link, never what it points at", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-trash-target-"));
    fs.writeFileSync(path.join(outside, "keep.md"), "# keep\n");
    fs.mkdirSync(path.join(VAULT, ".trash"), { recursive: true });
    try {
      fs.symlinkSync(outside, path.join(VAULT, ".trash", "elsewhere"), "dir");
    } catch {
      return; // no symlinks on this runner
    }
    try {
      expect((await api("GET", "/api/vault/trash", "jules")).json).toEqual([]);
      expect((await api("POST", "/api/vault/trash/empty", "jules")).status).toBe(200);
      expect(fs.readFileSync(path.join(outside, "keep.md"), "utf8")).toBe("# keep\n");
      expect(onDisk(".trash/elsewhere")).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("folders", () => {
  it("a new folder is there before any note is, for whoever may see it", async () => {
    const r = await api("POST", "/api/vault/folder", "jules", { folder: "Ideas/Empty one" });
    expect(r.status).toBe(200);
    expect(fs.statSync(path.join(VAULT, "Ideas/Empty one")).isDirectory()).toBe(true);
    expect((await api("GET", "/api/vault/folders", "jules")).json).toContain("Ideas/Empty one");
    expect((await api("POST", "/api/vault/folder", "jules", { folder: "ideas/empty ONE" })).status).toBe(409);
    expect((await api("POST", "/api/vault/folder", "jules", { folder: "Ideas/Bad:name" })).status).toBe(400);
  });

  it("you can't make, see, move or trash a folder you can't edit", async () => {
    expect((await api("POST", "/api/vault/folder", "mara", { folder: "Engineering/Mara was here" })).status).toBe(403);
    expect((await api("GET", "/api/vault/folders", "mara")).json).not.toContain("Engineering");
    expect((await api("POST", "/api/vault/folder/move", "mara", { from: "Engineering", to: "Marketing/Engineering" })).status).toBe(404);
    expect((await api("POST", "/api/vault/folder/trash", "mara", { folder: "Engineering" })).status).toBe(404);
    // Into another person's own folder, or anywhere through `..`.
    expect((await api("POST", "/api/vault/folder", "mara", { folder: "Personal/erin/Planted" })).status).toBe(403);
    expect((await api("POST", "/api/vault/folder/move", "mara", { from: "Marketing", to: "Personal/erin/Marketing" })).status).toBe(403);
    expect((await api("POST", "/api/vault/folder", "mara", { folder: "Personal/mara/../erin/x" })).status).toBe(400);
    // An empty folder: no note in it to be judged, the destination still is.
    expect((await api("POST", "/api/vault/folder", "mara", { folder: "Marketing/Empty box" })).status).toBe(200);
    expect((await api("POST", "/api/vault/folder/move", "mara", { from: "Marketing/Empty box", to: "Personal/erin/Empty box" })).status).toBe(403);
    expect(onDisk("Personal/erin/Planted")).toBe(false);
    expect(onDisk("Personal/erin/Empty box")).toBe(false);
    expect(onDisk("Marketing/Acme Relaunch Brief.md")).toBe(true);
  });

  it("the Personal folders themselves are never renamed, moved or trashed", async () => {
    expect((await api("POST", "/api/vault/folder/move", "jules", { from: "Personal", to: "Private" })).status).toBe(400);
    expect((await api("POST", "/api/vault/folder/move", "jules", { from: "Personal/jules", to: "Personal/me" })).status).toBe(400);
    expect((await api("POST", "/api/vault/folder/trash", "jules", { folder: "Personal/jules" })).status).toBe(400);
  });

  it("renaming a folder moves every note in it, ids kept, text untouched, and its files too", async () => {
    expect((await put("jules", "Trips/2026/Lisbon.md", "# Lisbon\n\n- [ ] book flights\n")).status).toBe(200);
    expect((await put("jules", "Trips/Packing.md", "# Packing\n")).status).toBe(200);
    fs.writeFileSync(path.join(VAULT, "Trips/map.png"), "png");
    const ids = Object.fromEntries((await tree("jules")).filter((n) => n.path.startsWith("Trips/")).map((n) => [n.path, n.id]));
    const r = await api("POST", "/api/vault/folder/move", "jules", { from: "Trips", to: "Travel" });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ path: "Travel", notes: 2 });
    const now = Object.fromEntries((await tree("jules")).filter((n) => n.path.startsWith("Travel/")).map((n) => [n.path, n.id]));
    expect(now).toEqual({ "Travel/2026/Lisbon.md": ids["Trips/2026/Lisbon.md"], "Travel/Packing.md": ids["Trips/Packing.md"] });
    expect(disk("Travel/2026/Lisbon.md")).toContain("book flights");
    expect(disk("Travel/map.png")).toBe("png");
    expect(onDisk("Trips")).toBe(false);
    // A folder can't go inside itself, nor onto a name that's taken.
    expect((await api("POST", "/api/vault/folder/move", "jules", { from: "Travel", to: "Travel/2026/Travel" })).status).toBe(400);
    expect((await api("POST", "/api/vault/folder/move", "jules", { from: "Travel/2026", to: "Ideas" })).status).toBe(409);
  });

  it("a folder renamed only in case is that folder, renamed (STO-012)", async () => {
    const probe = path.join(VAULT, "CaseProbe");
    fs.mkdirSync(probe);
    const folds = fs.existsSync(path.join(VAULT, "caseprobe"));
    fs.rmdirSync(probe);
    expect((await put("jules", "travel notes/Day one.md", "# Day one\n")).status).toBe(200);
    const id = (await tree("jules")).find((n) => n.path === "travel notes/Day one.md")!.id;
    const r = await api("POST", "/api/vault/folder/move", "jules", { from: "travel notes", to: "Travel Notes" });
    expect(r.status).toBe(200);
    expect(fs.readdirSync(VAULT)).toContain("Travel Notes");
    if (folds) expect(fs.readdirSync(VAULT)).not.toContain("travel notes");
    expect((await tree("jules")).find((n) => n.id === id)!.path).toBe("Travel Notes/Day one.md");
  });

  it("a trashed folder takes its notes and files to the trash, and each comes back", async () => {
    expect((await put("jules", "Old stuff/A.md", "# A\n")).status).toBe(200);
    expect((await put("jules", "Old stuff/Deep/B.md", "# B\n")).status).toBe(200);
    fs.writeFileSync(path.join(VAULT, "Old stuff/scan.pdf"), "pdf");
    const r = await api("POST", "/api/vault/folder/trash", "jules", { folder: "Old stuff" });
    expect(r.json).toEqual({ path: "Old stuff", notes: 2 });
    expect(onDisk("Old stuff")).toBe(false);
    expect((await tree("jules")).some((n) => n.path.startsWith("Old stuff/"))).toBe(false);
    const list = (await api("GET", "/api/vault/trash", "jules")).json as { from: string; kind: string }[];
    expect(list.filter((i) => i.from.startsWith("Old stuff/")).map((i) => [i.from, i.kind]).sort()).toEqual([
      ["Old stuff/A.md", "note"],
      ["Old stuff/Deep/B.md", "note"],
      ["Old stuff/scan.pdf", "file"],
    ]);
    expect((await api("POST", "/api/vault/trash/restore", "jules", { path: ".trash/Old stuff/Deep/B.md" })).json.path).toBe("Old stuff/Deep/B.md");
    expect((await api("POST", "/api/vault/trash/restore", "jules", { path: ".trash/Old stuff/scan.pdf" })).json).toEqual({ path: "Old stuff/scan.pdf", id: null });
    expect(disk("Old stuff/scan.pdf")).toBe("pdf");
  });
});

describe("rename and move, links following (Jules, 21 Oct 2026)", () => {
  beforeAll(async () => {
    expect((await put("jules", "Ideas/Garden plan.md", "---\ntitle: Garden plan\n---\n# Garden plan\n\n## Beds\n\nSee [[Garden plan#Beds]].\n")).status).toBe(200);
    const linking = [
      "# Linking",
      "",
      "- [[Garden plan]] by name",
      "- [[garden plan|the plan]] with a label, another case",
      "- [[Ideas/Garden plan]] by path, and [[Ideas/Garden plan.md]]",
      "- [[Garden plan#Beds]] a heading",
      "- `[[Garden plan]]` in code stays",
      "- [md link](Garden%20plan.md) won't follow",
      "- [[Garden]] is another note",
      "",
      "```",
      "[[Garden plan]] in a fence stays",
      "```",
    ].join("\n");
    expect((await put("jules", "Ideas/Linking.md", `---\nabout: "[[Garden plan]]"\n---\n${linking}\n`)).status).toBe(200);
    expect((await put("jules", "Ideas/Garden.md", "# Garden\n")).status).toBe(200);
    expect((await put("jules", "Ideas/Only in properties.md", '---\nplan: "[[Garden plan]]"\n---\n# P\n')).status).toBe(200);
    expect((await put("jules", "Ideas/A chat.md", "---\ntype: conversation\n---\nWe talked about [[Garden plan]].\n")).status).toBe(200);
  });

  it("says first which notes will follow, and how many links won't", async () => {
    const id = (await tree("jules")).find((n) => n.path === "Ideas/Garden plan.md")!.id;
    const r = await api("GET", `/api/vault/note/${id}/linkers?to=${encodeURIComponent("Ideas/Vegetable garden.md")}`, "jules");
    expect(r.status).toBe(200);
    const linking = r.json.notes.find((n: { path: string }) => n.path === "Ideas/Linking.md");
    expect(linking).toMatchObject({ links: 6, canEdit: true }); // five in the body, one in its front matter
    expect(r.json.notes.find((n: { path: string }) => n.path === "Ideas/Garden plan.md")).toMatchObject({ links: 1 }); // its own heading link
    expect(r.json.other).toBe(1); // the Markdown link
    expect(r.json.notes.some((n: { path: string }) => n.path === "Ideas/Garden.md")).toBe(false);
    expect(r.json.notes.find((n: { path: string }) => n.path === "Ideas/Only in properties.md")).toMatchObject({ links: 1 });
    expect(r.json.notes.some((n: { path: string }) => n.path === "Ideas/A chat.md")).toBe(false); // a transcript is quoted, not followed
  });

  it("renames the file and the title, and the exact links follow", async () => {
    const id = (await tree("jules")).find((n) => n.path === "Ideas/Garden plan.md")!.id;
    const r = await api("POST", "/api/vault/move", "jules", { fromPath: "Ideas/Garden plan.md", toPath: "Ideas/Vegetable garden.md", links: true });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ id, path: "Ideas/Vegetable garden.md", links: 8, notes: 3 });
    expect(disk("Ideas/Only in properties.md")).toContain('plan: "[[Vegetable garden]]"');
    expect(disk("Ideas/A chat.md")).toContain("[[Garden plan]]");
    const self = disk("Ideas/Vegetable garden.md");
    expect(self).toContain("title: Vegetable garden");
    expect(self).toContain("See [[Vegetable garden#Beds]].");
    const text = disk("Ideas/Linking.md");
    expect(text).toContain('about: "[[Vegetable garden]]"');
    expect(text).toContain("- [[Vegetable garden]] by name");
    expect(text).toContain("- [[Vegetable garden|the plan]] with a label");
    expect(text).toContain("- [[Ideas/Vegetable garden]] by path, and [[Ideas/Vegetable garden.md]]");
    expect(text).toContain("- [[Vegetable garden#Beds]] a heading");
    expect(text).toContain("- `[[Garden plan]]` in code stays");
    expect(text).toContain("[md link](Garden%20plan.md)");
    expect(text).toContain("[[Garden]] is another note");
    expect(text).toContain("[[Garden plan]] in a fence stays");
    // Still linked, still the same note.
    const note = await api("GET", `/api/vault/note/${id}`, "jules");
    expect(note.json.title).toBe("Vegetable garden");
    expect(note.json.backlinks.filter((l: { fromPath: string }) => l.fromPath === "Ideas/Linking.md").length).toBe(5);
  });

  it("a move to another folder rewrites only the links by path", async () => {
    const r = await api("POST", "/api/vault/move", "jules", { fromPath: "Ideas/Vegetable garden.md", toPath: "Travel/Vegetable garden.md", links: true });
    expect(r.json).toMatchObject({ links: 2, notes: 1 });
    const text = disk("Ideas/Linking.md");
    expect(text).toContain("- [[Vegetable garden]] by name");
    expect(text).toContain("[[Travel/Vegetable garden]] by path, and [[Travel/Vegetable garden.md]]");
  });

  it("a rename only in case works on a case-insensitive disk too (STO-012)", async () => {
    expect((await put("jules", "Ideas/shopping.md", "# shopping\n")).status).toBe(200);
    expect((await put("jules", "Ideas/List.md", "# List\n\n[[shopping]]\n")).status).toBe(200);
    const r = await api("POST", "/api/vault/move", "jules", { fromPath: "Ideas/shopping.md", toPath: "Ideas/Shopping.md", links: true });
    expect(r.status).toBe(200);
    expect(fs.readdirSync(path.join(VAULT, "Ideas"))).toContain("Shopping.md");
    expect(disk("Ideas/List.md")).toContain("[[Shopping]]");
  });

  it("a note in a folder you can't edit keeps its links, and is counted as not following", async () => {
    expect((await put("mara", "Marketing/Target.md", "# Target\n")).status).toBe(200);
    expect((await put("jules", "Engineering/Points at it.md", "# P\n\n[[Target]]\n")).status).toBe(200); // mara can't read Engineering
    expect((await put("jules", "Welcome2.md", "# W\n\n[[Target]]\n")).status).toBe(200); // mara reads the root, can't edit it
    const id = (await tree("mara")).find((n) => n.path === "Marketing/Target.md")!.id;
    const plan = await api("GET", `/api/vault/note/${id}/linkers?to=${encodeURIComponent("Marketing/Aim.md")}`, "mara");
    expect(plan.json.notes.map((n: { path: string; canEdit: boolean }) => [n.path, n.canEdit])).toEqual([["Welcome2.md", false]]);
    expect(plan.json.other).toBe(1);
    const r = await api("POST", "/api/vault/move", "mara", { fromPath: "Marketing/Target.md", toPath: "Marketing/Aim.md", links: true });
    expect(r.json).toMatchObject({ links: 0, notes: 0 });
    expect(disk("Welcome2.md")).toContain("[[Target]]");
    expect(disk("Engineering/Points at it.md")).toContain("[[Target]]");
  });

  it("front matter that can't be read stops a rename before anything moves", async () => {
    expect((await put("jules", "Ideas/Broken.md", "---\ntags: [a, \n---\n# Broken\n")).status).toBe(200);
    const r = await api("POST", "/api/vault/move", "jules", { fromPath: "Ideas/Broken.md", toPath: "Ideas/Fixed.md", links: true });
    expect(r.status).toBe(409);
    expect(onDisk("Ideas/Broken.md")).toBe(true);
    expect(onDisk("Ideas/Fixed.md")).toBe(false);
  });

  it("a note with no id of its own keeps the one it has when moved", async () => {
    // Unparseable front matter can't be stamped: the index keeps the note's id by path alone.
    expect((await put("jules", "Ideas/Unstamped.md", "---\ntags: [x, \n---\n# U\n")).status).toBe(200);
    const id = (await tree("jules")).find((n) => n.path === "Ideas/Unstamped.md")!.id;
    expect(disk("Ideas/Unstamped.md")).not.toContain(id);
    const r = await api("POST", "/api/vault/move", "jules", { fromPath: "Ideas/Unstamped.md", toPath: "Travel/Unstamped.md" });
    expect(r.json.id).toBe(id);
    expect((await tree("jules")).find((n) => n.path === "Travel/Unstamped.md")!.id).toBe(id);
  });
});

describe("live sync", () => {
  it("whoever could read a trashed note hears of it; whoever couldn't hears nothing", async () => {
    expect((await put("erin", "Engineering/Live probe.md", "# Live probe\n")).status).toBe(200);
    const id = (await tree("erin")).find((n) => n.path === "Engineering/Live probe.md")!.id;
    const erin = await liveSocket(b.app, tokens["erin"]);
    const mara = await liveSocket(b.app, tokens["mara"]);
    expect(await erin.ready()).toBe(true);
    expect(await mara.ready()).toBe(true);
    await api("POST", "/api/vault/trash", "erin", { path: "Engineering/Live probe.md" });
    await api("POST", "/api/vault/folder", "erin", { folder: "Engineering/New folder" });
    for (let i = 0; i < 50 && erin.got.filter((m) => m.type === "note-changed").length < 2; i++) await new Promise((r) => setTimeout(r, 20));
    expect(erin.got).toContainEqual(expect.objectContaining({ type: "note-changed", noteId: id }));
    expect(erin.got).toContainEqual(expect.objectContaining({ type: "note-changed", noteId: "", path: "" }));
    expect(mara.got.filter((m) => m.type === "note-changed")).toEqual([]);
    erin.ws.close();
    mara.ws.close();
  });
});
