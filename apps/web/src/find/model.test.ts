import { describe, expect, it } from "vitest";
import type { Company, Contact, ProjectRow } from "@orrama/schema/responses";
import { entityItems, noteItems, placeItems, settingItems, type Lists } from "./build.js";
import { flat, groupsOf, isFilterQuery, markOf, nextType, parseQuery, remember, scoreOf, withFolders, type Item } from "./model.js";

const item = (type: Item["type"], title: string, score: number, extra: Partial<Item> = {}): Item => ({ key: `${type}:${title}`, type, title, meta: "", lead: { kind: "icon", of: "doc" }, score, route: { kind: "today" }, ...extra });

describe("the query", () => {
  it("a type typed first narrows to it, and leaves the rest as the words", () => {
    expect(parseQuery("person Ines", null)).toEqual({ words: ["ines"], type: "person", raw: "Ines" });
    expect(parseQuery("projects thesis", null).type).toBe("project");
    expect(parseQuery("Kade", null)).toEqual({ words: ["kade"], type: null, raw: "Kade" });
    expect(parseQuery("person ines", "company").type).toBe("company"); // a type picked with Tab stays
  });
  it("the server's own filters go to the server as they are", () => {
    expect(isFilterQuery("tag:project")).toBe(true);
    expect(isFilterQuery("thesis path:04-Projects")).toBe(true);
    expect(isFilterQuery("kade")).toBe(false);
  });
});

describe("matching", () => {
  it("the whole name, then its start, then a word's start, then anywhere, then the line under it", () => {
    expect(scoreOf(["kade", "social"], "Kade Social")).toBe(100);
    expect(scoreOf(["kade"], "Kade Social")).toBe(80);
    expect(scoreOf(["soc"], "Kade Social")).toBe(60);
    expect(scoreOf(["ade"], "Kade Social")).toBe(40);
    expect(scoreOf(["agency"], "Kade Social", "Social-media agency")).toBe(15);
    expect(scoreOf(["nothing"], "Kade Social")).toBe(0);
    expect(scoreOf(["elodie"], "Élodie Fàbregas")).toBe(80); // accents folded
  });
  it("underlines the match in the name", () => {
    expect(markOf("Untangling the Kade labels", ["kade"])).toEqual(["Untangling the ", "Kade", " labels"]);
    expect(markOf("Kade", [])).toBeNull();
  });
  it("a folder is said only when two results share a name", () => {
    const out = withFolders([item("note", "Plan", 50, { folder: "School" }), item("note", "Plan", 50, { folder: "Work", key: "b" }), item("note", "Other", 50, { folder: "Work" })]);
    expect(out.map((i) => i.folder)).toEqual(["School", "Work", undefined]);
  });
});

describe("groups", () => {
  it("the group with the best match first, then the board's order, actions last", () => {
    const g = groupsOf([item("note", "Kade drinks", 55), item("company", "Kade Social", 80), item("person", "Thijs", 79), item("action", "Show Kade", 0.5), item("place", "People", 15)]);
    expect(g.map((x) => x.id)).toEqual(["companies", "people", "notes", "places", "actions"]);
    expect(g[2]!.label).toBe("Notes and conversations");
  });
  it("within a group by score, then name; capped when nothing narrows the type", () => {
    const g = groupsOf([item("person", "B", 60), item("person", "A", 60), item("person", "C", 80)], { limit: 2 });
    expect(g[0]!.items.map((i) => i.title)).toEqual(["C", "A"]);
    expect(g[0]!.note).toBe("3");
    expect(flat(g).map((i) => i.title)).toEqual(["C", "A"]);
  });
  it("Tab cycles any → person → … → action → any; Shift+Tab goes back", () => {
    expect(nextType(null)).toBe("person");
    expect(nextType("person")).toBe("company");
    expect(nextType("action")).toBeNull();
    expect(nextType(null, true)).toBe("action");
  });
  it("a pick goes to the top of Recent once; actions are not kept", () => {
    const a = item("person", "Ines", 1, { route: { kind: "person", slug: "ines" } });
    const b = item("project", "Thesis", 1, { route: { kind: "project", slug: "thesis" } });
    expect(remember(remember([], a), b).map((r) => r.title)).toEqual(["Thesis", "Ines"]);
    expect(remember(remember(remember([], a), b), a).map((r) => r.title)).toEqual(["Ines", "Thesis"]);
    expect(remember([], item("action", "New note", 1, { route: undefined, action: "new-note" }))).toEqual([]);
  });
});

/* ---- what is found ---------------------------------------------------------------------- */

const contact = (name: string, company = "", extra: Partial<Contact> = {}): Contact => ({ id: `n-${name.toLowerCase().replace(/\W+/g, "")}`, name, path: `Contacts/${name}.md`, sector: "", role: "", company, email: "", phone: "", linkedin: "", personal: false, ...extra });
const company = (name: string, extra: Partial<Company> = {}): Company => ({ id: `n-${name.toLowerCase().replace(/\W+/g, "")}`, name, path: `Contacts/Companies/${name}.md`, description: "", sector: "", linkedin: "", website: "", careers: "", location: "", positions: [], personal: false, ...extra });
const project = (slug: string, name: string, noteId: string, extra: Partial<ProjectRow> = {}): ProjectRow => ({ slug, key: `project/${slug}`, name, domain: null, area: "work", noteId, total: 4, done: 1, status: "at-risk", start: null, deadline: null, group: null, nextDue: "2026-10-09", overdue: 0, ...extra });

const LISTS: Lists = {
  contacts: [contact("Thijs Brouwer", "[[Kade Social]]", { role: "Data lead" }), contact("Noor El Amrani", "[[Kade Social]]"), contact("Ines Vermaat", "[[Westerdok]]")],
  companies: [company("Kade Social", { description: "Social-media agency", location: "Amsterdam" }), company("Westerdok")],
  projects: [project("reporting-dashboard", "Reporting dashboard", "n-dash"), project("graduation-thesis", "Graduation thesis", "n-thesis", { status: "on-track" })],
  nodes: [{ id: "n-talk", title: "Untangling the Kade labels", folder: "07-Claude", sector: null, tags: [], links: 0, tasks: 0, kind: "conversation", description: "" }],
  edges: [{ from: "n-talk", to: "n-dash", relation: "about" }],
  tree: [
    { id: "n-talk", path: "07-Claude/Untangling the Kade labels.md", folder: "07-Claude", title: "Untangling the Kade labels", hash: "h", mtimeMs: 0, tags: [], openTasks: 0, category: "tools" },
    { id: "n-off", path: "Personal/Kade offsite.md", folder: "Personal", title: "Kade offsite", hash: "h", mtimeMs: 0, tags: [], openTasks: 0, category: "personal" },
    { id: "n-dash", path: "04-Projects/reporting-dashboard.md", folder: "04-Projects", title: "Reporting dashboard", hash: "h", mtimeMs: 0, tags: [], openTasks: 0, category: "work" },
  ],
  context: {
    typed: true,
    entries: [
      { id: "n-kadesocial", relations: [{ relation: "company_involved_in", to: [{ id: "n-dash", title: "Reporting dashboard", type: "project" }] }], mention: null },
      { id: "n-thijsbrouwer", relations: [{ relation: "supervises", to: [{ id: "n-dash", title: "Reporting dashboard", type: "project" }] }], mention: null },
    ],
  },
};

describe("what Find finds", () => {
  it("a company by name brings who works there and the projects it is in, and says why", () => {
    const { items, via } = entityItems(["kade"], LISTS);
    const by = (t: string) => items.filter((i) => i.type === t).map((i) => i.title).sort();
    expect(by("company")).toEqual(["Kade Social"]);
    expect(by("person")).toEqual(["Noor El Amrani", "Thijs Brouwer"]);
    expect(by("project")).toEqual(["Reporting dashboard"]);
    expect(via).toEqual({ people: "2 at Kade Social", projects: "1 for Kade Social" });
    expect(items.find((i) => i.title === "Thijs Brouwer")!.meta).toBe("Data lead · Kade Social · supervises Reporting dashboard");
    expect(items.find((i) => i.title === "Kade Social")!.meta).toBe("Social-media agency · Amsterdam · 2 people you know");
  });
  it("a project opens the project, not its note", () => {
    const { items } = entityItems(["thesis"], LISTS);
    expect(items.find((i) => i.type === "project")!.route).toEqual({ kind: "project", slug: "graduation-thesis" });
  });
  it("a conversation says with whom and what it's about, and opens its own page", () => {
    const it = entityItems(["untangling"], LISTS).items.find((i) => i.type === "conversation")!;
    expect(it.meta.startsWith("with Claude · about Reporting dashboard")).toBe(true);
    expect(it.route).toEqual({ kind: "conversation", slug: "untangling-the-kade-labels" });
  });
  it("the server's notes, less what is already found as itself", () => {
    const hits = [
      { id: "n-off", path: "Personal/Kade offsite.md", title: "Kade offsite" },
      { id: "n-talk", path: "07-Claude/Untangling the Kade labels.md", title: "Untangling the Kade labels" },
      { id: "n-kadesocial", path: "Contacts/Companies/Kade Social.md", title: "Kade Social" },
    ];
    const notes = noteItems(hits, LISTS, new Set(), ["kade"]);
    expect(notes.map((n) => [n.type, n.title])).toEqual([
      ["note", "Kade offsite"],
      ["conversation", "Untangling the Kade labels"],
    ]);
    expect(notes[0]!.route).toEqual({ kind: "notes", path: "Personal/Kade offsite" });
    expect(notes[0]!.score).toBeLessThan(80); // below a company matched as well
  });
  it("places with their key; settings by their words", () => {
    expect(placeItems(["mone"]).map((p) => [p.title, p.keycap])).toEqual([["Money", "8"]]);
    const s = settingItems(["dark"], [{ label: "Theme", section: "appearance", sectionLabel: "Appearance" }]);
    expect(s[0]).toMatchObject({ title: "Theme", meta: "Settings → Appearance", route: { kind: "settings", section: "appearance" } });
  });
});
