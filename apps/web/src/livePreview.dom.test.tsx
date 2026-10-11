/**
 * The real editor, previewing (structure.md §2.3): what a reader sees off the line being
 * edited — no `**`, a bullet for a dash, due dates in words, a done task without a late mark.
 */
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { isoLocal } from "@basalt/core/dates";
import { Editor } from "./Editor.js";

const day = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return isoLocal(d);
};

const NOTE = [
  "Intro line",
  "",
  "Ask for **one sentence** and the method.",
  "- Train on Dutch campaigns",
  `- [ ] Ask Thijs due:${day(-3)}`,
  `- [x] Pick the metric due:${day(-6)}`,
  `- [ ] Refine the question due:${day(0)}`,
  "- [x] **Done** and bold, both marks starting together",
  "",
].join("\n");

const lines = (c: HTMLElement) => [...c.querySelectorAll(".cm-line")] as HTMLElement[];

describe("the preview, off the line being edited", () => {
  it("hides bold marks, draws bullets, says due dates in words, and a done task is not late", () => {
    const { container } = render(<Editor noteId="n" content={NOTE} readOnly={false} completions={{ titles: [], users: [], tags: [] }} onChange={() => {}} />);
    const ls = lines(container);
    expect(ls[2]!.textContent).toBe("Ask for one sentence and the method.");
    expect(ls[2]!.querySelector(".cm-strong")?.textContent).toBe("one sentence");
    expect(ls[3]!.querySelector(".cm-bullet")).toBeTruthy();
    expect(ls[4]!.querySelector(".cm-bullet")).toBeNull(); // a task has its box, not a bullet
    expect(ls[4]!.querySelector(".cm-due")?.textContent).toBe("3 days late");
    expect(ls[4]!.querySelector(".cm-due")?.classList.contains("late")).toBe(true);
    expect(ls[5]!.querySelector(".cm-due")?.classList.contains("late")).toBe(false);
    expect(ls[5]!.textContent).not.toContain("late");
    expect(ls[6]!.querySelector(".cm-due")?.textContent).toBe("today");
    expect(container.textContent).not.toContain("due:");
    expect(ls[7]!.querySelector(".cm-task-done .cm-strong, .cm-strong")?.textContent).toBe("Done");
  });
});
