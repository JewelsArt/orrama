/**
 * Rewriting front matter must keep what the user wrote around the keys it
 * touches. Every note gets `id:` stamped on first index, so re-serialising the
 * data (the old way) stripped every `# comment` from every note in the vault
 * the first time Basalt saw it.
 */
import { describe, expect, it } from "vitest";
import { updateFrontmatter } from "../src/index.js";

const NOTE = `---
# Kept for the thesis defence — do not rename
title: "Q3 Review: Ops"   # quoted on purpose
tags: [project/thesis, school]

deadline: 2026-10-19
---
# Body
text`;

describe("updateFrontmatter keeps the user's YAML", () => {
  it("stamps an id first without losing comments, quotes or blank lines", () => {
    // Only inline spacing is normalised (`   #` → ` #`, `[a, b]` → `[ a, b ]`).
    expect(updateFrontmatter(NOTE, (d) => ({ id: "n-abc", ...d }))).toBe(`---
id: n-abc
# Kept for the thesis defence — do not rename
title: "Q3 Review: Ops" # quoted on purpose
tags: [ project/thesis, school ]

deadline: 2026-10-19
---
# Body
text`);
  });

  it("changes one value and removes another, leaving the rest alone", () => {
    const out = updateFrontmatter(NOTE, (d) => {
      const { deadline: _drop, ...rest } = d;
      return { ...rest, status: "sleeping" };
    });
    expect(out).toContain("# Kept for the thesis defence — do not rename");
    expect(out).toContain('title: "Q3 Review: Ops"');
    expect(out).not.toContain("deadline:");
    expect(out).toMatch(/^status: sleeping$/m);
    expect(out.endsWith("---\n# Body\ntext")).toBe(true);
  });

  it("an update that changes nothing gives back the same text", () => {
    expect(updateFrontmatter(NOTE, (d) => d)).toBe(NOTE);
  });

  it("still creates front matter where there was none, and never rewrites malformed YAML", () => {
    expect(updateFrontmatter("just a body", () => ({ id: "n-1" }))).toBe("---\nid: n-1\n---\njust a body");
    const bad = "---\ntitle: Q3 Review: Ops\n---\nbody";
    expect(updateFrontmatter(bad, (d) => ({ id: "n-1", ...d }))).toBe(bad);
  });
});
