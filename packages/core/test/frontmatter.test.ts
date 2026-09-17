/**
 * Front matter that does not parse must never be rewritten.
 *
 * The bug this pins: parseFrontmatter caught the YAML error, returned an empty
 * `data`, and still reported a bodyStart past the closing fence. Anything that
 * rebuilt the note from that empty object wrote a file with no metadata at all —
 * in place, in the folder Obsidian has open. A single unquoted colon was enough.
 */
import { describe, expect, it } from "vitest";
import { parseFrontmatter, updateFrontmatter, withFrontmatter } from "../src/frontmatter.js";

const BAD = `---
title: Q3 Review: Ops
tags: [only/finance, quarterly]
deadline: 2026-09-30
---

# Q3 Review

Body text.
`;

const GOOD = `---
title: Ordinary note
tags: [notes]
---

Body.
`;

describe("malformed front matter", () => {
  it("is reported, not silently read as empty", () => {
    const r = parseFrontmatter(BAD);
    expect(r.malformed).toBe(true);
    expect(r.data).toEqual({});
    // The raw text is still there — that is what makes recovery possible.
    expect(r.raw).toContain("Q3 Review: Ops");
  });

  it("is distinguishable from a note that simply has none", () => {
    const none = parseFrontmatter("# Just a heading\n");
    expect(none.malformed).toBe(false);
    expect(none.data).toEqual({});
    // Both have empty data; only the flag separates them.
    expect(parseFrontmatter(BAD).data).toEqual(none.data);
  });

  it("survives updateFrontmatter byte for byte", () => {
    const out = updateFrontmatter(BAD, (d) => ({ id: "n-newid", ...d }));
    expect(out).toBe(BAD);
    // The things that would have been destroyed are all still on disk.
    expect(out).toContain("tags: [only/finance, quarterly]");
    expect(out).toContain("deadline: 2026-09-30");
    expect(out).toContain("Q3 Review: Ops");
  });

  it("does not block updates to notes whose front matter is fine", () => {
    const out = updateFrontmatter(GOOD, (d) => ({ id: "n-newid", ...d }));
    expect(out).not.toBe(GOOD);
    expect(out).toContain("id: n-newid");
    expect(out).toContain("title: Ordinary note");
    expect(out).toContain("Body.");
  });

  it("keeps the access restriction that a rewrite would have dropped", () => {
    // #only/<team> lives in tags. Losing it does not fail closed, it fails OPEN:
    // the note becomes readable by everyone the folder grants reach.
    const before = parseFrontmatter(BAD).raw;
    const after = updateFrontmatter(BAD, () => ({}));
    expect(after).toContain("only/finance");
    expect(parseFrontmatter(after).raw).toBe(before);
  });

  it("round-trips a well-formed note through withFrontmatter", () => {
    const { data, bodyStart } = parseFrontmatter(GOOD);
    const body = GOOD.split("\n").slice(bodyStart).join("\n");
    expect(withFrontmatter(data, body)).toContain("title: Ordinary note");
  });
});
