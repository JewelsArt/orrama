/**
 * Audit B10: a task's "in progress" / "blocked" state lives in its checkbox —
 * `[/]` and `[b]` — so it survives losing the database. These are the rules
 * every surface reads (ParsedTask.status) and every route writes (setTaskStatus).
 */
import { describe, expect, it } from "vitest";
import { parseNote, readSectionItems, setTaskChecked, setTaskDates, setTaskStatus } from "../src/index.js";

const tasksOf = (body: string) => parseNote(body, "T").tasks.map((t) => [t.status, t.checked, t.text]);

describe("task marks", () => {
  it("reads all four states off the checkbox, and only [x] is checked", () => {
    expect(tasksOf("- [ ] a\n- [/] b\n- [b] c\n- [x] d\n- [X] e")).toEqual([
      ["todo", false, "a"],
      ["in-progress", false, "b"],
      ["blocked", false, "c"],
      ["done", true, "d"],
      ["done", true, "e"],
    ]);
  });

  it("other characters are still not tasks", () => {
    expect(tasksOf("- [?] a\n- [B] b\n- [-] c\n- [] d")).toEqual([]);
  });

  it("writes each state into the box and leaves the rest of the line alone", () => {
    const line = "- [ ] draft chapter 3 @jules due:2026-10-19 ^t-abc123";
    expect(setTaskStatus(line, { line: 0 }, "in-progress")).toBe("- [/] draft chapter 3 @jules due:2026-10-19 ^t-abc123");
    expect(setTaskStatus(line, { blockId: "t-abc123" }, "blocked")).toBe("- [b] draft chapter 3 @jules due:2026-10-19 ^t-abc123");
    expect(setTaskStatus("- [b] x", { line: 0 }, "done")).toBe("- [x] x");
    expect(setTaskStatus("- [/] x", { line: 0 }, "todo")).toBe("- [ ] x");
    expect(setTaskStatus("- [X] x", { line: 0 }, "done")).toBe("- [X] x");
    expect(setTaskStatus("plain line", { line: 0 }, "done")).toBeNull();
  });

  it("the older transforms work on marked lines too", () => {
    expect(setTaskChecked("- [/] x", { line: 0 }, true)).toBe("- [x] x");
    expect(setTaskDates("- [b] x ^t-1", { line: 0 }, { due: "2026-11-01" })).toBe("- [b] x due:2026-11-01 ^t-1");
    expect(readSectionItems("## Goals\n- [/] ship it\n- [b] wait", "Goals")).toEqual(["ship it", "wait"]);
  });
});
