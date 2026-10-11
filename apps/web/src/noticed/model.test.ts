import { describe, expect, it } from "vitest";
import { firstOf, itemsOf, statusWord, typeCount, type Part, type Warning } from "./model.js";

const note = (title: string, type = "person") => ({ id: `n-${title.toLowerCase().replace(/\W+/g, "-")}`, title, path: `Contacts/${title}.md`, type });
const w = (code: string, n: ReturnType<typeof note>, extra: Partial<Warning> = {}): Warning => ({ code, message: `${n.title}: ${code}`, note: n, ...extra });
/** A sentence as text, names in [brackets]. */
const said = (parts: Part[]) => parts.map((p) => (typeof p === "string" ? p : `[${p.name}]`)).join("");

describe("Orr noticed's sentences", () => {
  const pieter = note("Pieter Bakker");
  it("a company with no note is one problem, said once, with Create the note", () => {
    const items = itemsOf([w("unresolved-object", pieter, { relation: "works_at", target: "Bakker & Zn" }), w("person-without-company", pieter)]);
    expect(items).toHaveLength(1);
    expect(said(items[0]!.parts)).toBe("[Pieter Bakker] works at Bakker & Zn, which has no note.");
    expect(items[0]!.fixes).toEqual([{ kind: "create-company", label: "Create the note", name: "Bakker & Zn" }]);
  });

  it("a person with no company at all opens the note to add one", () => {
    const [it0] = itemsOf([w("person-without-company", note("Yara Haddad"))]);
    expect(said(it0!.parts)).toBe("[Yara Haddad] has no company.");
    expect(it0!.fixes[0]!.kind).toBe("open");
  });

  it("any other name that is not a note is said with its relation, and opened by hand", () => {
    const [it0] = itemsOf([w("unresolved-object", note("Chat", "conversation"), { relation: "about", target: "Old plan" })]);
    expect(said(it0!.parts)).toBe("[Chat] is about Old plan, which has no note.");
    expect(it0!.fixes.map((f) => f.kind)).toEqual(["open"]);
  });

  it("a status tag against the field: Use the tag's word writes it; the field's needs the note", () => {
    const [it0] = itemsOf([w("project-status-conflict", note("Move to Oost", "project"), { field: "at-risk", tags: ["paused"] })]);
    expect(said(it0!.parts)).toBe("[Move to Oost] is tagged paused but its status says at risk.");
    expect(it0!.fixes).toEqual([
      { kind: "status", label: "Use paused", value: "paused" },
      { kind: "open", label: "Open the note" },
    ]);
  });

  it("two status tags and no field: nothing one write can settle", () => {
    const [it0] = itemsOf([w("project-status-conflict", note("Kite", "project"), { tags: ["on-track", "archived"] })]);
    expect(said(it0!.parts)).toBe("[Kite] is tagged both on track and archived.");
    expect(it0!.fixes.map((f) => f.kind)).toEqual(["open"]);
  });

  it("a project with no status offers the seven words", () => {
    const [it0] = itemsOf([w("project-without-status", note("Inbox agent", "project"))]);
    expect(said(it0!.parts)).toBe("[Inbox agent] has no status.");
    expect(it0!.fixes[0]!.kind).toBe("pick-status");
  });

  it("a relation to the wrong kind of note names that note too", () => {
    const [it0] = itemsOf([w("range-mismatch", note("Eve Ray"), { relation: "works_at", object: { id: "n-oost", title: "Move to Oost", type: "project" }, found: "project" })]);
    expect(said(it0!.parts)).toBe("[Eve Ray] works at [Move to Oost], which is a project.");
  });

  it("a tag naming a project with no note offers to create the project", () => {
    const [it0] = itemsOf([w("document-orphan", note("Old pitch", "document"), { tag: "project/pitch-deck" })]);
    expect(said(it0!.parts)).toBe("[Old pitch] is tagged project/pitch-deck, but there's no project note for it.");
    expect(it0!.fixes).toEqual([{ kind: "create-project", label: "Create the project", slug: "pitch-deck" }]);
  });

  it("a conversation about nothing", () => {
    expect(said(itemsOf([w("conversation-without-about", note("Chat", "conversation"))])[0]!.parts)).toBe("[Chat] isn't about anything yet.");
  });

  it("keeps the server's order, and Today names the first and counts the rest", () => {
    const items = itemsOf([w("person-without-company", note("B")), w("person-without-company", note("A"))]);
    expect(items.map((i) => i.note.title)).toEqual(["B", "A"]);
    expect(firstOf(items)).toMatchObject({ item: { note: { title: "B" } }, more: 1 });
    expect(firstOf([])).toBeNull();
  });
});

describe("words", () => {
  it("status ids and type counts read as words", () => {
    expect(statusWord("on-track")).toBe("on track");
    expect(typeCount("person", 20)).toBe("20 people");
    expect(typeCount("company", 1)).toBe("1 company");
    expect(typeCount("note", 13)).toBe("13 other notes");
  });
});
