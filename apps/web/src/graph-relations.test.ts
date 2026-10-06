/** The map's typed edges: the words they put in the readout, and the switch that takes them away. */
import { describe, expect, it } from "vitest";
import { edgesFor, relationLabel, relationsAt, type MapEdge } from "./graphRelations.js";

const T: Record<string, string> = { ada: "Ada Quill", acme: "Acme", hush: "Hush", bo: "Bo Marsh", p: "Plan" };
const titleOf = (id: string) => T[id];
const EDGES: MapEdge[] = [
  { from: "ada", to: "acme", relation: "works_at" },
  { from: "bo", to: "acme", relation: "works_at" },
  { from: "hush", to: "ada", relation: "involves" },
  { from: "p", to: "hush", relation: "part_of", implied: true },
  { from: "ada", to: "bo" }, // a plain link
];

describe("relationLabel", () => {
  it("reads as words", () => expect(relationLabel("part_of")).toBe("part of"));
});

describe("relationsAt", () => {
  it("lists a node's typed edges with their direction, sorted, and skips plain links", () => {
    expect(relationsAt(EDGES, "ada", titleOf).lines).toEqual([
      { dir: "in", label: "involves", title: "Hush" },
      { dir: "out", label: "works at", title: "Acme" },
    ]);
  });
  it("the object end sees the same edge from its side", () => {
    expect(relationsAt(EDGES, "acme", titleOf).lines.map((l) => `${l.dir} ${l.label} ${l.title}`)).toEqual(["in works at Ada Quill", "in works at Bo Marsh"]);
  });
  it("cuts at a limit and says how many it left out", () => {
    const r = relationsAt(EDGES, "acme", titleOf, 1);
    expect(r.lines).toHaveLength(1);
    expect(r.more).toBe(1);
  });
  it("an edge to a note the map does not know is not listed", () => {
    expect(relationsAt([{ from: "ada", to: "ghost", relation: "works_at" }], "ada", titleOf)).toEqual({ lines: [], more: 0 });
  });
  it("a note with no typed edges has none", () => expect(relationsAt(EDGES, "bo", titleOf).lines.map((l) => l.label)).toEqual(["works at"]));
});

describe("edgesFor", () => {
  it("on: everything, names and implied edges included", () => expect(edgesFor(EDGES, true)).toEqual(EDGES));
  it("off: the plain links as they were — implied edges gone, names dropped", () => {
    const off = edgesFor(EDGES, false);
    expect(off).toHaveLength(4);
    expect(off.every((e) => e.relation === undefined && e.implied === undefined)).toBe(true);
    expect(off.some((e) => e.from === "p")).toBe(false);
  });
});
