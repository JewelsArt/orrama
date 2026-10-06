/** The five questions: vault_schema, find_entities, get_relations, find_path, list_summaries. Fictional fixtures only. */
import { describe, expect, it } from "vitest";
import { ONTOLOGY_TEMPLATE, VaultIndex, buildGraph, findEntities, findPath, getRelations, listSummaries, parseOntology, vaultSchema } from "../src/index.js";
import { FILES } from "./graph-fixture.js";

const g = buildGraph(new VaultIndex(FILES), parseOntology(ONTOLOGY_TEMPLATE));
const titles = (xs: { title: string }[]) => xs.map((x) => x.title);

describe("vaultSchema", () => {
  const s = vaultSchema(g);
  it("counts per type and per relation, and lists what is derived", () => {
    expect(s.notes).toBe(g.entities.size);
    expect(s.types.find((t) => t.id === "company")?.count).toBe(3); // Acme, Globex, Initech
    expect(s.types.find((t) => t.id === "conversation")?.count).toBe(2);
    expect(s.relations.find((r) => r.id === "works_at")).toMatchObject({ domain: ["person"], range: ["company"], inverse: "employs", count: 3 });
    expect(s.derived).toEqual([{ id: "involves_company", meaning: "involves . works_at (inverse: company_involved_in)", count: 1 }]);
  });
  it("project statuses in the vocabulary's order; the most connected note first", () => {
    expect(s.statuses.map((x) => x.id)).toEqual(["planned", "on-track", "paused", "archived"]);
    expect(s.mostConnected[0]).toMatchObject({ title: "Rocket", connections: 6 }); // involves ×3, has_part, supervised_by, discussed_in — not the derived one
    expect(s.mostConnected.length).toBeLessThanOrEqual(10);
  });
  it("the warnings, most frequent first", () => {
    expect(s.warnings.find((w) => w.code === "person-without-company")?.count).toBe(2);
  });
});

describe("findEntities", () => {
  const id = (title: string) => [...g.entities.values()].find((e) => e.title === title)!.id;
  it("by type and field — case- and accent-folded, `~` for contains", () => {
    expect(titles(findEntities(g, { type: "company", where: { location: "rotterdam" } }).entities)).toEqual(["Acme"]);
    expect(titles(findEntities(g, { type: "company", where: { location: "~trecht" } }).entities)).toEqual(["Globex"]);
    expect(findEntities(g, { type: "document", where: { deadline: "2026-10-19" } }).entities.map((e) => e.title)).toEqual(["Rocket Plan"]);
  });
  it("by status — the vocabulary's names, not the tag a note happens to carry", () => {
    expect(titles(findEntities(g, { type: "project", status: "paused" }).entities)).toEqual(["Sled"]);
    expect(titles(findEntities(g, { type: "project", status: "archived" }).entities)).toEqual(["Lamp"]);
  });
  it("by a relation to a note — people who work at Acme, projects Ada is involved in", () => {
    expect(titles(findEntities(g, { relation: { relation: "works_at", to: id("Acme") } }).entities).sort()).toEqual(["Ada Quill", "Ed Rook"]);
    expect(titles(findEntities(g, { type: "project", relation: { relation: "involves_company", to: id("Acme") } }).entities)).toEqual(["Rocket"]);
  });
  it("a limit cuts the list but the total says how many there were", () => {
    const r = findEntities(g, { type: "person", limit: 2 });
    expect(r.entities).toHaveLength(2);
    expect(r.total).toBe(5);
  });
  it("rows carry the summary and the fields, without repeating the description inside them", () => {
    const r = findEntities(g, { type: "conversation", text: "launch window" }).entities[0]!;
    expect(r.summary).toBe("Planned the rocket launch window");
    expect(r.fields).toEqual({ date: "2026-06-04", project: "[[rocket]]" });
  });
});

describe("getRelations", () => {
  const rocket = [...g.entities.values()].find((e) => e.title === "Rocket")!.id;
  const a = getRelations(g, rocket)!;
  it("groups an entity's neighbours by relation, inverses and derived included", () => {
    const rel = (name: string) => titles(a.relations.find((r) => r.relation === name)?.to ?? []);
    expect(rel("involves")).toEqual(["Ada Quill", "Ed Rook", "Globex"]);
    expect(rel("has_part")).toEqual(["Rocket Plan"]);
    expect(rel("supervised_by")).toEqual(["Di Vale"]);
    expect(rel("discussed_in")).toEqual(["Planning rocket"]);
    expect(rel("involves_company")).toEqual(["Acme"]);
  });
  it("every neighbour says where it was read, and a derived one what it went through", () => {
    const ada = a.relations.find((r) => r.relation === "involves")!.to[0]!;
    expect(ada).toMatchObject({ via: "section", where: "## People", source: { title: "Rocket" } });
    expect(a.relations.find((r) => r.relation === "involves_company")!.to[0]!.through).toEqual([{ id: ada.id, title: "Ada Quill" }]);
  });
  it("one relation only, when asked", () => {
    expect(getRelations(g, rocket, "has_part")!.relations.map((r) => r.relation)).toEqual(["has_part"]);
  });
  it("a note's warnings come with it; an unknown note is null", () => {
    const di = [...g.entities.values()].find((e) => e.title === "Di Vale")!.id;
    expect(getRelations(g, di)!.warnings).toEqual(["Di Vale has no company"]);
    expect(getRelations(g, "n-nope")).toBeNull();
  });
});

describe("findPath", () => {
  const id = (title: string) => [...g.entities.values()].find((e) => e.title === title)!.id;
  it("the shortest typed connection, step by step with provenance", () => {
    const r = findPath(g, id("Rocket Plan"), id("Acme"));
    expect(r.found).toBe(true);
    expect(r.length).toBe(3);
    expect(r.paths[0]!.map((s) => `${s.from.title} ${s.relation} ${s.to.title}`)).toEqual([
      "Rocket Plan part_of Rocket",
      "Rocket involves Ada Quill",
      "Ada Quill works_at Acme",
    ]);
    expect(r.paths[0]![0]).toMatchObject({ via: "tag", where: "tag project/rocket" });
  });
  it("never takes a derived shortcut", () => {
    const r = findPath(g, id("Rocket"), id("Acme"));
    expect(r.length).toBe(2); // involves → works_at, not involves_company
  });
  it("no connection, or too far, is found:false — not an error", () => {
    expect(findPath(g, id("Kite"), id("Acme")).found).toBe(false);
    expect(findPath(g, id("Rocket Plan"), id("Acme"), { maxDepth: 2 }).found).toBe(false);
    expect(findPath(g, id("Acme"), id("Acme")).found).toBe(false);
  });
  it("lists every shortest path up to the limit", () => {
    // Acme → Ada → Rocket and Acme → Ed → Rocket are equally short.
    const r = findPath(g, id("Acme"), id("Rocket"));
    expect(r.paths.map((p) => p.map((s) => s.to.title).join(" > ")).sort()).toEqual(["Ada Quill > Rocket", "Ed Rook > Rocket"]);
    expect(findPath(g, id("Acme"), id("Rocket"), { limit: 1 }).paths).toHaveLength(1);
  });
});

describe("listSummaries", () => {
  it("one line per note, newest first, with what it is about", () => {
    const r = listSummaries(g, { type: "conversation" });
    expect(r.total).toBe(2);
    expect(r.items.map((i) => [i.title, i.date, i.about?.title])).toEqual([
      ["Chat", "2026-09-01", undefined],
      ["Planning rocket", "2026-06-04", "Rocket"],
    ]);
    expect(r.items[1]!.summary).toBe("Planned the rocket launch window");
    expect(r.items.every((i) => i.type === undefined)).toBe(true); // one type asked for: not repeated per row
    expect(listSummaries(g, { limit: 1 }).items[0]!.type).toBeDefined();
    const long = buildGraph(new VaultIndex([{ path: "x.md", content: `---\nid: n-x\ntitle: ${"word ".repeat(40).trim()}\n---\nBody.` }]), parseOntology(ONTOLOGY_TEMPLATE));
    expect(listSummaries(long, {}).items[0]!.title.length).toBeLessThanOrEqual(80);
  });
  it("filters by what it is about, by words, and by date range", () => {
    const rocket = [...g.entities.values()].find((e) => e.title === "Rocket")!.id;
    expect(titles(listSummaries(g, { about: rocket }).items)).toEqual(["Planning rocket"]);
    expect(titles(listSummaries(g, { type: "conversation", text: "LAUNCH" }).items)).toEqual(["Planning rocket"]);
    expect(titles(listSummaries(g, { type: "conversation", from: "2026-07-01" }).items)).toEqual(["Chat"]);
    expect(titles(listSummaries(g, { type: "conversation", from: "2026-06-04", to: "2026-06-04" }).items)).toEqual(["Planning rocket"]); // both ends inclusive
    expect(titles(listSummaries(g, { type: "conversation", to: "2026-07-01" }).items)).toEqual(["Planning rocket"]);
  });
  it("a limit cuts the list, the total does not", () => {
    const r = listSummaries(g, { limit: 3 });
    expect(r.items).toHaveLength(3);
    expect(r.total).toBe(g.entities.size);
  });
});
