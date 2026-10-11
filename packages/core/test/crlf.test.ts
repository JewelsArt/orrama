/**
 * A note with CRLF line endings (written on Windows, synced through git with
 * autocrlf, exported by another tool) reads like its LF twin and is edited in
 * CRLF throughout (audit COR-012). `.` does not match "\r", so every anchored
 * line regex failed: no tasks, no headings, task edits answered "not a task",
 * and section writes put LF lines into a CRLF file.
 */
import { describe, expect, it } from "vitest";
import {
  appendLine,
  appendRow,
  appendToSection,
  parseNote,
  promoteTaskLine,
  readSection,
  setTaskDates,
  setTaskStatus,
  writeSection,
} from "../src/index.js";

const LF = "---\nid: n-1\ntitle: X\n---\n# Heading\n- [ ] task one due:2026-10-05\n- [x] task two\n[[Other]] #tag\n";
const CRLF = LF.replace(/\n/g, "\r\n");
/** Every line break is CRLF: no bare "\n" anywhere. */
const allCrlf = (s: string) => !/(^|[^\r])\n/.test(s);

describe("reading a CRLF note", () => {
  it("yields the same tasks, headings, links, tags and title as its LF twin", () => {
    const a = parseNote(LF);
    const b = parseNote(CRLF);
    expect(b.tasks).toEqual(a.tasks);
    expect(b.headings).toEqual(a.headings);
    expect(b.links).toEqual(a.links);
    expect(b.tags).toEqual(a.tags);
    expect([b.title, b.id]).toEqual(["X", "n-1"]);
    expect(b.tasks.map((t) => t.text)).toEqual(["task one", "task two"]);
  });

  it("reads a section without its \\r", () => {
    expect(readSection("## Goals\r\n- a\r\n- b\r\n\r\n## Next\r\n", "Goals")).toBe("- a\n- b");
  });
});

describe("editing a CRLF note keeps CRLF", () => {
  it("ticks, dates and promotes a task", () => {
    const ticked = setTaskStatus(CRLF, { text: "task one", line: 5 }, "done");
    expect(ticked).toBe(CRLF.replace("- [ ] task one", "- [x] task one"));
    const dated = setTaskDates(CRLF, { text: "task one" }, { start: "2026-10-01" })!;
    expect(dated).toBe(CRLF.replace("due:2026-10-05", "due:2026-10-05 start:2026-10-01"));
    const promoted = promoteTaskLine(CRLF, { text: "task two" })!;
    expect(promoted.content).toBe(CRLF.replace("- [x] task two", `- [x] task two ^${promoted.blockId}`));
  });

  it("writes and appends to a section", () => {
    const md = "## Goals\r\n- a\r\n\r\n## Next\r\n- b\r\n";
    const out = writeSection(md, "Goals", "- z\n- y");
    expect(out).toBe("## Goals\r\n- z\r\n- y\r\n\r\n## Next\r\n- b\r\n");
    expect(appendToSection(md, "Goals", "- c")).toBe("## Goals\r\n- a\r\n- c\r\n\r\n## Next\r\n- b\r\n");
    expect(allCrlf(writeSection("## Goals\r\n\r\n## Next\r\n", "Goals", "- z"))).toBe(true);
    expect(allCrlf(writeSection("# P\r\n", "Inbox", "- new"))).toBe(true);
    expect(writeSection("# P\r\n## Goals", "Goals", "- z")).toBe("# P\r\n## Goals\r\n\r\n- z\r\n");
  });

  it("writing back what readSection returned is byte-identical", () => {
    const md = "## Goals\r\n- a\r\n- b\r\n\r\n## Next\r\n";
    expect(writeSection(md, "Goals", readSection(md, "Goals"))).toBe(md);
  });

  it("appends a table row and a captured line in CRLF", () => {
    const table = "# Subs\r\n\r\n| Name | Price |\r\n| --- | --- |\r\n| A | 1 |\r\n\r\nafter\r\n";
    expect(appendRow(table, { name: "name", price: "price" }, ["name", "price"], { name: "B", price: "2" })).toBe(
      "# Subs\r\n\r\n| Name | Price |\r\n| --- | --- |\r\n| A | 1 |\r\n| B | 2 |\r\n\r\nafter\r\n",
    );
    expect(appendRow("| Name | Price |\r\n| --- | --- |\r\n| A | 1 |", { name: "name", price: "price" }, ["name", "price"], { name: "B", price: "2" })).toBe(
      "| Name | Price |\r\n| --- | --- |\r\n| A | 1 |\r\n| B | 2 |",
    );
    expect(appendLine("# Inbox\r\n- a\r\n", "- b")).toBe("# Inbox\r\n- a\r\n- b\r\n");
    expect(appendLine("# Inbox\r\n- a", "- b")).toBe("# Inbox\r\n- a\r\n- b\r\n");
  });

  it("leaves an LF note's bytes as they were", () => {
    expect(setTaskStatus(LF, { text: "task one" }, "done")).toBe(LF.replace("- [ ] task one", "- [x] task one"));
    expect(writeSection("## Goals\n- a\n", "Goals", "- z")).toBe("## Goals\n- z\n");
    expect(appendLine("a", "b")).toBe("a\nb\n");
  });
});
