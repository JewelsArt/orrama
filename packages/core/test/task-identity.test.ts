/**
 * A task is addressed by what it is, not by where it was (audit COR-001,
 * COR-009). A promoted task is its block id; any other task is its text, with
 * the line the caller saw it on as a hint. A line index alone names nothing:
 * the note may have moved under the caller (an Obsidian edit, a decision
 * appended above), and the edit would land on whichever task slid into place.
 */
import { describe, expect, it } from "vitest";
import { locateTask, parseNote, promoteTaskLine, setTaskChecked, setTaskDates, setTaskStatus } from "../src/index.js";

const list = "---\ntitle: List\n---\n- [ ] first task\n- [ ] second task\n- [ ] third task\n";
/** The same note after an edit put a new task at the top: every task moved down one. */
const moved = "---\ntitle: List\n---\n- [ ] new urgent task\n- [ ] first task\n- [ ] second task\n- [ ] third task\n";

describe("a task is found by its identity, never by a line alone (COR-001)", () => {
  it("a stale line with the task's text hits the task where it is now", () => {
    // The client saw "third task" on line 5; it is on line 6 now.
    const out = setTaskChecked(moved, { line: 5, text: "- [ ] third task" }, true)!;
    expect(out).toContain("- [x] third task");
    expect(out).toContain("- [ ] second task");
  });

  it("accepts the display text as well as the raw line", () => {
    const note = "- [ ] **draft** chapter 3 @jules due:2026-10-19\n";
    const t = parseNote(note, "T").tasks[0]!;
    expect(setTaskStatus(note, { line: 0, text: t.text }, "in-progress")).toBe("- [/] **draft** chapter 3 @jules due:2026-10-19\n");
    expect(setTaskStatus(note, { line: 0, text: t.raw }, "in-progress")).toBe("- [/] **draft** chapter 3 @jules due:2026-10-19\n");
  });

  it("a status changed since the snapshot is still the same task", () => {
    const done = moved.replace("- [ ] third task", "- [x] third task");
    expect(setTaskChecked(done, { line: 5, text: "- [ ] third task" }, false)).toContain("- [ ] third task");
  });

  it("a task promoted since the snapshot is still the same task", () => {
    const promoted = moved.replace("- [ ] third task", "- [ ] third task ^t-abc123");
    expect(setTaskChecked(promoted, { line: 5, text: "- [ ] third task" }, true)).toContain("- [x] third task ^t-abc123");
  });

  it("refuses a line whose text changed and matches no task", () => {
    expect(setTaskChecked(moved, { line: 5, text: "- [ ] fourth task" }, true)).toBeNull();
  });

  it("refuses a line with no text: a bare index identifies nothing", () => {
    expect(setTaskChecked(moved, { line: 5 }, true)).toBeNull();
    expect(setTaskStatus(moved, { line: 5 }, "blocked")).toBeNull();
    expect(setTaskDates(moved, { line: 5 }, { due: "2026-11-01" })).toBeNull();
    expect(promoteTaskLine(moved, { line: 5 })).toBeNull();
  });

  it("two tasks with the same text: the line decides, and with no matching line nothing is touched", () => {
    const twice = "- [ ] review\n- [ ] other\n- [ ] review\n";
    expect(setTaskChecked(twice, { line: 2, text: "review" }, true)).toBe("- [ ] review\n- [ ] other\n- [x] review\n");
    expect(setTaskChecked(twice, { line: 1, text: "review" }, true)).toBeNull();
    expect(setTaskChecked(twice, { text: "review" }, true)).toBeNull();
  });

  it("text alone finds a unique task (what an agent knows)", () => {
    expect(setTaskChecked(moved, { text: "second task" }, true)).toContain("- [x] second task");
  });

  it("a block id that is gone returns null — it never falls back to the line", () => {
    const gone = "- [ ] first task\n- [ ] third task\n";
    expect(setTaskStatus(gone, { blockId: "t-hs8k65", line: 1, text: "second task" }, "blocked")).toBeNull();
    expect(setTaskStatus(gone, { blockId: "gone", line: 0 }, "done")).toBeNull();
  });

  it("a block id wins over a stale line and changed text", () => {
    const note = "- [ ] renamed in Obsidian ^t-abc123\n- [ ] other\n";
    expect(setTaskChecked(note, { blockId: "t-abc123", line: 1, text: "old name" }, true)).toBe("- [x] renamed in Obsidian ^t-abc123\n- [ ] other\n");
  });

  it("a task-looking line inside a code fence is not a task", () => {
    const fenced = "```\n- [ ] sample ^t-abc123\n```\n- [ ] sample ^t-abc123\n";
    expect(setTaskChecked(fenced, { blockId: "t-abc123" }, true)).toBe("```\n- [ ] sample ^t-abc123\n```\n- [x] sample ^t-abc123\n");
    expect(setTaskChecked("```\n- [ ] sample\n```\n", { line: 1, text: "sample" }, true)).toBeNull();
  });

  it("locateTask reports the task it would edit", () => {
    expect(locateTask(moved, { line: 5, text: "third task" })).toMatchObject({ line: 6, text: "third task" });
    expect(locateTask(moved, { line: 5 })).toBeNull();
  });

  it("promotes the task the text names, not the line's new occupant", () => {
    const res = promoteTaskLine(moved, { line: 5, text: "third task" })!;
    expect(res.content).toMatch(/- \[ \] third task \^t-[a-z0-9]{6}\n/);
    expect(res.content).toContain("- [ ] second task\n");
  });
});

describe("a block id copied onto a second line (COR-009)", () => {
  const dup = "- [ ] alpha ^t-aaaaaa\n- [ ] beta ^t-aaaaaa\n";

  it("only the first line carries the id; the copy is a task of its own", () => {
    const tasks = parseNote(dup, "T").tasks;
    expect(tasks.map((t) => [t.text, t.blockId])).toEqual([
      ["alpha", "t-aaaaaa"],
      ["beta", undefined],
    ]);
  });

  it("the copy is edited by its text, and the id names the first line only", () => {
    expect(setTaskChecked(dup, { line: 1, text: "beta" }, true)).toBe("- [ ] alpha ^t-aaaaaa\n- [x] beta ^t-aaaaaa\n");
    expect(setTaskChecked(dup, { blockId: "t-aaaaaa" }, true)).toBe("- [x] alpha ^t-aaaaaa\n- [ ] beta ^t-aaaaaa\n");
  });

  it("an id addressed at the copy's line is refused, not applied to the first", () => {
    expect(setTaskChecked(dup, { blockId: "t-aaaaaa", line: 1, text: "beta" }, true)).toBeNull();
  });

  it("promoting the copy gives it its own id", () => {
    const res = promoteTaskLine(dup, { line: 1, text: "beta" })!;
    expect(res.blockId).not.toBe("t-aaaaaa");
    expect(res.content).toBe(`- [ ] alpha ^t-aaaaaa\n- [ ] beta ^${res.blockId}\n`);
    expect(parseNote(res.content, "T").tasks.map((t) => t.blockId)).toEqual(["t-aaaaaa", res.blockId]);
  });
});
