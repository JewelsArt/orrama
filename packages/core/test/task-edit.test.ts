/**
 * Stage 1, 1B: a step is changed from its card, and each change is the line a person would have
 * typed — one token set, cleared or replaced where it stands, every other byte of the note kept
 * (CRLF too), the block id last. Moving a step is removeTaskLine + placeTaskLine.
 */
import { describe, expect, it } from "vitest";
import { editTaskLine, parseNote, placeTaskLine, removeTaskLine, taskWords } from "../src/index.js";

const NOTE = ["# Thesis", "", "## Research plan", "- [ ] Draft chapter 3 !p1 due:2026-10-30 ^t-abc123", "- [/] Ask **Thijs** about [[Data|the data]] @jules", "", "## Writing", "- [ ] Outline"].join("\n");
const ref = { blockId: "t-abc123" };
const line = (content: string, i: number) => content.split("\n")[i];
/** Every line but `i`, so a test can say "nothing else changed". */
const others = (content: string, i: number) => content.split("\n").filter((_, j) => j !== i);

describe("taskWords", () => {
  it("is the line without its box, block id and the card's tokens; Markdown, links and @names stay", () => {
    expect(taskWords("- [ ] Draft chapter 3 !p1 due:2026-10-30 start:2026-10-20 #deadline ^t-abc123")).toBe("Draft chapter 3");
    expect(taskWords("> 1. [/] Ask **Thijs** about [[Data|the data]] @jules #thesis")).toBe("Ask **Thijs** about [[Data|the data]] @jules #thesis");
    expect(taskWords("not a task")).toBe("");
  });
});

describe("editTaskLine", () => {
  it("changes the words and keeps every token and the block id, in their order", () => {
    const out = editTaskLine(NOTE, ref, { words: "Draft chapter 3 and 4" })!;
    expect(line(out, 3)).toBe("- [ ] Draft chapter 3 and 4 !p1 due:2026-10-30 ^t-abc123");
    expect(others(out, 3)).toEqual(others(NOTE, 3));
  });

  it("sets, replaces and clears a date where it stands, one at a time", () => {
    expect(line(editTaskLine(NOTE, ref, { due: "2026-11-02" })!, 3)).toBe("- [ ] Draft chapter 3 !p1 due:2026-11-02 ^t-abc123");
    expect(line(editTaskLine(NOTE, ref, { start: "2026-10-26" })!, 3)).toBe("- [ ] Draft chapter 3 !p1 due:2026-10-30 start:2026-10-26 ^t-abc123");
    expect(line(editTaskLine(NOTE, ref, { due: null })!, 3)).toBe("- [ ] Draft chapter 3 !p1 ^t-abc123");
    // A token in the middle of the words is replaced in place, not moved.
    const mid = "- [ ] Call due:2026-10-01 the bank";
    expect(editTaskLine(mid, { text: "Call the bank" }, { due: "2026-10-05" })).toBe("- [ ] Call due:2026-10-05 the bank");
    expect(editTaskLine(mid, { text: "Call the bank" }, { due: null })).toBe("- [ ] Call the bank");
  });

  it("sets the priority and the key-deadline tag, and clears them", () => {
    expect(line(editTaskLine(NOTE, ref, { priority: 3 })!, 3)).toBe("- [ ] Draft chapter 3 !p3 due:2026-10-30 ^t-abc123");
    expect(line(editTaskLine(NOTE, ref, { priority: null })!, 3)).toBe("- [ ] Draft chapter 3 due:2026-10-30 ^t-abc123");
    expect(line(editTaskLine(NOTE, ref, { key: true })!, 3)).toBe("- [ ] Draft chapter 3 !p1 due:2026-10-30 #deadline ^t-abc123");
    expect(editTaskLine("- [ ] Hand in #Deadline", { text: "Hand in" }, { key: true })).toBe("- [ ] Hand in #Deadline");
    expect(editTaskLine("- [ ] Hand in #Deadline due:2026-01-01", { text: "Hand in" }, { key: false })).toBe("- [ ] Hand in due:2026-01-01");
    const parsed = parseNote(editTaskLine(NOTE, ref, { key: true, priority: 2 })!).tasks[0]!;
    expect([parsed.key, parsed.priority, parsed.text]).toEqual([true, 2, "Draft chapter 3"]);
  });

  it("writes the box, and keeps a quote, a numbered marker and the indent", () => {
    expect(editTaskLine("  > 1. [ ] x due:2026-01-01", { text: "x" }, { status: "blocked", due: null })).toBe("  > 1. [b] x");
    expect(editTaskLine("- [X] x", { text: "x" }, { status: "done" })).toBe("- [X] x");
  });

  it("returns the note unchanged when nothing changes, and null when the step is gone", () => {
    expect(editTaskLine(NOTE, ref, { words: "  Draft   chapter 3 ", key: false, status: "todo" })).toBe(NOTE);
    expect(editTaskLine(NOTE, { blockId: "t-gone00" }, { due: null })).toBeNull();
    expect(editTaskLine(NOTE, { text: "Never written" }, { due: null })).toBeNull();
  });

  it("refuses words that are no step", () => {
    expect(() => editTaskLine(NOTE, ref, { words: "   " })).toThrow();
    expect(() => editTaskLine(NOTE, ref, { words: "two\nlines" })).toThrow();
  });

  it("keeps a CRLF note CRLF, every other line byte for byte", () => {
    const crlf = NOTE.split("\n").join("\r\n") + "\r\n";
    const out = editTaskLine(crlf, ref, { words: "Draft it", due: "2026-12-01", key: true })!;
    expect(out).toBe(crlf.replace("Draft chapter 3 !p1 due:2026-10-30 ^t-abc123", "Draft it !p1 due:2026-12-01 #deadline ^t-abc123"));
  });

  it("edits the real step, never a copy of its line inside a code fence", () => {
    const fenced = ["```md", "- [ ] Outline", "```", "- [ ] Outline"].join("\n");
    expect(editTaskLine(fenced, { text: "Outline", line: 1 }, { due: "2026-10-30" })).toBe(["```md", "- [ ] Outline", "```", "- [ ] Outline due:2026-10-30"].join("\n"));
  });
});

describe("removeTaskLine and placeTaskLine (a move)", () => {
  it("takes the line out, nothing else, and hands it on without indent or quote", () => {
    const res = removeTaskLine(NOTE, ref)!;
    expect(res.content).toBe(NOTE.replace("- [ ] Draft chapter 3 !p1 due:2026-10-30 ^t-abc123\n", ""));
    expect(res.line).toBe("- [ ] Draft chapter 3 !p1 due:2026-10-30 ^t-abc123");
    expect(removeTaskLine("intro\n  > - [/] nested due:2026-01-01", { text: "nested" })).toEqual(expect.objectContaining({ content: "intro", line: "- [/] nested due:2026-01-01" }));
    expect(removeTaskLine(NOTE, { blockId: "t-gone00" })).toBeNull();
  });

  it("removes from a CRLF note and a fenced one byte for byte", () => {
    const crlf = "a\r\n```\r\n- [ ] x\r\n```\r\n- [ ] x\r\nb\r\n";
    expect(removeTaskLine(crlf, { text: "x" })!.content).toBe("a\r\n```\r\n- [ ] x\r\n```\r\nb\r\n");
  });

  it("puts the line last under the section, or at the end, in the note's own line ending", () => {
    const out = placeTaskLine(NOTE, "- [ ] New one ^t-new000", "Research plan")!;
    expect(out.split("\n").slice(3, 6)).toEqual(["- [ ] Draft chapter 3 !p1 due:2026-10-30 ^t-abc123", "- [/] Ask **Thijs** about [[Data|the data]] @jules", "- [ ] New one ^t-new000"]);
    expect(placeTaskLine("# Inbox\r\n", "- [ ] x")).toBe("# Inbox\r\n- [ ] x\r\n");
    expect(placeTaskLine("# P\n", "- [ ] x", "Tasks")).toBe("# P\n\n## Tasks\n\n- [ ] x\n");
  });

  it("refuses a note that already holds a step with the line's block id", () => {
    expect(placeTaskLine(NOTE, "- [ ] Elsewhere ^t-abc123", "Writing")).toBeNull();
  });
});
