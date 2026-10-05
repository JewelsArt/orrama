/** The ontology as vault data: four tables in a `#vault-ontology` note. */
import { describe, expect, it } from "vitest";
import { ONTOLOGY_TEMPLATE, parseOntology, typeOfNote } from "../src/index.js";

const note = (path: string, tags: string[] = [], frontmatter: Record<string, unknown> = {}, kind: "note" | "conversation" = "note") => ({
  path,
  folder: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "",
  tags: tags.map((tag) => ({ tag })),
  frontmatter,
  kind,
});

describe("parseOntology", () => {
  const o = parseOntology(ONTOLOGY_TEMPLATE);

  it("reads the four tables", () => {
    expect(o.types.map((t) => t.id)).toEqual(["person", "company", "project", "document", "area", "conversation"]);
    expect(o.relations.map((r) => r.id)).toEqual(["works_at", "involves", "part_of", "about", "supervises"]);
    expect(o.statuses.map((s) => s.id)).toContain("paused");
    expect(o.rules.filter((r) => r.kind === "derive").map((r) => r.id)).toEqual(["involves_company"]);
  });

  it("reads a relation's columns, lists and sources", () => {
    expect(o.relations.find((r) => r.id === "about")).toMatchObject({
      domain: ["conversation"],
      range: ["project", "area", "company", "person"],
      inverse: "discussed_in",
      fields: ["about", "project"],
    });
    expect(o.relations.find((r) => r.id === "part_of")?.also).toEqual(["tag:project/*"]);
    expect(o.statuses.find((s) => s.id === "paused")?.aliases).toEqual(["sleeping", "on hold"]);
  });

  it("splits a Matches cell into OR of AND-groups", () => {
    expect(o.types.find((t) => t.id === "project")?.matches).toEqual([["folder:04-Projects", "tag:project/*"]]);
    expect(o.types.find((t) => t.id === "person")?.matches).toEqual([["tag:contact"], ["folder:01-Me/Contacts"]]);
  });

  it("skips half-filled rows, unknown kinds and tables it does not know", () => {
    const bad = parseOntology(`| Type | Matches | Description |
| --- | --- | --- |
| | tag:x | no name |
| Note | tag:y | the fallback is implicit |
| ok | tag:z | fine |

| Rule | Kind | Meaning |
| --- | --- | --- |
| r1 | shout | unknown kind |

| Category | Matches |
| --- | --- |
| School | amsib |`);
    expect(bad.types.map((t) => t.id)).toEqual(["ok"]);
    expect(bad.rules).toEqual([]);
  });

  it("no ontology note, nothing typed", () => {
    expect(parseOntology("# just prose").types).toEqual([]);
  });
});

describe("typeOfNote", () => {
  const o = parseOntology(ONTOLOGY_TEMPLATE);
  it("the first matching row wins; AND needs both halves", () => {
    expect(typeOfNote(note("04-Projects/atlas.md", ["project/atlas"]), o)).toBe("project");
    expect(typeOfNote(note("04-Projects/atlas/plan.md", ["project/atlas"]), o)).toBe("document");
    expect(typeOfNote(note("04-Projects/deadlines.md", ["active"]), o)).toBe("note");
  });
  it("a tag condition matches the hierarchy, a folder condition its own folder", () => {
    expect(typeOfNote(note("Somewhere/Ada.md", ["contact"]), o)).toBe("person");
    expect(typeOfNote(note("01-Me/Contacts/Bo.md"), o)).toBe("person");
    expect(typeOfNote(note("02-Areas/work.md"), o)).toBe("area");
    expect(typeOfNote(note("02-Areas/deep/x.md"), o)).toBe("note"); // folder: without /* is exact
  });
  it("tag:x matches the whole family x/…, tag:x/* only what is below it", () => {
    const fam = parseOntology("| Type | Matches |\n| --- | --- |\n| a | tag:project |\n| b | tag:team/* |");
    expect(typeOfNote(note("x.md", ["project/atlas"]), fam)).toBe("a");
    expect(typeOfNote(note("x.md", ["team"]), fam)).toBe("note");
    expect(typeOfNote(note("x.md", ["team/red"]), fam)).toBe("b");
  });
  it("a note's own type: wins when it names a type, is ignored when it does not", () => {
    expect(typeOfNote(note("misc/x.md", [], { type: "Company" }), o)).toBe("company");
    expect(typeOfNote(note("misc/y.md", ["contact"], { type: "gizmo" }), o)).toBe("person");
  });
  it("kind: conversation", () => {
    expect(typeOfNote(note("s/1.md", [], { type: "claude-session" }, "conversation"), o)).toBe("conversation");
  });
});
