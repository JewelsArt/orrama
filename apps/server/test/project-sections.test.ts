/**
 * The project workspace writes into the project note, and only into the slot it
 * means (audit COR-005, COR-007, COR-008, COR-017). Goals are edited as the
 * section's own text, not rebuilt from display items; a decision appended
 * leaves the rest of the note byte for byte.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.ORRAMA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "basalt-project-sections-"));
process.env.ORRAMA_VAULT_DIR = path.join(process.env.ORRAMA_DATA_DIR, "vault");
process.env.ORRAMA_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.ORRAMA_SECRET_KEY = "test-secret-key-0123456789abcdef";

await import("../src/seed.js");
const { buildServer } = await import("../src/main.js");

type Built = Awaited<ReturnType<typeof buildServer>>;
let built: Built;
let token = "";
const VAULT = process.env.ORRAMA_VAULT_DIR;

const api = async (method: string, url: string, body?: unknown) => {
  const res = await built.app.inject({
    method: method as "GET",
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
  });
  return { status: res.statusCode, json: (() => { try { return res.json(); } catch { return null; } })() };
};
const put = async (rel: string, content: string) => {
  const r = await api("PUT", "/api/vault/note", { path: rel, content });
  expect(r.status).toBe(200);
  return r.json.id as string;
};
const onDisk = (rel: string) => fs.readFileSync(path.join(VAULT, rel), "utf8");

beforeAll(async () => {
  built = await buildServer();
  token = (await built.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "jules@basalt.dev", password: "basalt-demo" } })).json().token;
});
afterAll(async () => {
  await built.app.close();
});

const THESIS = [
  "---",
  "title: Thesis",
  "tags: [project/thesis]",
  "---",
  "# Thesis",
  "",
  "## Goals",
  "- [x] Pick a supervisor",
  "- [ ] Defend in January",
  "  - book the room",
  "",
  "Done means: signed off.",
  "",
  "## Notes",
  "```",
  "a",
  "",
  "",
  "",
  "b",
  "```",
  "",
].join("\n");

describe("Edit goals (COR-005)", () => {
  it("serves the section as its own text, and saving it unchanged leaves the note byte-identical", async () => {
    await put("04-Projects/thesis.md", THESIS);
    const before = onDisk("04-Projects/thesis.md");
    const w = (await api("GET", "/api/projects/thesis")).json;
    expect(w.goalsSource).toBe("- [x] Pick a supervisor\n- [ ] Defend in January\n  - book the room\n\nDone means: signed off.");
    expect([w.total, w.done]).toEqual([2, 1]);

    // What the editor does: open on the source, save it as it is.
    expect((await api("PATCH", "/api/projects/thesis", { goals: w.goalsSource })).status).toBe(200);
    expect(onDisk("04-Projects/thesis.md")).toBe(before);
  });

  it("an edit to one goal keeps the others' checkboxes, nesting and prose — and the progress", async () => {
    const w = (await api("GET", "/api/projects/thesis")).json;
    const edited = w.goalsSource.replace("Defend in January", "Defend in February");
    expect((await api("PATCH", "/api/projects/thesis", { goals: edited })).status).toBe(200);
    expect(onDisk("04-Projects/thesis.md")).toBe(onDiskExpected());
    const after = (await api("GET", "/api/projects/thesis")).json;
    expect([after.total, after.done]).toEqual([2, 1]);
  });
});

function onDiskExpected() {
  const id = built.store.index.getByPath("04-Projects/thesis.md")!.id;
  return THESIS.replace("---\ntitle", `---\nid: ${id}\ntitle`).replace("Defend in January", "Defend in February");
}

describe("a decision appended touches only its section (COR-007)", () => {
  it("the code block's blank lines and every task line stay where they were", async () => {
    const before = onDisk("04-Projects/thesis.md");
    const lines = built.store.index.getByPath("04-Projects/thesis.md")!.tasks.map((t) => t.line);
    expect((await api("POST", "/api/projects/thesis/decisions", { text: "keep the scope" })).status).toBe(200);
    const after = onDisk("04-Projects/thesis.md");
    expect(after.startsWith(before.replace(/\n$/, ""))).toBe(true);
    expect(after.slice(before.length - 1)).toMatch(/^\n\n## Decisions\n\n- \*\*\d{4}-\d{2}-\d{2}\*\* — keep the scope\n$/);
    expect(built.store.index.getByPath("04-Projects/thesis.md")!.tasks.map((t) => t.line)).toEqual(lines);
  });
});

describe("the workspace reads and writes the `##` slot (COR-008)", () => {
  it("a `### Goals` inside another section is neither read nor overwritten", async () => {
    await put("04-Projects/plan.md", "---\ntitle: Plan\ntags: [project/plan]\n---\n# Plan\n\n## Research plan\n\n### Goals\n- chapter-level goal\n\n## Goals\n- Ship the plan\n");
    const w = (await api("GET", "/api/projects/plan")).json;
    expect(w.goals).toEqual(["Ship the plan"]);
    await api("PATCH", "/api/projects/plan", { goals: "- Ship it" });
    expect(onDisk("04-Projects/plan.md")).toContain("### Goals\n- chapter-level goal\n\n## Goals\n- Ship it\n");
  });

  it("a closed `## Decisions ##` is the slot: no second heading is made", async () => {
    await put("04-Projects/closed.md", "---\ntitle: Closed\ntags: [project/closed]\n---\n## Decisions ##\n- old\n");
    await api("POST", "/api/projects/closed/decisions", { text: "new" });
    const text = onDisk("04-Projects/closed.md");
    expect(text.match(/Decisions/g)).toHaveLength(1);
    expect((await api("GET", "/api/projects/closed")).json.decisions).toHaveLength(2);
  });
});

describe("the people picker links the note it was given (COR-017)", () => {
  it("a contact whose title is another note's filename is linked, once, and Remove takes the line out", async () => {
    const jan = await put("Contacts/People/jan.md", "---\ntitle: Jan de Vries\ntags: [contact]\n---\nJan.\n");
    await put("Notes/Jan de Vries.md", "---\ntitle: Meeting log with Jan\n---\nlog\n");
    await put("04-Projects/people.md", "---\ntitle: People test\ntags: [project/people]\n---\n# People test\n\n## People\n- [[Some Company]]\n");

    expect((await api("POST", "/api/projects/people/people", { noteId: jan })).json).toEqual({ ok: true });
    expect((await api("GET", "/api/projects/people")).json.people.map((p: { id: string }) => p.id)).toEqual([jan]);
    expect((await api("POST", "/api/projects/people/people", { noteId: jan })).json).toEqual({ ok: true, already: true });
    expect(onDisk("04-Projects/people.md")).toContain("## People\n- [[Some Company]]\n- [[Contacts/People/jan|Jan de Vries]]\n");

    expect((await api("DELETE", `/api/projects/people/people/${jan}`)).json).toEqual({ ok: true });
    expect(onDisk("04-Projects/people.md")).toContain("## People\n- [[Some Company]]\n");
    expect(onDisk("04-Projects/people.md")).not.toContain("jan");
    expect((await api("GET", "/api/projects/people")).json.people).toEqual([]);
  });

  it("says who the text links too: Remove leaves them listed, and the page can say why", async () => {
    const thijs = await put("Contacts/People/Thijs Brouwer.md", "---\ntitle: Thijs Brouwer\naliases: [Thijs]\ntags: [contact]\n---\nx\n");
    const lena = await put("Contacts/People/Lena Smit.md", "---\ntitle: Lena Smit\ntags: [contact]\n---\nx\n");
    // Thijs is in the text by an alias; Lena only under ## People.
    await put("04-Projects/mention.md", "---\ntitle: Mention\ntags: [project/mention]\n---\n# Mention\n\nAsk [[Thijs]] to sign the data agreement.\n\n## People\n- [[Contacts/People/Thijs Brouwer|Thijs Brouwer]]\n- [[Contacts/People/Lena Smit|Lena Smit]]\n");
    const people = async () => Object.fromEntries((await api("GET", "/api/projects/mention")).json.people.map((p: { id: string; inText: boolean }) => [p.id, p.inText]));
    expect(await people()).toEqual({ [thijs]: true, [lena]: false });

    await api("DELETE", `/api/projects/mention/people/${thijs}`);
    expect(onDisk("04-Projects/mention.md")).toContain("Ask [[Thijs]] to sign");
    expect(onDisk("04-Projects/mention.md")).not.toContain("[[Contacts/People/Thijs Brouwer");
    // Still listed, through the text alone.
    expect(await people()).toEqual({ [thijs]: true, [lena]: false });
  });

  it("a title or path a wiki link cannot hold still links the right note", async () => {
    const odd = await put("Contacts/People/A [b] #1.md", "---\ntitle: A | B [c]\ntags: [contact]\n---\nx\n");
    await put("04-Projects/odd.md", "---\ntitle: Odd\ntags: [project/odd]\n---\n# Odd\n");
    await api("POST", "/api/projects/odd/people", { noteId: odd });
    expect((await api("GET", "/api/projects/odd")).json.people.map((p: { id: string }) => p.id)).toEqual([odd]);
    expect((await api("DELETE", `/api/projects/odd/people/${odd}`)).json).toEqual({ ok: true });
    expect((await api("GET", "/api/projects/odd")).json.people).toEqual([]);
  });
});
