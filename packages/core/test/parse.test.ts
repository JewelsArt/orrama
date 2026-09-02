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

  it("parses start: alongside due: and strips both from the text", () => {
    const n = parseNote("- [ ] ship gantt start:2026-07-06 due:2026-07-10 @jules\n");
    expect(n.tasks[0]).toMatchObject({ start: "2026-07-06", due: "2026-07-10", assignee: "jules", text: "ship gantt" });
  });

  it("collects headings", () => {
    expect(note.headings).toEqual([{ level: 1, text: "Plan", line: 6 }]);
  });

  it("falls back to filename title", () => {
    expect(parseNote("no fm", "My File").title).toBe("My File");
    expect(titleFromPath("Team/Roadmap 2026.md")).toBe("Roadmap 2026");
  });
});

describe("links Obsidian counts too", () => {
  it("reads markdown-style links to notes, skipping externals and attachments", () => {
    const note = parseNote(
      [
        "# N",
        "",
        "See [the plan](04-Projects/thesis.md) and [notes](./Home.md).",
        "An [external](https://example.com/x.md) and an ![image](img/shot.png).",
        "Encoded: [guide](AMSIB%20Thesis%20Guide.md#deadlines)",
        "",
        "```",
        "[fenced](should-not-count.md)",
        "```",
      ].join("\n"),
    );
    const targets = note.links.map((l) => l.target);
    expect(targets).toContain("04-Projects/thesis");
    expect(targets).toContain("Home");
    expect(targets).toContain("AMSIB Thesis Guide");
    expect(targets).not.toContain("should-not-count");
    expect(targets.some((t) => t.includes("example.com"))).toBe(false);
    expect(targets.some((t) => t.includes("shot"))).toBe(false);
    expect(note.links.find((l) => l.target === "AMSIB Thesis Guide")?.heading).toBe("deadlines");
  });
});
