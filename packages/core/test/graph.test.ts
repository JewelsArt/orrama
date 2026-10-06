/** The knowledge graph: typed facts read off notes under the vault's ontology. Fictional fixtures only. */
import { describe, expect, it } from "vitest";
import { ONTOLOGY_TEMPLATE, VaultIndex, buildGraph, parseOntology, type KnowledgeGraph } from "../src/index.js";

import { FILES, f } from "./graph-fixture.js";

const ONT = parseOntology(ONTOLOGY_TEMPLATE);
const build = (files = FILES, opts = {}): KnowledgeGraph => buildGraph(new VaultIndex(files), ONT, opts);
const titleOf = (g: KnowledgeGraph, id: string) => g.entities.get(id)!.title;
const tuples = (g: KnowledgeGraph) => g.facts.map((x) => `${titleOf(g, x.subject)} ${x.relation} ${titleOf(g, x.object)} [${x.via}]`);
const codes = (g: KnowledgeGraph) => g.warnings.map((w) => `${w.code}:${titleOf(g, w.note)}`).sort();

describe("entities", () => {
  const g = build();
  it("typed by the ontology, fields kept as text", () => {
    expect(g.entities.get("n-ada")).toMatchObject({ type: "person", fields: { role: "CEO", company: "[[Acme]]" } });
    expect(g.entities.get("n-acme")).toMatchObject({ type: "company", fields: { location: "Rotterdam" } });
    expect(g.entities.get("n-rocket")?.type).toBe("project");
    expect(g.entities.get("n-plan")?.type).toBe("document");
    expect(g.entities.get("n-c1")?.type).toBe("conversation");
    expect(g.entities.get("n-plan")?.fields["deadline"]).toBe("2026-10-19");
  });
});

describe("status", () => {
  const g = build();
  it("a field wins and is normalised through the vocabulary; tags fill in when there is none", () => {
    expect(g.entities.get("n-rocket")?.status).toBe("on-track");
    expect(g.entities.get("n-sled")?.status).toBe("paused"); // `sleeping` is an alias
    expect(g.entities.get("n-kite")?.status).toBe("on-track"); // two tags, table order: on-track before archived
    expect(g.entities.get("n-lamp")?.status).toBe("archived"); // the field beats a tag that says otherwise
  });
  it("a project whose field and tags disagree, or with none, is flagged", () => {
    expect(codes(g)).toContain("project-status-conflict:Kite");
    expect(codes(g)).toContain("project-without-status:Bare");
    expect(codes(g).filter((c) => c.startsWith("project-status-conflict"))).toEqual(["project-status-conflict:Kite", "project-status-conflict:Lamp"]);
  });
});

describe("facts", () => {
  const g = build();
  const t = tuples(g);
  it("front-matter links, plain text and lists resolve; the provenance says which", () => {
    expect(t).toContain("Ada Quill works_at Acme [field]");
    expect(t).toContain("Bo Marsh works_at Globex [field]");
    expect(g.facts.find((x) => x.subject === "n-bo" && x.relation === "works_at")).toMatchObject({ text: true, where: "company", source: "n-bo" });
    expect(g.facts.find((x) => x.subject === "n-ada" && x.relation === "works_at")?.text).toBeUndefined();
  });
  it("the People section becomes `involves`; a link to a document is a range mismatch, not a fact", () => {
    expect(t).toContain("Rocket involves Ada Quill [section]");
    expect(t).toContain("Rocket involves Globex [section]");
    expect(t.some((x) => x.includes("involves Rocket Plan"))).toBe(false);
    expect(codes(g)).toContain("range-mismatch:Rocket");
  });
  it("inline fields count", () => {
    expect(g.facts.find((x) => x.relation === "supervises")).toMatchObject({ via: "inline", where: "line 7" });
    expect(t).toContain("Di Vale supervises Rocket [inline]");
  });
  it("a project tag makes a note part of the project note carrying it", () => {
    expect(t).toContain("Rocket Plan part_of Rocket [tag]");
    expect(g.facts.find((x) => x.relation === "part_of")?.where).toBe("tag project/rocket");
    expect(codes(g)).toContain("document-orphan:Ghost");
  });
  it("a conversation counts by its front matter; its text adds nothing", () => {
    expect(t).toContain("Planning rocket about Rocket [field]");
    expect(t.filter((x) => x.startsWith("Planning rocket"))).toEqual(["Planning rocket about Rocket [field]"]);
  });
  it("the same fact from two places is one fact", () => {
    expect(g.facts.filter((x) => x.relation === "works_at" && x.subject === "n-ed")).toHaveLength(1);
  });
  it("a field of the same name on the wrong kind of note is not the relation", () => {
    expect(t.some((x) => x.startsWith("Initech works_at"))).toBe(false);
  });
  it("two notes carrying a project's tag: the conventional 04-Projects/<slug>.md is the project, whatever the order", () => {
    for (const files of [FILES, [...FILES].reverse()]) {
      const x = build(files);
      expect(tuples(x)).toContain("Orbit notes part_of Orbit [tag]");
      expect(tuples(x).some((y) => y.startsWith("Orbit notes part_of Orbit copy"))).toBe(false);
    }
  });
});

describe("inverses", () => {
  const t = tuples(build());
  it("every typed fact is visible from the other end", () => {
    expect(t).toContain("Acme employs Ada Quill [inverse]");
    expect(t).toContain("Ada Quill involved_in Rocket [inverse]");
    expect(t).toContain("Rocket has_part Rocket Plan [inverse]");
    expect(t).toContain("Rocket supervised_by Di Vale [inverse]");
    expect(t).toContain("Rocket discussed_in Planning rocket [inverse]");
  });
});

describe("derived relations", () => {
  const g = build();
  const t = tuples(g);
  it("a project involves a company if someone it involves works there — and it says how", () => {
    expect(t).toContain("Rocket involves_company Acme [derived]");
    expect(t).toContain("Acme company_involved_in Rocket [derived]");
    expect(g.facts.find((x) => x.relation === "involves_company")?.chain).toEqual(["n-ada"]);
  });
  it("a company the project involves directly is not derived twice", () => {
    expect(t.filter((x) => x.startsWith("Rocket involves_company Globex"))).toEqual([]); // Globex only by direct link, no one there is linked
  });
});

describe("warnings", () => {
  const w = codes(build());
  it("a person with no company, or one that is not a note", () => {
    expect(w).toContain("person-without-company:Di Vale");
    expect(w).toContain("person-without-company:Cy Nord");
    expect(w).toContain("unresolved-object:Cy Nord");
    expect(w).not.toContain("person-without-company:Ada Quill");
  });
  it("a conversation about nothing", () => {
    expect(w).toContain("conversation-without-about:Chat");
    expect(w).not.toContain("conversation-without-about:Planning rocket");
  });
  it("only rules the ontology lists are checked", () => {
    const quiet = buildGraph(new VaultIndex(FILES), { ...ONT, rules: ONT.rules.filter((r) => r.id !== "person-without-company") });
    expect(quiet.warnings.some((x) => x.code === "person-without-company")).toBe(false);
  });
});

describe("access", () => {
  it("what the caller cannot read is neither subject nor object — and nothing says it exists", () => {
    const g = build(FILES, { readable: (n: { path: string }) => !n.path.includes("Acme") });
    expect(g.entities.has("n-acme")).toBe(false);
    expect(tuples(g).some((x) => x.includes("Acme"))).toBe(false);
    expect(g.facts.some((x) => x.relation === "involves_company")).toBe(false);
    expect(codes(g)).toContain("unresolved-object:Ada Quill"); // indistinguishable from a note that is not there
  });
});

describe("no ontology", () => {
  it("nothing is typed and there are no facts", () => {
    const g = buildGraph(new VaultIndex(FILES), parseOntology(""));
    expect(g.facts).toEqual([]);
    expect([...g.entities.values()].every((e) => e.type === "note")).toBe(true);
  });
});
