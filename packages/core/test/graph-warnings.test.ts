/** A warning carries what its fix needs as data, so Orr noticed can offer the fix (R11). Fictional fixtures only. */
import { describe, expect, it } from "vitest";
import { ONTOLOGY_TEMPLATE, VaultIndex, buildGraph, parseOntology } from "../src/index.js";

import { FILES, f } from "./graph-fixture.js";

const ONT = parseOntology(ONTOLOGY_TEMPLATE);
const fm = (id: string, front: string, body: string) => `---\nid: n-${id}\n${front}\n---\n${body}\n`;

describe("warning details", () => {
  const files = [
    ...FILES,
    f("Notes/Orphan.md", fm("orph", "tags: [project/ghost]", "# Orphan")),
    f("01-Me/Contacts/Eve Ray.md", fm("eve", "tags: [contact]\ncompany: \"[[Rocket]]\"", "# Eve")),
  ];
  const g = buildGraph(new VaultIndex(files), ONT);
  const of = (code: string, note: string) => g.warnings.find((w) => w.code === code && w.note === note);

  it("a name that is not a note: the relation and the name as written", () => {
    expect(of("unresolved-object", "n-cy")?.detail).toEqual({ relation: "works_at", target: "Initech Ltd" });
  });
  it("a note of the wrong kind: the relation, the note and its kind", () => {
    expect(of("range-mismatch", "n-eve")?.detail).toEqual({ relation: "works_at", object: "n-rocket", found: "project" });
  });
  it("a project's status field and tags, as the vocabulary reads them", () => {
    expect(of("project-status-conflict", "n-lamp")?.detail).toEqual({ field: "archived", tags: ["on-track"] });
    expect(of("project-status-conflict", "n-kite")?.detail).toEqual({ tags: ["on-track", "archived"] });
  });
  it("the tag naming a project no note carries", () => {
    expect(of("document-orphan", "n-orph")?.detail).toEqual({ tag: "project/ghost" });
  });
  it("warnings with nothing to fix by data carry no detail", () => {
    expect(of("person-without-company", "n-cy")?.detail).toBeUndefined();
    expect(of("project-without-status", "n-bare")?.detail).toBeUndefined();
  });
});
