import { describe, expect, it } from "vitest";
import { parseNote, titleFromPath, parseFrontmatter, updateFrontmatter } from "../src/index.js";

describe("frontmatter", () => {
  it("parses yaml frontmatter and body start", () => {
    const fm = parseFrontmatter("---\nid: n-1\ntitle: Hello\ntags: [a, b]\n---\nbody");
    expect(fm.data).toEqual({ id: "n-1", title: "Hello", tags: ["a", "b"] });
    expect(fm.bodyStart).toBe(5);
  });

  it("treats missing/malformed frontmatter as empty", () => {
    expect(parseFrontmatter("just text").data).toEqual({});
    expect(parseFrontmatter("---\n: : :\n---\nbody").data).toEqual({});
  });

  it("updates frontmatter preserving body", () => {
    const out = updateFrontmatter("---\nid: n-1\n---\nbody line\n", (d) => ({ ...d, x: 1 }));
    expect(out).toContain("id: n-1");
    expect(out).toContain("x: 1");
    expect(out.endsWith("body line\n")).toBe(true);
  });
});

describe("parseNote", () => {
  const md = `---
id: n-abc
title: Atlas Kickoff
aliases: [Kickoff]
tags: [project/atlas]
---
# Plan

Linking [[Roadmap 2026]] and [[Client Notes#Acme|the client]] here. #meeting #only/engineering

- [ ] draft spec @jules due:2026-07-10 !p1
- [x] book room @sam
  - [ ] nested subtask
- [ ] promoted one ^t-x1y2z3

\`\`\`
- [ ] not a task, inside code fence
#not-a-tag [[Not A Link]]
\`\`\`

Inline \`#code-tag\` must not count. #share/marketing
`;

  const note = parseNote(md, "fallback");

  it("reads id/title/aliases/frontmatter tags", () => {
    expect(note.id).toBe("n-abc");
    expect(note.title).toBe("Atlas Kickoff");
    expect(note.aliases).toEqual(["Kickoff"]);
    expect(note.tags.some((t) => t.tag === "project/atlas" && t.line === 0)).toBe(true);
  });

  it("extracts wiki links with heading and alias", () => {
    expect(note.links.map((l) => l.target)).toEqual(["Roadmap 2026", "Client Notes"]);
    expect(note.links[1]).toMatchObject({ heading: "Acme", alias: "the client" });
  });

  it("extracts inline tags but not headings, code fences, or inline code", () => {
    const tags = note.tags.map((t) => t.tag);
    expect(tags).toContain("meeting");
    expect(tags).not.toContain("not-a-tag");
    expect(tags).not.toContain("code-tag");
    expect(tags).not.toContain("plan");
  });

  it("extracts security namespaces", () => {
    expect(note.onlyTeams).toEqual(["engineering"]);
    expect(note.shareTeams).toEqual(["marketing"]);
  });

  it("extracts tasks with metadata, nesting, block ids — and skips code fences", () => {
    expect(note.tasks).toHaveLength(4);
    const [t1, t2, t3, t4] = note.tasks;
    expect(t1).toMatchObject({ checked: false, assignee: "jules", due: "2026-07-10", priority: 1, text: "draft spec" });
    expect(t2).toMatchObject({ checked: true, assignee: "sam" });
    expect(t3).toMatchObject({ indent: 2, text: "nested subtask" });
    expect(t4).toMatchObject({ blockId: "t-x1y2z3", text: "promoted one" });
  });

  it("collects headings", () => {
    expect(note.headings).toEqual([{ level: 1, text: "Plan", line: 6 }]);
  });

  it("falls back to filename title", () => {
    expect(parseNote("no fm", "My File").title).toBe("My File");
    expect(titleFromPath("Team/Roadmap 2026.md")).toBe("Roadmap 2026");
  });
});
