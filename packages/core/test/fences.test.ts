/**
 * Code fences close the way CommonMark and Obsidian close them: on a line of
 * the same character, at least as long as the opening run, with nothing after
 * it (audit COR-013). A toggle on any ``` or ~~~ closed a `~~~` block at its
 * inner ``` example and indexed the example's tasks, tags and headings; a
 * one-line ```js``` or an indented ``` opened a "fence" that swallowed the rest
 * of the note, `#only/<team>` included (ACL-006).
 */
import { describe, expect, it } from "vitest";
import { codeLines, parseNote, readSection } from "../src/index.js";

const tasks = (md: string) => parseNote(md).tasks.map((t) => t.text);

describe("fences", () => {
  it("a ~~~ block holding a ``` example closes only at its own ~~~", () => {
    expect(tasks("~~~\n```js\n- [ ] inside tilde fence\n```\n~~~\n- [ ] real\n")).toEqual(["real"]);
  });

  it("a ```` block holding a ``` example closes only at ````", () => {
    expect(tasks("````md\n```\n- [ ] inside four-backtick fence\n```\n````\n- [ ] real\n")).toEqual(["real"]);
  });

  it("a longer closing run closes; a closing line with text after it does not", () => {
    expect(tasks("```\n- [ ] in\n`````\n- [ ] real\n")).toEqual(["real"]);
    expect(tasks("```\n- [ ] in\n``` not a close\n- [ ] still in\n```\n- [ ] real\n")).toEqual(["real"]);
  });

  it("a one-line ```js``` is inline code, not a fence", () => {
    const n = parseNote("```js```\n\n#only/engineering\nbody\n- [ ] real\n");
    expect(n.onlyTeams).toEqual(["engineering"]);
    expect(n.tasks.map((t) => t.text)).toEqual(["real"]);
  });

  it("an indented ``` with nothing closing it is indented code, not a fence", () => {
    expect(parseNote("    ```\n#only/engineering\nbody\n").onlyTeams).toEqual(["engineering"]);
  });

  it("a fence inside a list item, indented and closed, still hides its lines", () => {
    expect(tasks("- step\n    ```\n    - [ ] example\n    ```\n- [ ] real\n")).toEqual(["real"]);
    expect(tasks("- step\n  ```md\n  - [ ] example\n  ```\n- [ ] real\n")).toEqual(["real"]);
  });

  it("an unclosed fence still runs to the end of the note", () => {
    expect(tasks("- [ ] before\n```\n- [ ] after\n")).toEqual(["before"]);
  });

  it("reads a note of many unclosed indented openers in one pass", () => {
    const lines = Array.from({ length: 40_000 }, () => "    ````x");
    const t = performance.now();
    codeLines(lines);
    expect(performance.now() - t).toBeLessThan(1000);
  });

  it("marks the fence lines and what is between them", () => {
    expect(codeLines(["a", "~~~", "```", "x", "```", "~~~", "b"])).toEqual([false, true, true, true, true, true, false]);
  });
});

describe("sections and fences", () => {
  it("a ## Goals inside a ```` block that contains a ``` line is not the slot", () => {
    const md = "# P\n\n````md\n```\n## Goals\n- example goal\n```\n````\n\n## Goals\n- real goal\n";
    expect(readSection(md, "Goals")).toBe("- real goal");
  });
});
