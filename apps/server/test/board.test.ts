/**
 * The project documents board (documents.canvas) and the section each step
 * reports for the grouped to-do.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultBoard, fileRef, normalizeBoard, placeMissing } from "../src/board.js";

process.env.BASALT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "basalt-board-"));
process.env.BASALT_VAULT_DIR = path.join(process.env.BASALT_DATA_DIR, "vault");
process.env.BASALT_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.BASALT_SECRET_KEY = "test-secret-key-0123456789abcdef";

const VAULT = process.env.BASALT_VAULT_DIR;
const PROJ = path.join(VAULT, "04-Projects");
const FILES = path.join(PROJ, "plan", "files");

const { buildServer } = await import("../src/main.js");
let app: Awaited<ReturnType<typeof buildServer>>["app"];
const token: Record<string, string> = {};
const call = async (who: string, method: string, url: string, payload?: unknown) => {
  const res = await app.inject({ method: method as "GET", url, headers: { authorization: `Bearer ${token[who]}` }, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });
  return { status: res.statusCode, body: res.json() };
};

beforeAll(async () => {
  fs.mkdirSync(FILES, { recursive: true });
  fs.writeFileSync(path.join(FILES, "guide.pdf"), "x");
  fs.writeFileSync(path.join(FILES, "draft.docx"), "x");
  fs.writeFileSync(path.join(PROJ, "plan.md"), [
    "---", "title: Plan", "tags:", "  - project/plan", "---", "",
    "# Plan", "", "- [ ] before any section @jules",
    "## Research plan — due 19 October", "- [ ] write chapter 3 @jules due:2026-10-13",
    "### A sub-heading does not start a group", "- [ ] still research plan @jules",
    "## Final thesis", "- [ ] submit @jules #deadline due:2027-01-18",
  ].join("\n"));
  await import("../src/seed.js");
  app = (await buildServer()).app;
  for (const who of ["jules", "erin"]) {
    token[who] = (await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: `${who}@basalt.dev`, password: "basalt-demo" } })).json().token;
  }
});

afterAll(async () => {
  await app.close();
  fs.rmSync(process.env.BASALT_DATA_DIR!, { recursive: true, force: true });
});

describe("board rules", () => {
  const files = new Set(["guide.pdf", "draft.docx"]);
  const card = (id: string, name: string) => ({ id, type: "file" as const, file: fileRef("plan", name), x: 0, y: 0, width: 220, height: 76 });

  it("drops cards for files that are not in the project folder", () => {
    const b = normalizeBoard({ nodes: [card("a", "guide.pdf"), card("b", "gone.pdf"), { ...card("c", "x"), file: "02-Areas/finance/files/statement.csv" }, { ...card("d", "x"), file: fileRef("plan", "../../secret.md") },
      // Same name as a file this project has, but in another project's folder.
      { ...card("e", "x"), file: fileRef("other", "guide.pdf") }], edges: [] }, "plan", files);
    expect(b.nodes.map((n) => n.id)).toEqual(["a"]);
    // On its own too: a same-named file in another project's folder is not this one.
    const other = { ...card("e", "x"), file: fileRef("other", "guide.pdf") };
    expect(normalizeBoard({ nodes: [other], edges: [] }, "plan", files).nodes).toEqual([]);
  });

  it("drops links to missing cards, to boxes, duplicates and self-links", () => {
    const b = normalizeBoard({
      nodes: [card("a", "guide.pdf"), card("b", "draft.docx"), { id: "g", type: "group", label: "Box", x: 0, y: 0, width: 400, height: 200 }],
      edges: [
        { id: "e1", fromNode: "a", toNode: "b", label: "rules for", basaltSuggested: true },
        { id: "e2", fromNode: "b", toNode: "a" }, // same pair, other way
        { id: "e3", fromNode: "a", toNode: "g" },
        { id: "e4", fromNode: "a", toNode: "a" },
        { id: "e5", fromNode: "a", toNode: "zzz" },
      ],
    }, "plan", files);
    expect(b.edges).toEqual([{ id: "e1", fromNode: "a", toNode: "b", label: "rules for", basaltSuggested: true }]);
  });

  it("gives every new file a card below the board, and a new project one box", () => {
    const placed = placeMissing({ nodes: [card("a", "guide.pdf")], edges: [] }, "plan", ["guide.pdf", "draft.docx"]);
    const added = placed.nodes.find((n) => n.type === "file" && n.file.endsWith("draft.docx"))!;
    expect(added.y).toBeGreaterThan(76);
    const fresh = defaultBoard("plan", ["guide.pdf", "draft.docx"]);
    expect(fresh.nodes.filter((n) => n.type === "group").map((n) => (n as { label: string }).label)).toEqual(["Documents"]);
    expect(fresh.nodes.filter((n) => n.type === "file")).toHaveLength(2);
  });
});

describe("GET/PUT /api/projects/:slug/board", () => {
  it("starts from the default board, then saves and reads back what the owner arranges", async () => {
    const first = await call("jules", "GET", "/api/projects/plan/board");
    expect(first.status).toBe(200);
    expect(first.body.nodes.filter((n: { type: string }) => n.type === "file")).toHaveLength(2);
    expect(fs.existsSync(path.join(PROJ, "plan", "documents.canvas"))).toBe(false); // reading never writes

    const [a, b] = first.body.nodes.filter((n: { type: string }) => n.type === "file");
    const saved = await call("jules", "PUT", "/api/projects/plan/board", {
      nodes: [{ ...a, x: 500 }, b, { id: "g1", type: "group", label: "Writing", color: "6", x: 0, y: 0, width: 600, height: 300 }],
      edges: [{ id: "l1", fromNode: a.id, toNode: b.id, label: "rules for" }],
    });
    expect(saved.status).toBe(200);
    const onDisk = JSON.parse(fs.readFileSync(path.join(PROJ, "plan", "documents.canvas"), "utf8"));
    expect(onDisk.edges).toEqual([{ id: "l1", fromNode: a.id, toNode: b.id, label: "rules for" }]);

    // A file that arrives later appears on its own; one that is deleted leaves.
    fs.writeFileSync(path.join(FILES, "new.xlsx"), "x");
    fs.rmSync(path.join(FILES, "guide.pdf"));
    const again = (await call("jules", "GET", "/api/projects/plan/board")).body;
    const names = again.nodes.filter((n: { type: string }) => n.type === "file").map((n: { file: string }) => path.basename(n.file)).sort();
    expect(names).toEqual(["draft.docx", "new.xlsx"]);
    expect(again.edges).toEqual([]); // its link went with it
    expect(again.nodes.find((n: { id: string }) => n.id === "g1")).toMatchObject({ label: "Writing" });
  });

  it("is read-only for a viewer and refuses a malformed board", async () => {
    const erin = await call("erin", "GET", "/api/projects/plan/board");
    expect(erin.status).toBe(200);
    expect(erin.body.canEdit).toBe(false);
    expect((await call("erin", "PUT", "/api/projects/plan/board", { nodes: [], edges: [] })).status).toBe(403);
    expect((await call("jules", "PUT", "/api/projects/plan/board", { nodes: "nope" })).status).toBe(400);
  });
});

describe("step sections", () => {
  it("groups each step under the nearest ## heading of the project note", async () => {
    const w = (await call("jules", "GET", "/api/projects/plan")).body as { tasks: { text: string; section: string }[] };
    const by = Object.fromEntries(w.tasks.map((t) => [t.text, t.section]));
    expect(by).toEqual({
      "before any section": "Steps",
      "write chapter 3": "Research plan — due 19 October",
      "still research plan": "Research plan — due 19 October",
      submit: "Final thesis",
    });
  });
});
