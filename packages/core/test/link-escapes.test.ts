/**
 * Links as Obsidian reads them (audit COR-015): inside a table the alias pipe
 * is escaped, `[[Note\|alias]]`, and that is a link to Note; a link inside
 * inline code is code, not a link. The target used to keep the backslash
 * (`Note\`, which resolves to nothing), and code spans were stripped for tags
 * only.
 */
import { describe, expect, it } from "vitest";
import { cells, parseNote, VaultIndex } from "../src/index.js";

const links = (md: string) => parseNote(md).links.map((l) => [l.target, l.heading ?? null, l.alias ?? null]);

describe("a table-escaped alias pipe", () => {
  it("links to the note, with its alias and heading", () => {
    expect(links("| [[Note\\|alias]] | x |")).toEqual([["Note", null, "alias"]]);
    expect(links("| [[Note#Part\\|alias]] |")).toEqual([["Note", "Part", "alias"]]);
    expect(links("[[Note|plain alias]]")).toEqual([["Note", null, "plain alias"]]);
  });

  it("resolves, and the target lists the backlink", () => {
    const idx = new VaultIndex([
      { path: "Note.md", content: "---\nid: n-note\n---\n# Note\n" },
      { path: "Table.md", content: "---\nid: n-table\n---\n| Who |\n| --- |\n| [[Note\\|the note]] |\n" },
    ]);
    const src = idx.get("n-table")!;
    expect(idx.resolveLinkOf(src, src.links[0]!)?.id).toBe("n-note");
    expect(idx.backlinks("n-note").map((b) => b.fromId)).toEqual(["n-table"]);
  });

  it("keeps a ledger row's cells whole", () => {
    expect(cells("| [[Note\\|alias]] | 12 |")).toEqual(["[[Note\\|alias]]", "12"]);
  });
});

describe("links inside inline code", () => {
  it("are not links", () => {
    expect(links("see `[[example]]` and `[x](y.md)` but [[Real]]")).toEqual([["Real", null, null]]);
    expect(links("``code with ` and [[inside]]`` then [[Real]]")).toEqual([["Real", null, null]]);
  });

  it("a lone backtick does not hide what follows", () => {
    expect(links("it's 5` long, see [[Real]]")).toEqual([["Real", null, null]]);
    expect(links("``x` [[Real]]")).toEqual([["Real", null, null]]);
  });

  it("reads a long line of unmatched backtick runs in one pass", () => {
    let line = "";
    for (let n = 1; line.length < 400_000; n++) line += `${"`".repeat(n)} x `;
    const t = performance.now();
    parseNote(`${line}[[Real]]`);
    expect(performance.now() - t).toBeLessThan(1000);
  });
});
