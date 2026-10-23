/** The Orrery's model: what each file is, where it belongs, and how its relations read. */
import { describe, expect, it } from "vitest";
import { FIXTURE_AREAS, fixture, NOW } from "./fixture.js";
import { buildModel, folderTopic, isReviewOrTemplate, relationGroups, signature, slugOf, statusWord, type Model } from "./model.js";

const build = (f = fixture(), schema: Parameters<typeof buildModel>[3] = { relations: [{ id: "attends", inverse: "attended_by" }] }) => buildModel(f.graph, f.tree, f.projects, schema, NOW);
const node = (m: Model, id: string) => m.nodes.find((d) => d.id === id)!;
const area = (id: string) => FIXTURE_AREAS.findIndex((a) => a.id === id);

describe("what each file is", () => {
  const m = build();
  it("a project is a note the Projects board lists; people and companies are tagged as People shows them", () => {
    expect(node(m, "p-kade").t).toBe(0);
    expect(node(m, "p-kade").project).toEqual({ slug: "kade-social-report", status: "on track", done: 3, total: 8 });
    expect(node(m, "ines").t).toBe(1);
    expect(node(m, "kade").t).toBe(2);
    expect(node(m, "c-kpi").t).toBe(4);
    expect(node(m, "n-brief").t).toBe(3);
  });
  it("weekly reviews and templates are told by folder, tag or name", () => {
    expect(node(m, "r-week").t).toBe(5);
    expect(node(m, "t-meet").t).toBe(5);
    expect(node(m, "t-tag").t).toBe(5);
    expect(isReviewOrTemplate({ path: "Work/Weekly call.md", title: "Weekly call", tags: [] })).toBe(false);
    expect(isReviewOrTemplate({ path: "_templates/Daily.md", title: "Daily", tags: [] })).toBe(true);
    expect(isReviewOrTemplate({ path: "Life/2026-W40.md", title: "Weekly review W40", tags: [] })).toBe(true);
  });
  it("counts each kind", () => expect(m.counts).toEqual([2, 2, 1, 7, 1, 3]));
});

describe("where each file belongs", () => {
  const m = build();
  it("its life area comes from the server's rules; anything else is Personal", () => {
    expect(node(m, "n-arima").area).toBe(area("knowledge"));
    expect(node(m, "n-loose").area).toBe(area("personal"));
  });
  it("a conversation sits in the area and topic of what it is about", () => {
    const c = node(m, "c-kpi");
    expect(c.area).toBe(area("work"));
    expect(c.cl).toBe(node(m, "p-kade").cl);
  });
  it("a project's notes are its topic; other notes take their folder below the top one", () => {
    expect(m.topics[node(m, "n-kpi").cl]!.name).toBe("Kade Social report");
    expect(m.topics[node(m, "p-kade").cl]!.name).toBe("Kade Social report");
    expect(m.topics[node(m, "n-call").cl]!.name).toBe("Kade Social");
    expect(m.topics[node(m, "n-arima").cl]!.name).toBe("Forecasting");
    expect(folderTopic("03-Knowledge/x.md")).toBe("Knowledge");
    expect(folderTopic("Work/Kade Social/Reports/2026/x.md")).toBe("Kade Social");
    expect(folderTopic("Welcome.md")).toBe("");
    expect(m.topics[node(m, "n-loose").cl]!.name).toBe("Personal");
  });
  it("a person goes where most of their notes are", () => expect(m.topics[node(m, "ines").cl]!.name).toBe("Kade Social"));
  it("a topic counts its notes and conversations", () => expect(m.topics[node(m, "p-kade").cl]!.n).toBe(3));
});

describe("the edges", () => {
  const m = build();
  const between = (a: string, b: string) => {
    const i = node(m, a).i;
    const j = node(m, b).i;
    return [...m.ea.keys()].filter((k) => (m.ea[k] === i && m.eb[k] === j) || (m.ea[k] === j && m.eb[k] === i));
  };
  it("one edge per pair, and no self-links", () => {
    expect(between("n-brief", "n-kpi")).toHaveLength(1);
    expect(between("n-call", "n-call")).toHaveLength(0);
    expect(m.ea.length).toBe(11); // 14 sent: one pair twice, one pair as link and relation, one self-link
  });
  it("the stronger meaning wins, with its direction, and a file's degree counts the pair once", () => {
    const [e] = between("n-call", "ines");
    expect(m.rels[m.er[e!]!]!.id).toBe("attends");
    expect(m.ea[e!]).toBe(node(m, "ines").i);
    expect(node(m, "n-call").deg).toBe(1);
  });
  it("reads both ways, in the boards' words, and takes a new relation's inverse from the schema", () => {
    const p = relationGroups(m, node(m, "p-kade").i).map((g) => [g.name, g.items.map((i) => m.nodes[i]!.name)]);
    expect(p).toEqual([
      ["involves", ["Ines Vermaat", "Kade Social"]],
      ["its notes", ["Campaign brief", "KPI review"]],
      ["discussed in", ["Checking the KPI review"]],
      ["linked from", ["Weekly review 2026-W40"]],
    ]);
    expect(relationGroups(m, node(m, "kade").i).map((g) => g.name)).toEqual(["employs", "involved in"]);
    expect(relationGroups(m, node(m, "n-call").i).map((g) => g.name)).toEqual(["attended by"]);
    expect(relationGroups(build(fixture(), null), node(m, "n-call").i).map((g) => g.name)).toEqual(["attends (from)"]);
  });
  it("a filter keeps reviews out of a file's relations", () => {
    const keep = (j: number) => m.nodes[j]!.t !== 5;
    expect(relationGroups(m, node(m, "p-kade").i, keep).map((g) => g.name)).not.toContain("linked from");
  });
});

describe("how dark each dot is", () => {
  it("only the best-linked few are dark: the top 4% of notes", () => {
    const m = build(fixture({ extraNotes: 100, extraLinks: 200 }));
    const notes = m.nodes.filter((d) => d.t === 3);
    const dark = notes.filter((d) => d.tone === 0);
    expect(dark.length).toBe(Math.ceil(notes.length * 0.04));
    expect(Math.min(...dark.map((d) => d.deg))).toBeGreaterThanOrEqual(Math.max(...notes.filter((d) => d.tone === 2).map((d) => d.deg)));
  });
});

describe("words", () => {
  it("a file name as an address part", () => {
    expect(slugOf("Contacts/Inès Vermaat.md")).toBe("ines-vermaat");
    expect(slugOf("Notes/C++ & Rust: tips.md")).toBe("c-rust-tips");
  });
  it("the ontology's status words, from what a note says", () => {
    expect(statusWord("on-track")).toBe("on track");
    expect(statusWord("Blocked")).toBe("at risk");
    expect(statusWord("sleeping")).toBe("paused");
    expect(statusWord("done")).toBe("completed");
    expect(statusWord("whatever")).toBeNull();
    expect(statusWord(null)).toBeNull();
  });
  it("how old a file is, in days", () => expect(node(build(), "n-long").days).toBe(40));
  it("the fingerprint changes with the data and only then", () => {
    expect(signature(build())).toBe(signature(build()));
    const f = fixture();
    f.graph.edges.push({ from: "n-arima", to: "n-long" });
    expect(signature(build(f))).not.toBe(signature(build()));
  });
});
