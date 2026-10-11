/**
 * The live preview finishes its job (structure.md §2.3): **bold**, *italic* and `code` hide
 * their marks, a list's dash is a bullet, a due date reads as words, and a done task is never
 * late. The rules, on one line of text.
 */
import { describe, expect, it } from "vitest";
import { dueWords, inlineMarks } from "./livePreview.js";

const shown = (text: string) => {
  const { hide } = inlineMarks(text);
  return [...text].filter((_, i) => !hide.some(([a, b]) => i >= a && i < b)).join("");
};

describe("inlineMarks", () => {
  it("hides the marks of strong, emphasis and code, and marks the words", () => {
    const t = "Ask for **one sentence** and *one* page, `MASE` too";
    expect(shown(t)).toBe("Ask for one sentence and one page, MASE too");
    const cls = inlineMarks(t).marks.map((m) => [t.slice(m.from, m.to), m.cls]);
    expect(cls).toEqual(expect.arrayContaining([["one sentence", "cm-strong"], ["one", "cm-em"], ["MASE", "cm-code-span"]]));
  });

  it("leaves words with underscores, lone stars and marks inside code alone", () => {
    expect(shown("snake_case_name and 2 * 3 * 4")).toBe("snake_case_name and 2 * 3 * 4");
    expect(shown("`**not bold**`")).toBe("**not bold**");
    expect(shown("__strong__ too")).toBe("strong too");
  });

  it("turns a list's dash into a bullet, but not a task's", () => {
    expect(inlineMarks("- Train on 2023").bullet).toEqual([0, 1]);
    expect(inlineMarks("  * nested").bullet).toEqual([2, 3]);
    expect(inlineMarks("- [ ] a task").bullet).toBeUndefined();
    expect(inlineMarks("-not a list").bullet).toBeUndefined();
  });
});

describe("dueWords", () => {
  const today = "2026-10-11"; // a Sunday
  it("says the day as the board does", () => {
    expect(dueWords("2026-10-11", false, today)).toEqual({ text: "today", late: false });
    expect(dueWords("2026-10-12", false, today)).toEqual({ text: "tomorrow", late: false });
    expect(dueWords("2026-10-16", false, today)).toEqual({ text: "Fri", late: false });
    expect(dueWords("2026-10-19", false, today)).toEqual({ text: "19 Oct", late: false });
    expect(dueWords("2027-01-04", false, today)).toEqual({ text: "4 Jan 2027", late: false });
  });
  it("an open task past its day is late; a done one never is", () => {
    expect(dueWords("2026-10-08", false, today)).toEqual({ text: "3 days late", late: true });
    expect(dueWords("2026-10-10", false, today)).toEqual({ text: "1 day late", late: true });
    expect(dueWords("2026-10-05", true, today)).toEqual({ text: "Mon", late: false });
  });
});
