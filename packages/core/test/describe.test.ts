/** The one-line gist of a note — extractive, no model. */
import { describe, expect, it } from "vitest";
import { VaultIndex, buildGraph, describeNote, parseNote, parseOntology, ONTOLOGY_TEMPLATE } from "../src/index.js";

const of = (content: string) => {
  const p = parseNote(content, "x");
  return describeNote({ frontmatter: p.frontmatter, content, kind: p.kind });
};

describe("describeNote", () => {
  it("the author's own description or summary wins", () => {
    expect(of("---\ndescription: Hand-written gist\n---\n# T\n\nBody text.")).toBe("Hand-written gist");
    expect(of("---\nsummary: From summary\n---\nBody.")).toBe("From summary");
  });
  it("else the first real sentence: not headings, quotes, tables, fences, rules or list markers", () => {
    expect(of("# Title\n\n> a quote\n| a | b |\n```\ncode\n```\n---\n- [ ] **Do** the [[Thing|thing]] now\n")).toBe("Do the thing now");
  });
  it("a note with nothing readable has no description", () => {
    expect(of("# Only a heading\n")).toBe("");
  });
  it("long text is cut with an ellipsis, not mid-air", () => {
    const d = of("word ".repeat(100));
    expect(d.length).toBeLessThanOrEqual(220);
    expect(d.endsWith("…")).toBe(true);
  });
  it("a conversation's gist is Jules's opening message, whole turn, not its header lines", () => {
    const chat = "---\ntype: claude-session\n---\n# pasted_content id1 Fix the thing\n\n**Date:** 2026-09-30 14:50  \n**Session:** `abc`  \n**Working dir:** `/x`  \n\n**Jules:** Please fix the\nwatcher so new folders show up.\n\n**Claude:** On it.\n";
    expect(of(chat)).toBe("Please fix the watcher so new folders show up.");
  });
  it("a conversation with no Jules turn still skips its header lines", () => {
    expect(of("---\ntype: claude-session\n---\n**Date:** 2026-09-30  \n**Session:** `a`  \n\n**Claude:** Hello there.\n")).toBe("Hello there.");
  });
  it("a conversation's own description beats the opening message", () => {
    expect(of("---\ntype: claude-session\ndescription: Set up phone access over Tailscale\n---\n**Jules:** hi")).toBe("Set up phone access over Tailscale");
  });
  it("the graph carries it on every entity", () => {
    const g = buildGraph(new VaultIndex([{ path: "a.md", content: "---\nid: n-a\n---\nHello world." }]), parseOntology(ONTOLOGY_TEMPLATE));
    expect(g.entities.get("n-a")?.summary).toBe("Hello world.");
  });
});
