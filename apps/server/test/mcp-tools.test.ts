/**
 * Every MCP tool against a real server (audit OPS-008; MCP-A, 27 Oct 2026). apps/mcp's
 * requests.test.ts pins the request each tool sends; this checks the server answers it the
 * way the tool's description promises — the box is ticked in the file, the event is in the
 * calendar note, the draft waits — and that a token can do no more than its owner on screen:
 * each tool has a `does` (Jules's token) and a `refuses` (Mara's token, on what Mara can't
 * read or can't change; the ACL is the server's, never the tool's). The last test holds every
 * tool the server lists to both.
 *
 * In the seed, Mara (marketing) can read the top folder and 04-Projects but change neither,
 * can't see Engineering/ (Atlas) at all, and nobody but Jules sees Personal/jules/.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { TOOLS } from "../../mcp/src/tools.js";
import { bootAi } from "./helpers/aiServer.js";
import { mcpClient } from "./helpers/mcp.js";

const s = await bootAi("mcp-tools");
afterAll(() => s.close());

const { tables } = await import("../src/db.js");
const { encryptSecret } = await import("../src/secrets.js");
const { starterOntology } = await import("../src/firstRun.js");
const julesAcl = s.aclUser("jules");
const write = (rel: string, text: string) => s.built.store.write(julesAcl, rel, text);
write("Orrama/What things are.md", starterOntology());
const errands = write("Shared/Errands.md", "# Errands\n\n- [ ] buy seeds\n- [ ] fix the gate\n- [ ] call the plumber\n- [ ] order compost\n- [ ] sweep the path\n- [ ] oil the hinges\n");
const diary = write("Personal/jules/Diary.md", "# Diary\n\nThe zebracorn plan stays between us.\n");
write("Personal/jules/Contacts/Zora Quill.md", "---\ntitle: Zora Quill\ntags: [contact]\nrole: Broker\ncompany: \"[[Contacts/Companies/Northwind|Northwind]]\"\n---\n# Zora Quill\n");
write("Personal/jules/Subscriptions.md", "---\ntags: [subscriptions]\n---\n# Subscriptions\n\n| Service | Amount | Every | Next |\n|---|---|---|---|\n| Spotify | 11.99 | monthly | 2026-11-05 |\n");

const jules = await mcpClient(s.built.app, s.tokens.jules!);
const mara = await mcpClient(s.built.app, s.tokens.mara!);
const file = (rel: string) => fs.readFileSync(path.join(s.vault, rel), "utf8");
const exists = (rel: string) => fs.existsSync(path.join(s.vault, rel));
const API_ERROR = /Orrama API error \(40[34]\)/;
const day = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** Which tools have a `does` and a `refuses` below. */
const covered = new Map<string, Set<string>>();
const mark = (tool: string, kind: string) => covered.set(tool, (covered.get(tool) ?? new Set()).add(kind));
const does = (tool: string, what: string, fn: () => Promise<void>) => (mark(tool, "does"), it(`${tool} ${what}`, fn));
const refuses = (tool: string, what: string, fn: () => Promise<void>) => (mark(tool, "refuses"), it(`${tool}, for another account's token: ${what}`, fn));

describe("finding things", () => {
  does("vault_schema", "maps the notes the token's owner can read", async () => {
    const r = await jules.tool("vault_schema");
    expect(r.json.notes).toBeGreaterThan(5);
    expect(JSON.stringify(r.json.types)).toContain("person");
  });
  refuses("vault_schema", "counts only what Mara can read", async () => {
    const mine = (await jules.tool("vault_schema")).json.notes;
    const hers = (await mara.tool("vault_schema")).json.notes;
    expect(hers).toBeLessThan(mine);
  });

  does("find_entities", "lists people by type, a private one included for its owner", async () => {
    const r = await jules.tool("find_entities", { type: "person", limit: 50 });
    expect(JSON.stringify(r.json)).toContain("Zora Quill");
  });
  refuses("find_entities", "never lists a note Mara can't read", async () => {
    const r = await mara.tool("find_entities", { type: "person", limit: 50 });
    expect(JSON.stringify(r.json)).toContain("Pieter Haans");
    expect(JSON.stringify(r.json)).not.toContain("Zora Quill");
  });

  does("get_relations", "says where someone works", async () => {
    const r = await jules.tool("get_relations", { entity: "Zora Quill" });
    expect(JSON.stringify(r.json)).toContain("Northwind");
  });
  refuses("get_relations", "a note Mara can't read is no note", async () => {
    await expect(mara.tool("get_relations", { entity: "Zora Quill" })).rejects.toThrow(/Orrama API error \(404\)/);
  });

  does("find_path", "finds how two notes connect", async () => {
    const r = await jules.tool("find_path", { from: "Zora Quill", to: "Northwind" });
    expect(r.json.found).toBe(true);
  });
  refuses("find_path", "a note Mara can't read is no note", async () => {
    await expect(mara.tool("find_path", { from: "Zora Quill", to: "Northwind" })).rejects.toThrow(/Orrama API error \(404\)/);
  });

  does("list_summaries", "lists a note by the words in its title", async () => {
    const r = await jules.tool("list_summaries", { text: "Zora" });
    expect(JSON.stringify(r.json)).toContain("Zora Quill");
  });
  refuses("list_summaries", "leaves out what Mara can't read", async () => {
    const r = await mara.tool("list_summaries", { text: "Zora" });
    expect(JSON.stringify(r.json)).not.toContain("Zora Quill");
  });

  does("search_notes", "finds a note by its words", async () => {
    const r = await jules.tool("search_notes", { query: "plumber" });
    expect(r.json.map((n: { path: string }) => n.path)).toEqual(["Shared/Errands.md"]);
  });
  refuses("search_notes", "finds nothing Mara can't read", async () => {
    expect((await jules.tool("search_notes", { query: "zebracorn" })).json).toHaveLength(1);
    expect((await mara.tool("search_notes", { query: "zebracorn" })).json).toEqual([]);
  });

  does("list_tree", "lists the readable notes", async () => {
    const r = await jules.tool("list_tree");
    expect(r.json).toEqual(expect.arrayContaining([expect.objectContaining({ id: errands.id, path: "Shared/Errands.md" }), expect.objectContaining({ id: diary.id })]));
  });
  refuses("list_tree", "lists no note Mara can't read", async () => {
    const paths = (await mara.tool("list_tree")).json.map((n: { path: string }) => n.path);
    expect(paths).toContain("Shared/Errands.md");
    expect(paths.filter((p: string) => p.startsWith("Personal/jules/") || p.startsWith("Engineering/"))).toEqual([]);
  });

  does("read_note", "reads a note by path, with its hash", async () => {
    const r = await jules.tool("read_note", { idOrPath: "Personal/jules/Diary.md" });
    expect(r.json).toMatchObject({ id: diary.id, content: expect.stringContaining("zebracorn"), hash: expect.any(String) });
  });
  refuses("read_note", "a note Mara can't read, by id, is a 404", async () => {
    await expect(mara.tool("read_note", { idOrPath: diary.id })).rejects.toThrow(/Orrama API error \(404\)/);
  });
});

describe("notes", () => {
  does("edit_note", "creates a note, then replaces it with the hash it read", async () => {
    await jules.tool("edit_note", { idOrPath: "Shared/Plan.md", content: "# Plan\n\nDig the beds.\n" });
    const read = await jules.tool("read_note", { idOrPath: "Shared/Plan.md" });
    await jules.tool("edit_note", { idOrPath: "Shared/Plan.md", content: "# Plan\n\nDig the beds. Then sow.\n", hash: read.json.hash });
    expect(file("Shared/Plan.md")).toContain("Then sow.");
  });
  refuses("edit_note", "a note Mara can read but not change, or can't read: nothing written", async () => {
    const welcome = file("Welcome.md");
    const read = await mara.tool("read_note", { idOrPath: "Welcome.md" });
    await expect(mara.tool("edit_note", { idOrPath: "Welcome.md", content: "# Mine now\n", hash: read.json.hash, shrink: true })).rejects.toThrow(API_ERROR);
    expect(file("Welcome.md")).toBe(welcome);
    const diaryText = file("Personal/jules/Diary.md");
    await expect(mara.tool("edit_note", { idOrPath: "Personal/jules/Diary.md", content: "# Gone\n" })).rejects.toThrow(/Orrama API error \(40[349]\)/);
    expect(file("Personal/jules/Diary.md")).toBe(diaryText);
  });

  does("append_to_note", "adds a line at the end", async () => {
    await jules.tool("append_to_note", { idOrPath: errands.id, line: "- [ ] stake the beans" });
    expect(file("Shared/Errands.md").trimEnd().endsWith("- [ ] stake the beans")).toBe(true);
  });
  refuses("append_to_note", "a note Mara can't change stays as it was", async () => {
    const welcome = file("Welcome.md");
    await expect(mara.tool("append_to_note", { idOrPath: "Welcome.md", line: "mara was here" })).rejects.toThrow(API_ERROR);
    expect(file("Welcome.md")).toBe(welcome);
  });

  does("move_note", "renames a note (links follow) and puts one in the trash", async () => {
    write("Shared/Plan index.md", "# Index\n\nSee [[Plan]].\n");
    const r = await jules.tool("move_note", { idOrPath: "Shared/Plan.md", to: "Shared/Garden plan" });
    expect(r.json).toMatchObject({ path: "Shared/Garden plan.md", links: 1 });
    expect(file("Shared/Plan index.md")).toContain("[[Garden plan]]");
    const t = await jules.tool("move_note", { idOrPath: "Shared/Plan index.md", trash: true });
    expect(t.json.trashPath).toBe(".trash/Shared/Plan index.md");
    expect(exists("Shared/Plan index.md")).toBe(false);
    expect(exists(".trash/Shared/Plan index.md")).toBe(true);
  });
  refuses("move_note", "can't move or trash what Mara can't change or can't read", async () => {
    await expect(mara.tool("move_note", { idOrPath: "Welcome.md", to: "Mine.md" })).rejects.toThrow(API_ERROR);
    await expect(mara.tool("move_note", { idOrPath: "Welcome.md", trash: true })).rejects.toThrow(API_ERROR);
    await expect(mara.tool("move_note", { idOrPath: diary.id, trash: true })).rejects.toThrow(/Orrama API error \(404\)/);
    expect(exists("Welcome.md") && exists("Personal/jules/Diary.md")).toBe(true);
  });
});

describe("today and steps", () => {
  const line = (text: string) => file("Shared/Errands.md").split("\n").find((l) => l.includes(text))!;

  does("get_today", "has the owner's event tomorrow in the agenda", async () => {
    await s.call("jules", "POST", "/api/events", { title: "Seed swap", date: day(1), startMin: 600, durationMin: 60 });
    const r = await jules.tool("get_today");
    expect(r.json.agenda.map((a: { title: string }) => a.title)).toContain("Seed swap");
    expect(r.json.stats.openTasks).toBeGreaterThan(0);
  });
  refuses("get_today", "Mara's Today has nothing of Jules's", async () => {
    const r = await mara.tool("get_today");
    expect(JSON.stringify(r.json)).not.toContain("Seed swap");
    expect(JSON.stringify(r.json)).not.toContain("Spotify");
  });

  does("edit_task", "changes status, dates, priority, key and words in the line; moves and deletes", async () => {
    await jules.tool("edit_task", { noteId: errands.id, text: "buy seeds", status: "done" });
    expect(line("buy seeds")).toMatch(/^- \[x\] buy seeds/);
    await jules.tool("edit_task", { noteId: errands.id, text: "fix the gate", status: "blocked", due: "2026-11-20", start: "2026-11-10", priority: 1, key: true });
    expect(line("fix the gate")).toMatch(/^- \[b\] fix the gate/);
    expect(line("fix the gate")).toMatch(/due:2026-11-20/);
    expect(line("fix the gate")).toMatch(/start:2026-11-10/);
    expect(line("fix the gate")).toMatch(/!p1/);
    expect(line("fix the gate")).toMatch(/#deadline/);
    await jules.tool("edit_task", { noteId: errands.id, text: "fix the gate", due: null, priority: null });
    expect(line("fix the gate")).not.toMatch(/due:|!p1/);
    await jules.tool("edit_task", { noteId: errands.id, text: "call the plumber", words: "call the plumber about the tap" });
    expect(line("call the plumber")).toBe("- [ ] call the plumber about the tap");
    // Changed and moved in one call: the move finds it by its new words.
    await jules.tool("create_project", { name: "Shed" });
    await jules.tool("edit_task", { noteId: errands.id, text: "order compost", words: "order more compost", moveTo: "shed" });
    expect(file("Shared/Errands.md")).not.toContain("compost");
    expect(file("04-Projects/shed.md")).toMatch(/## Tasks[\s\S]*- \[ \] order more compost/);
    await jules.tool("edit_task", { noteId: errands.id, text: "sweep the path", moveTo: "inbox" });
    expect(file("Personal/jules/Inbox.md")).toContain("- [ ] sweep the path");
    await jules.tool("edit_task", { noteId: errands.id, text: "oil the hinges", delete: true });
    expect(file("Shared/Errands.md")).not.toContain("oil the hinges");
  });
  refuses("edit_task", "a step in a note Mara can read but not change, or can't read, stays as it was", async () => {
    const welcome = file("Welcome.md");
    await expect(mara.tool("edit_task", { noteId: (await mara.tool("read_note", { idOrPath: "Welcome.md" })).json.id, text: "read the handbook @mara", status: "done" })).rejects.toThrow(API_ERROR);
    expect(file("Welcome.md")).toBe(welcome);
    const roadmap = s.built.store.index.getByPath("Engineering/Atlas Roadmap.md")!;
    await expect(mara.tool("edit_task", { noteId: roadmap.id, text: "permission test suite", delete: true })).rejects.toThrow(/Orrama API error \(404\)/);
    expect(file("Engineering/Atlas Roadmap.md")).toContain("permission test suite");
  });

  does("schedule_block", "books time on a step in the owner's calendar note", async () => {
    const r = await jules.tool("schedule_block", { noteId: errands.id, text: "stake the beans", date: "2026-11-12", startMin: 600, durationMin: 60 });
    expect(r.isError).toBeUndefined();
    expect(file("Personal/jules/Calendar/2026-11.md")).toMatch(/\| 2026-11-12 \| 10:00 \| 11:00 \|.*stake the beans/);
  });
  refuses("schedule_block", "no time booked on a step Mara can't read", async () => {
    const roadmap = s.built.store.index.getByPath("Engineering/Atlas Roadmap.md")!;
    await expect(mara.tool("schedule_block", { noteId: roadmap.id, text: "permission test suite", date: "2026-11-13" })).rejects.toThrow(API_ERROR);
    expect(fs.existsSync(path.join(s.vault, "Personal/mara/Calendar/2026-11.md")) && file("Personal/mara/Calendar/2026-11.md").includes("permission test suite")).toBe(false);
  });
});

describe("projects", () => {
  does("create_project", "writes the project note in a life area and lists it there", async () => {
    const r = await jules.tool("create_project", { name: "Kitchen Garden", area: "Work" });
    expect(r.json).toMatchObject({ ok: true, slug: "kitchen-garden", path: "04-Projects/kitchen-garden.md" });
    expect(file("04-Projects/kitchen-garden.md")).toMatch(/^area: Work$/m);
    const listed = (await jules.tool("list_projects")).json.projects.find((p: { slug: string }) => p.slug === "kitchen-garden");
    expect(listed).toMatchObject({ area: "work" });
    // A name already taken gets the next free key, never the first project's note.
    expect((await jules.tool("create_project", { name: "Kitchen Garden" })).json.slug).toBe("kitchen-garden-2");
  });
  refuses("create_project", "Mara can't write a project where she can only read, nor name an area that doesn't exist", async () => {
    await expect(mara.tool("create_project", { name: "Mara's Garden" })).rejects.toThrow(API_ERROR);
    expect(exists("04-Projects/maras-garden.md")).toBe(false);
    await expect(jules.tool("create_project", { name: "Nowhere", area: "No such area" })).rejects.toThrow(/Orrama API error \(400\): That life area doesn't exist/);
  });

  does("list_projects", "lists the life areas and the projects", async () => {
    const r = (await jules.tool("list_projects")).json;
    expect(r.areas.map((a: { name: string }) => a.name)).toEqual(["Work", "Personal"]);
    expect(r.projects.map((p: { slug: string }) => p.slug)).toEqual(expect.arrayContaining(["atlas", "acme", "kitchen-garden"]));
  });
  refuses("list_projects", "lists no project Mara can't read", async () => {
    const slugs = (await mara.tool("list_projects")).json.projects.map((p: { slug: string }) => p.slug);
    expect(slugs).toContain("acme");
    expect(slugs).not.toContain("atlas");
  });

  does("get_project", "opens the workspace with its steps", async () => {
    const r = await jules.tool("get_project", { slug: "atlas" });
    expect(r.json).toMatchObject({ slug: "atlas", name: expect.any(String) });
    expect(r.json.tasks.length).toBeGreaterThan(0);
  });
  refuses("get_project", "a project Mara can't read is not found", async () => {
    await expect(mara.tool("get_project", { slug: "atlas" })).rejects.toThrow(/Orrama API error \(404\)/);
  });

  does("update_project", "renames, pauses, moves area and group, sets and clears dates", async () => {
    await jules.tool("update_project", { slug: "kitchen-garden", name: "Kitchen garden", status: "paused", area: "Personal", group: "Outside", start: "2026-11-01", deadline: "2027-03-01" });
    const fm = file("04-Projects/kitchen-garden.md");
    for (const want of [/^title: Kitchen garden$/m, /^status: paused$/m, /^area: Personal$/m, /^group: Outside$/m, /^start: ["']?2026-11-01/m, /^deadline: ["']?2027-03-01/m]) expect(fm).toMatch(want);
    await jules.tool("update_project", { slug: "kitchen-garden", deadline: "", group: "" });
    expect(file("04-Projects/kitchen-garden.md")).not.toMatch(/^(deadline|group):/m);
  });
  refuses("update_project", "Mara can read the project but not change it, and can't reach one she can't read", async () => {
    const before = file("04-Projects/kitchen-garden.md");
    expect((await mara.tool("get_project", { slug: "kitchen-garden" })).json.canEdit).toBe(false);
    await expect(mara.tool("update_project", { slug: "kitchen-garden", status: "cancelled" })).rejects.toThrow(API_ERROR);
    await expect(mara.tool("update_project", { slug: "atlas", status: "cancelled" })).rejects.toThrow(/Orrama API error \(404\)/);
    expect(file("04-Projects/kitchen-garden.md")).toBe(before);
  });

  does("add_to_project", "adds a step with its tokens, an inbox line, a decision and a goal", async () => {
    await jules.tool("add_to_project", { slug: "kitchen-garden", kind: "step", text: "order seeds", due: "2026-11-02", priority: 1, key: true });
    await jules.tool("add_to_project", { slug: "kitchen-garden", kind: "inbox", text: "ask about the shed" });
    await jules.tool("add_to_project", { slug: "kitchen-garden", kind: "decision", text: "Raised beds: the soil is clay" });
    await jules.tool("add_to_project", { slug: "kitchen-garden", kind: "goal", text: "Salad by June" });
    const p = (await jules.tool("get_project", { slug: "kitchen-garden" })).json;
    expect(p.tasks.map((t: { text: string; due?: string; priority?: number; key?: boolean }) => [t.text, t.due, t.priority, t.key])).toContainEqual(["order seeds", "2026-11-02", 1, true]);
    expect(JSON.stringify(p.inbox)).toContain("ask about the shed");
    expect(JSON.stringify(p.decisions)).toContain("Raised beds: the soil is clay");
    expect(JSON.stringify(p.goals)).toContain("Salad by June");
  });
  refuses("add_to_project", "nothing is added to a project Mara can't change or can't read", async () => {
    const before = file("04-Projects/kitchen-garden.md");
    await expect(mara.tool("add_to_project", { slug: "kitchen-garden", kind: "decision", text: "Mara decides" })).rejects.toThrow(API_ERROR);
    await expect(mara.tool("add_to_project", { slug: "atlas", kind: "step", text: "sneak in" })).rejects.toThrow(/Orrama API error \(404\)/);
    expect(file("04-Projects/kitchen-garden.md")).toBe(before);
    expect(file("Engineering/Atlas Roadmap.md")).not.toContain("sneak in");
  });
});

describe("people and companies", () => {
  does("get_contacts", "lists the people in the notes (not the accounts) and the companies", async () => {
    const r = (await jules.tool("get_contacts")).json;
    const people = JSON.stringify(r.people);
    expect(people).toContain("Pieter Haans");
    expect(people).toContain("Zora Quill");
    expect(people).not.toContain("erin@orrama.dev");
    expect(r.companies.map((c: { name: string }) => c.name)).toContain("Northwind");
  });
  refuses("get_contacts", "lists no one Mara can't read", async () => {
    expect(JSON.stringify((await mara.tool("get_contacts")).json.people)).not.toContain("Zora Quill");
  });

  does("save_contact", "makes a company and a person who works there, then changes a fact", async () => {
    const co = await jules.tool("save_contact", { kind: "company", name: "Oakline Builders", location: "Utrecht", website: "https://oakline.example" });
    expect(co.json).toMatchObject({ ok: true, made: "Contacts/Companies/Oakline Builders.md" });
    expect(file("Contacts/Companies/Oakline Builders.md")).toMatch(/^location: Utrecht$/m);
    const p = await jules.tool("save_contact", { kind: "person", name: "Ines Vermaat", role: "Site lead", company: "oakline builders" });
    expect(file("Contacts/Ines Vermaat.md")).toMatch(/^tags: \[contact\]$/m);
    expect(file("Contacts/Ines Vermaat.md")).toMatch(/^role: Site lead$/m);
    const listed = (await jules.tool("get_contacts")).json.people.find((x: { name: string }) => x.name === "Ines Vermaat");
    expect(listed.companyId).toBe(co.json.id);
    await jules.tool("save_contact", { kind: "person", id: p.json.id, email: "ines@oakline.example" });
    expect(file("Contacts/Ines Vermaat.md")).toMatch(/^email: ines@oakline.example$/m);
    // Someone already there is never replaced.
    await expect(jules.tool("save_contact", { kind: "person", name: "Ines Vermaat" })).rejects.toThrow(/Orrama API error \(409\)/);
  });
  refuses("save_contact", "Mara can't change someone she can't read, nor say they work at a company she can't see", async () => {
    const zora = s.built.store.index.getByPath("Personal/jules/Contacts/Zora Quill.md")!;
    const before = file("Personal/jules/Contacts/Zora Quill.md");
    await expect(mara.tool("save_contact", { kind: "person", id: zora.id, role: "Nobody" })).rejects.toThrow(/Orrama API error \(404\)/);
    expect(file("Personal/jules/Contacts/Zora Quill.md")).toBe(before);
    // Shared with marketing to read: Mara sees him, and still can't change him.
    const ravi = write("Personal/jules/Contacts/Ravi Sen.md", "---\ntitle: Ravi Sen\ntags: [contact, share/marketing]\nrole: Printer\n---\n# Ravi Sen\n");
    expect(JSON.stringify((await mara.tool("get_contacts")).json.people)).toContain("Ravi Sen");
    await expect(mara.tool("save_contact", { kind: "person", id: ravi.id, role: "Nobody" })).rejects.toThrow(/Orrama API error \(403\)/);
    expect(file("Personal/jules/Contacts/Ravi Sen.md")).toMatch(/^role: Printer$/m);
    write("Personal/jules/Contacts/Companies/Hidden Ltd.md", "---\ntitle: Hidden Ltd\ntags: [company]\n---\n# Hidden Ltd\n");
    const pieter = file("Contacts/Pieter Haans.md");
    const r = await mara.tool("save_contact", { kind: "person", id: s.built.store.index.getByPath("Contacts/Pieter Haans.md")!.id, company: "Hidden Ltd" });
    expect(r.isError).toBe(true);
    expect(file("Contacts/Pieter Haans.md")).toBe(pieter);
  });
});

describe("the calendar", () => {
  let series = "";

  does("create_event", "puts a repeating event with a place in the owner's calendar note", async () => {
    const r = await jules.tool("create_event", { title: "Allotment", date: "2026-12-01", startMin: 540, durationMin: 90, place: "Plot 12", notes: "Bring gloves", repeat: { every: "week", interval: 1, until: "2026-12-15" } });
    series = r.json.id;
    expect(r.json).toMatchObject({ title: "Allotment", date: "2026-12-01", startMin: 540, durationMin: 90 });
    const row = file("Personal/jules/Calendar/2026-12.md").split("\n").find((l) => l.includes("Allotment"))!;
    expect(row).toContain("Plot 12");
    expect(row).toMatch(/weekly/);
  });
  refuses("create_event", "Mara's event goes in her own calendar, never in Jules's", async () => {
    await mara.tool("create_event", { title: "Mara's dentist", date: "2026-12-02", startMin: 600 });
    expect(file("Personal/jules/Calendar/2026-12.md")).not.toContain("Mara's dentist");
    const jl = (await jules.tool("list_events", { from: "2026-12-01", to: "2026-12-31" })).json;
    expect(JSON.stringify(jl)).not.toContain("Mara's dentist");
  });

  does("list_events", "lists each day of a repeating event with its day id", async () => {
    const r = (await jules.tool("list_events", { from: "2026-12-01", to: "2026-12-31" })).json as { id: string; title: string; date: string }[];
    expect(r.filter((e) => e.title === "Allotment").map((e) => e.date)).toEqual(["2026-12-01", "2026-12-08", "2026-12-15"]);
  });
  refuses("list_events", "Mara never sees Jules's events", async () => {
    const r = (await mara.tool("list_events", { from: "2026-12-01", to: "2026-12-31" })).json as { title: string }[];
    expect(r.map((e) => e.title)).toEqual(["Mara's dentist"]);
  });

  does("edit_event", "changes one day of a series, then deletes the series", async () => {
    await jules.tool("edit_event", { id: `${series}@2026-12-08`, startMin: 600 });
    let days = (await jules.tool("list_events", { from: "2026-12-01", to: "2026-12-31" })).json.filter((e: { title: string }) => e.title === "Allotment");
    expect(days.map((e: { date: string; startMin: number }) => `${e.date} ${e.startMin}`)).toEqual(["2026-12-01 540", "2026-12-08 600", "2026-12-15 540"]);
    await jules.tool("edit_event", { id: `${series}@2026-12-15`, delete: true, scope: "all" });
    days = (await jules.tool("list_events", { from: "2026-12-01", to: "2026-12-31" })).json.filter((e: { title: string }) => e.title === "Allotment");
    expect(days.map((e: { date: string }) => e.date)).toEqual(["2026-12-08"]); // the day changed alone is an event of its own
  });
  refuses("edit_event", "Mara can neither change nor delete Jules's event", async () => {
    const r = await jules.tool("create_event", { title: "Pruning", date: "2026-12-20", startMin: 600 });
    await expect(mara.tool("edit_event", { id: r.json.id, title: "Mara's now" })).rejects.toThrow(/Orrama API error \(403\)/);
    await expect(mara.tool("edit_event", { id: r.json.id, delete: true })).rejects.toThrow(/Orrama API error \(403\)/);
    expect(file("Personal/jules/Calendar/2026-12.md")).toContain("Pruning");
  });
});

describe("money", () => {
  does("get_money", "reads the owner's commitments", async () => {
    const r = (await jules.tool("get_money")).json;
    expect(r.subscriptions.items.map((i: { service: string }) => i.service)).toContain("Spotify");
    expect(r).not.toHaveProperty("tables");
  });
  refuses("get_money", "Mara's money has nothing of Jules's", async () => {
    const r = (await mara.tool("get_money")).json;
    expect(JSON.stringify(r)).not.toContain("Spotify");
  });
});

describe("mail", () => {
  does("list_email", "without a connected account says so", async () => {
    await expect(jules.tool("list_email", { limit: 5 })).rejects.toThrow(/no mail account connected/);
  });
  does("read_email", "without a connected account says so", async () => {
    await expect(jules.tool("read_email", { uid: 1 })).rejects.toThrow(/no mail account connected/);
  });

  does("draft_email", "stages a draft that waits for the user; nothing is sent", async () => {
    const users = s.built.db.select().from(tables.users).all();
    s.built.db
      .insert(tables.mailAccounts)
      .values({
        id: `mail-${crypto.randomUUID().slice(0, 8)}`,
        userId: users.find((u) => u.username === "jules")!.id,
        email: "jules.personal@example.com",
        imapHost: "imap.example.com",
        imapPort: 993,
        smtpHost: "smtp.example.com",
        smtpPort: 465,
        passwordEncrypted: encryptSecret("app-password"),
        createdAt: Date.now(),
        lastCheckedAt: null,
        lastError: null,
      })
      .run();
    const r = await jules.tool("draft_email", { to: "mara@example.com", subject: "Seeds", body: "Thursday works." });
    expect(r.json).toMatchObject({ status: "awaiting_confirmation", to: "mara@example.com", subject: "Seeds" });
    const drafts = (await s.call("jules", "GET", "/api/mail/drafts")).json as { id: string; subject: string }[];
    expect(drafts.map((d) => d.subject)).toContain("Seeds");
    // The token cannot send it, even knowing everything about it.
    const send = await s.call(jules.token, "POST", "/api/mail/send", { to: "mara@example.com", subject: "Seeds", body: "Thursday works." });
    expect(send.status).toBe(403);
  });
  refuses("draft_email", "Mara can't draft from Jules's mailbox, nor see his draft", async () => {
    await expect(mara.tool("draft_email", { to: "x@example.com", subject: "Hi", body: "Hello" })).rejects.toThrow(/no mail account connected/);
    const hers = (await s.call("mara", "GET", "/api/mail/drafts")).json as { subject: string }[];
    expect(hers.map((d) => d.subject)).not.toContain("Seeds");
  });
  // After draft_email connected Jules's account: it is still his alone.
  refuses("list_email", "Mara's token never reads Jules's inbox", async () => {
    await expect(mara.tool("list_email", { limit: 5 })).rejects.toThrow(/no mail account connected/);
  });
  refuses("read_email", "Mara's token never reads Jules's mail", async () => {
    await expect(mara.tool("read_email", { uid: 1 })).rejects.toThrow(/no mail account connected/);
  });
});

describe("every tool", () => {
  it("has a test of what it does and of what another account's token can't do with it", () => {
    const missing = TOOLS.flatMap((t) => ["does", "refuses"].filter((k) => !covered.get(t.name)?.has(k)).map((k) => `${t.name}: ${k}`));
    expect(missing).toEqual([]);
    expect([...covered.keys()].filter((k) => !TOOLS.some((t) => t.name === k))).toEqual([]);
  });
});
