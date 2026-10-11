import { describe, expect, it } from "vitest";
import { parseNote, titleFromPath, parseFrontmatter, updateFrontmatter, stripInlineMarkdown } from "../src/index.js";

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

/**
 * A front-matter tag becomes a directory name in routes/projects.ts, and unlike
 * an inline tag it never passes TAG_RE. A tag carrying `..` segments is dropped
 * rather than indexed, so the string cannot reach path.join at all.
 */
describe("front-matter tags that read as path escapes", () => {
  const withTags = (tags: string) => `---\ntags: [${tags}]\n---\n\n# Note\n`;
  const tagsOf = (md: string) => parseNote(md, "Note").tags.map((t) => t.tag);

  it("drops a traversal tag", () => {
    expect(tagsOf(withTags('"project/../../../../apps/web/dist"'))).toEqual([]);
  });

  it("drops single-dot and trailing-dot segments, and backslashes", () => {
    expect(tagsOf(withTags('"project/./x"'))).toEqual([]);
    expect(tagsOf(withTags('"project/.."'))).toEqual([]);
    expect(tagsOf(withTags('"..\\\\evil"'))).toEqual([]);
  });

  it("keeps every ordinary tag, including the ACL ones", () => {
    // Dropping an #only/<team> tag would not fail closed — it would widen who
    // can read the note — so the filter must be narrow enough to never do it.
    expect(tagsOf(withTags('"only/finance", "share/eng", "project/atlas", "contact"'))).toEqual([
      "only/finance",
      "share/eng",
      "project/atlas",
      "contact",
    ]);
  });

  it("drops a dotted tag like the inline grammar does — except an only/ one", () => {
    // `#v1.2-release` inline has always been the tag `v1`; the front-matter
    // form is now held to the same grammar (tag-grammar.test.ts). A dotted
    // only/ tag still stays: dropping it would widen who can read the note.
    expect(tagsOf(withTags('"v1.2-release"'))).toEqual([]);
    expect(tagsOf(withTags('"only/fin.ance"'))).toEqual(["only/fin.ance"]);
  });
});

describe("task titles are plain text", () => {
  it("drops inline Markdown from the title and keeps the source line in raw", () => {
    const raw = "- [ ] **Does the Paris office sell?** Ask ==Sam== about `pipeline` in [[thesis|the thesis]] @jules !p1 due:2026-10-02";
    const [t] = parseNote(raw).tasks;
    expect(t).toMatchObject({
      text: "Does the Paris office sell? Ask Sam about pipeline in the thesis",
      assignee: "jules",
      priority: 1,
      due: "2026-10-02",
      raw,
    });
  });

  it("unwraps each kind of inline markup", () => {
    expect(stripInlineMarkdown("__bold__ *em* _em_ ~~gone~~")).toBe("bold em em gone");
    expect(stripInlineMarkdown("see [[Atlas Roadmap]] and [the docs](https://x.y/z)")).toBe("see Atlas Roadmap and the docs");
  });

  it("leaves text that only looks like markup alone", () => {
    expect(stripInlineMarkdown("rename snake_case_name in file_v2_final.pdf")).toBe("rename snake_case_name in file_v2_final.pdf");
    expect(stripInlineMarkdown("2 * 3 * 4 = 24")).toBe("2 * 3 * 4 = 24");
    expect(stripInlineMarkdown("an unclosed **bold")).toBe("an unclosed **bold");
  });
});

describe("key deadlines", () => {
  it("flags a #deadline task, keeps the tag indexed, and leaves it out of the title", () => {
    const n = parseNote("- [ ] Submit Research Plan on OnStage, 09:00 #deadline @jules !p1 due:2026-10-19");
    expect(n.tasks[0]).toMatchObject({ key: true, text: "Submit Research Plan on OnStage, 09:00", due: "2026-10-19" });
    expect(n.tags.map((t) => t.tag)).toContain("deadline");
  });

  it("does not flag near-misses", () => {
    for (const line of ["- [ ] plan #deadlines", "- [ ] plan #deadline/soft", "- [ ] plan a#deadline", "- [ ] plan"]) {
      expect(parseNote(line).tasks[0]!.key).toBeUndefined();
    }
  });
});
