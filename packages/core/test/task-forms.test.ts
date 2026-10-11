/**
 * Every checkbox Obsidian draws is a task (audit COR-014; Jules chose all of
 * them, 11 Oct 2026): `- [ ]`, `* [ ]`, `+ [ ]`, `1. [ ]`, `1) [ ]`, and any of
 * them inside a blockquote or callout (`> - [ ]`). Only `- [ ]` used to be,
 * so the rest never reached the Dashboard, Planning, project progress or the
 * scheduler, and the task edits refused them. An edit keeps the line's own
 * marker and quote prefix.
 */
import { describe, expect, it } from "vitest";
import { locateTask, parseNote, promoteTaskLine, setTaskDates, setTaskStatus } from "../src/index.js";

const FORMS = ["- [ ] a task", "* [ ] a task", "+ [ ] a task", "1. [ ] a task", "12) [ ] a task", "> - [ ] a task", "> > * [ ] a task", "  2. [ ] a task", ">\t- [ ] a task"];

describe("task forms", () => {
  it("each form parses as the same task", () => {
    for (const line of FORMS) {
      const [t] = parseNote(`${line} due:2026-10-20 !p2\n`).tasks;
      expect(t, line).toMatchObject({ text: "a task", status: "todo", due: "2026-10-20", priority: 2, line: 0 });
    }
  });

  it("reads a callout's tasks", () => {
    const md = "> [!todo] This week\n> - [ ] draft chapter 3\n> - [x] send chapter 2\n\nafter\n";
    expect(parseNote(md).tasks.map((t) => [t.text, t.status])).toEqual([
      ["draft chapter 3", "todo"],
      ["send chapter 2", "done"],
    ]);
  });

  it("a nested item keeps its indent; a quote marker is not indent", () => {
    expect(parseNote("  * [ ] sub").tasks[0]!.indent).toBe(2);
    expect(parseNote("> - [ ] quoted").tasks[0]!.indent).toBe(0);
    expect(parseNote(">   - [ ] quoted sub").tasks[0]!.indent).toBe(2);
  });

  it("near-misses stay text", () => {
    for (const line of ["-[ ] no space", "1.[ ] no space", "a. [ ] letter", "x - [ ] mid-line", "- [ ]no space after", "[ ] bare box", "-- [ ] double"]) {
      expect(parseNote(line).tasks, line).toEqual([]);
    }
  });
});

describe("edits keep the marker and the prefix", () => {
  it("ticks, dates and promotes each form", () => {
    for (const line of FORMS) {
      const head = line.slice(0, line.indexOf("[") + 1);
      const md = `# N\n${line}\n`;
      expect(setTaskStatus(md, { text: "a task" }, "done"), line).toBe(`# N\n${head}x] a task\n`);
      expect(setTaskStatus(md, { text: line }, "in-progress"), line).toBe(`# N\n${head}/] a task\n`);
      expect(setTaskDates(md, { text: "a task" }, { due: "2026-11-01" }), line).toBe(`# N\n${line} due:2026-11-01\n`);
      const p = promoteTaskLine(md, { text: "a task" })!;
      expect(p.content, line).toBe(`# N\n${line} ^${p.blockId}\n`);
      expect(locateTask(p.content, { blockId: p.blockId })!.text).toBe("a task");
    }
  });

  it("a raw line seen before the box was ticked still names its task", () => {
    for (const line of FORMS) {
      const ticked = `${line.replace("[ ]", "[x]")} and more\n`;
      expect(locateTask(ticked, { text: `${line} and more` })?.line, line).toBe(0);
    }
  });
});
