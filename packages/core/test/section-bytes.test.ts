/**
 * A section write touches its own section and nothing else (audit COR-005,
 * COR-007, COR-008). The project workspace writes goals, the prompt, decisions,
 * the inbox and people into the project note; every byte outside the slot is
 * the user's, and so is the slot's own structure.
 */
import { describe, expect, it } from "vitest";
import { appendToSection, readSection, writeSection } from "../src/sections.js";
import { parseNote } from "../src/parse.js";

const NOTE = [
  "---",
  "title: Thesis",
  "---",
  "# Thesis",
  "",
  "## Steps",
  "- [ ] step A",
  "",
  "## Notes",
  "```python",
  "def f():",
  "",
  "",
  "",
  "    return 1",
  "```",
  "",
  "",
  "",
  "Roses are red,",
  "",
  "",
  "violets are blue.",
  "",
  "## Decisions",
  "- **2026-10-01** — first",
  "",
].join("\n");

describe("writing a section leaves the rest of the note alone (COR-007)", () => {
  it("an append changes no byte outside its section", () => {
    const out = appendToSection(NOTE, "Decisions", "- **2026-10-02** — new decision");
    expect(out).toBe(NOTE.replace("- **2026-10-01** — first\n", "- **2026-10-01** — first\n- **2026-10-02** — new decision\n"));
  });

  it("fenced code with blank lines in another section survives, and no task moves", () => {
    const out = writeSection(NOTE, "Decisions", "- replaced");
    expect(out.slice(0, out.indexOf("## Decisions"))).toBe(NOTE.slice(0, NOTE.indexOf("## Decisions")));
    expect(parseNote(out).tasks[0]!.line).toBe(parseNote(NOTE).tasks[0]!.line);
  });

  it("a write of what is there is byte-identical — spacing, trailing spaces and all", () => {
    const odd = "# P\n## Goals\n\n\n- a\n  - nested  \n\n\n## Next\nx";
    expect(writeSection(odd, "Goals", readSection(odd, "Goals"))).toBe(odd);
    expect(readSection(odd, "Goals")).toBe("- a\n  - nested  ");
  });

  it("emptying a section keeps its heading and the next one apart", () => {
    expect(writeSection("## Goals\n- a\n\n## Next\nx\n", "Goals", "")).toBe("## Goals\n\n## Next\nx\n");
  });

  it("a section with nothing in it gets its body between blank lines", () => {
    expect(writeSection("## Goals\n## Next\n", "Goals", "- a")).toBe("## Goals\n\n- a\n\n## Next\n");
    expect(appendToSection("# P\n\n## Inbox\n", "Inbox", "- x")).toBe("# P\n\n## Inbox\n\n- x\n");
  });
});

describe("a slot is a `##` section, closed or not (COR-008)", () => {
  const nested = "# Thesis\n\n## Research plan\n\n### Goals\n- chapter-level goal\n\n## Goals\n- Ship the plan\n";

  it("reads the `## Goals`, not a `### Goals` nested earlier", () => {
    expect(readSection(nested, "Goals")).toBe("- Ship the plan");
  });

  it("writes the `## Goals` and leaves the nested one alone", () => {
    expect(writeSection(nested, "Goals", "- new goal")).toBe(nested.replace("- Ship the plan", "- new goal"));
  });

  it("finds a closed ATX heading for read, write and append, and makes no duplicate", () => {
    const closed = "## Goals ##\n- ship\n";
    expect(readSection(closed, "Goals")).toBe("- ship");
    expect(writeSection(closed, "Goals", "- more")).toBe("## Goals ##\n- more\n");
    expect(appendToSection(closed, "Goals", "- more")).toBe("## Goals ##\n- ship\n- more\n");
  });

  it("a deeper heading inside the slot still belongs to it", () => {
    const deep = "## Decisions\n- a\n\n### Rejected\n- b\n\n## People\n";
    expect(readSection(deep, "Decisions")).toBe("- a\n\n### Rejected\n- b");
  });

  it("with only a `### Goals`, a `## Goals` is created at the end", () => {
    const only = "# P\n\n## Plan\n### Goals\n- sub\n";
    expect(readSection(only, "Goals")).toBe("");
    expect(writeSection(only, "Goals", "- top")).toBe("# P\n\n## Plan\n### Goals\n- sub\n\n## Goals\n\n- top\n");
  });
});
