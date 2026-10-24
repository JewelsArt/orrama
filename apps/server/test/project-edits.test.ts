/** The project page's line and tag edits as text (projectEdits.ts, 1E): every other byte stays. */
import { describe, expect, it } from "vitest";
import { changeLine, lineToStep, removeLine, withoutProjectTag, withProjectTag } from "../src/projectEdits.js";

describe("line edits", () => {
  const note = "# P\r\n\r\n## Inbox\r\n- one\r\nprose line\r\n- [x] done thing\r\n\r\n## Tasks\r\n- [ ] a\r\n";

  it("change keeps a CRLF note's endings, a prose line as prose and a checkbox as it was", () => {
    const a = changeLine(note, "Inbox", 1, "prose line", "better prose");
    expect(a.ok && a.content).toBe(note.replace("prose line", "better prose"));
    const b = changeLine(note, "Inbox", 2, "done thing", "  spaced   out ");
    expect(b.ok && b.content).toBe(note.replace("- [x] done thing", "- [x] spaced out"));
  });

  it("names a line by place and words: either wrong is a refusal", () => {
    expect(changeLine(note, "Inbox", 0, "two", "x").ok).toBe(false);
    expect(changeLine(note, "Inbox", 5, "one", "x").ok).toBe(false);
    expect(removeLine(note, "Inbox", -1, "one").ok).toBe(false);
    expect(removeLine(note, "Nope", 0, "one").ok).toBe(false);
  });

  it("make it a step appends under ## Tasks, creating it when the note has none", () => {
    const a = lineToStep(note, "Inbox", 0, "one");
    expect(a.ok && a.content).toBe("# P\r\n\r\n## Inbox\r\nprose line\r\n- [x] done thing\r\n\r\n## Tasks\r\n- [ ] a\r\n- [ ] one\r\n");
    const b = lineToStep("# P\n\n## Inbox\n- call Ana\n", "Inbox", 0, "call Ana");
    expect(b.ok && b.content).toBe("# P\n\n## Inbox\n\n## Tasks\n\n- [ ] call Ana\n");
  });
});

describe("tag edits", () => {
  it("a string of tags is read and written as a list; other project tags go, the plain project tag stays", () => {
    expect(withProjectTag("---\ntags: project, project/old, idea\n---\nx\n", "new")).toBe("---\ntags:\n  - project\n  - idea\n  - project/new\n---\nx\n");
    expect(withProjectTag("---\ntag: \"#seed\"\n---\nx\n", "new")).toBe("---\ntag:\n  - seed\n  - project/new\n---\nx\n");
  });

  it("taking the last tag off drops the key", () => {
    expect(withoutProjectTag("---\ntitle: T\ntags: [project/a]\n---\nx\n", "a")).toBe("---\ntitle: T\n---\nx\n");
  });

  it("properties that can't be read are refused, never half-written", () => {
    expect(withProjectTag("---\ntitle: [oops\n---\nx\n", "a")).toBeNull();
    expect(withoutProjectTag("---\ntags: [project/a]\ntitle: [oops\n---\nx\n", "a")).toBeNull();
  });
});
