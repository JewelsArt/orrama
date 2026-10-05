/**
 * A saved chat is a note of its own kind. Jules's vault held 550 Claude
 * session dumps — 87% of its notes — whose text quoted file paths as
 * [[links]] (328, nearly all unresolved), spreadsheet errors and colours as
 * #tags (233), so the map and the tag list were mostly transcript noise.
 * A note with `type: claude-session` (or `type: conversation`) stays indexed,
 * searchable and linkable, but its text adds no links, tags or tasks.
 */
import { describe, expect, it } from "vitest";
import { parseNote } from "../src/index.js";

const chat = (type: string) => `---
id: n-chat
title: Fix the watcher
type: ${type}
tags: [claude-session, basalt]
---
# Fix the watcher

**Jules:** look at [[apps/server/src/vaultStore.ts]] and [the note](Plan.md) — #REF! #DIV/0! #d93025 #idea
- [ ] a checkbox Claude quoted
## Outcome
`;

describe("conversation notes", () => {
  for (const type of ["claude-session", "conversation"]) {
    it(`type: ${type} — headings and front-matter tags count, the text's links, tags and tasks do not`, () => {
      const n = parseNote(chat(type), "x");
      expect(n.kind).toBe("conversation");
      expect(n.links).toEqual([]);
      expect(n.tasks).toEqual([]);
      expect(n.tags.map((t) => t.tag)).toEqual(["claude-session", "basalt"]);
      expect(n.headings.map((h) => h.text)).toEqual(["Fix the watcher", "Outcome"]);
      expect(n.title).toBe("Fix the watcher");
    });
  }

  it("any other note is read in full", () => {
    const n = parseNote(chat("meeting"), "x");
    expect(n.kind).toBe("note");
    expect(n.links.map((l) => l.target)).toEqual(["apps/server/src/vaultStore.ts", "Plan"]);
    expect(n.tags.filter((t) => t.line > 0).map((t) => t.tag)).toEqual(["ref", "div/0", "idea"]);
    expect(n.tasks).toHaveLength(1);
  });
});
