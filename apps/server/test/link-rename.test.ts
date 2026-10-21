/** The link rewriter a rename uses (linkRename.ts): exact forms only, code untouched, bytes kept. */
import { describe, expect, it } from "vitest";
import { parseNote } from "@orrama/core";
import { retarget, rewriteLinks, type Renaming } from "../src/linkRename.js";

const rename: Renaming = { from: { path: "Ideas/Old.md", title: "Old" }, to: { path: "Ideas/New.md", title: "New" } };
const swap = (t: string) => retarget(t, rename);

describe("retarget", () => {
  it("renames the name, the title and the path forms, and nothing else", () => {
    expect(swap("Old")).toBe("New");
    expect(swap("old")).toBe("New");
    expect(swap("Ideas/Old")).toBe("Ideas/New");
    expect(swap("Ideas/Old.md")).toBe("Ideas/New.md");
    expect(swap("An alias")).toBeNull();
    expect(swap("Older")).toBeNull();
  });

  it("a move keeps a link by name and changes a link by path", () => {
    const move: Renaming = { from: { path: "Ideas/Old.md", title: "Old" }, to: { path: "Archive/Old.md", title: "Old" } };
    expect(retarget("Old", move)).toBeNull();
    expect(retarget("Ideas/Old", move)).toBe("Archive/Old");
  });

  it("a title other than the file name follows as the title", () => {
    const titled: Renaming = { from: { path: "Ideas/2026-10-01.md", title: "Kickoff" }, to: { path: "Ideas/Kickoff meeting.md", title: "Kickoff meeting" } };
    expect(retarget("Kickoff", titled)).toBe("Kickoff meeting");
    expect(retarget("2026-10-01", titled)).toBe("Kickoff meeting");
  });
});

describe("rewriteLinks", () => {
  it("keeps headings, blocks, labels and the table pipe as written", () => {
    const text = "[[Old#Plan]] [[Old#^t-abc123]] [[Old|label]] | [[Old\\|in a table]] | ![[Old]]";
    expect(rewriteLinks(text, swap)).toEqual({ content: "[[New#Plan]] [[New#^t-abc123]] [[New|label]] | [[New\\|in a table]] | ![[New]]", count: 5 });
  });

  it("leaves code alone: inline spans and fences", () => {
    const text = "`[[Old]]` and ``a `[[Old]]` b`` then [[Old]]\n```\n[[Old]]\n```\n~~~md\n[[Old]]\n~~~\n";
    const out = rewriteLinks(text, swap);
    expect(out.count).toBe(1);
    expect(out.content).toBe(text.replace("then [[Old]]", "then [[New]]"));
  });

  it("keeps CRLF lines and a missing final newline byte for byte", () => {
    const text = "---\r\nid: n-1\r\n---\r\n# T\r\nsee [[Old]]\r\nend";
    expect(rewriteLinks(text, swap).content).toBe("---\r\nid: n-1\r\n---\r\n# T\r\nsee [[New]]\r\nend");
  });

  it("rewrites front matter only when it still reads back", () => {
    const ok = '---\nabout: "[[Old]]"\n---\n[[Old]]\n';
    expect(rewriteLinks(ok, swap)).toEqual({ content: '---\nabout: "[[New]]"\n---\n[[New]]\n', count: 2 });
    // A new name that breaks the YAML (a quote in a single-quoted value): the body only.
    const quoted = "---\nabout: '[[Old]]'\n---\n[[Old]]\n";
    const out = rewriteLinks(quoted, (t) => (t === "Old" ? "Jules's" : null));
    expect(out.content).toBe("---\nabout: '[[Old]]'\n---\n[[Jules's]]\n");
  });

  it("finds every wiki link the parser finds (the two grammars are one)", () => {
    const text = [
      "# Many",
      "[[A]] [[B#h]] [[C|c]] [[D#h|d]] [[E\\|e]] ![[F]] [[ G ]]",
      "`[[no]]` [[H]]",
      "- [ ] task [[I]]",
      "```",
      "[[no]]",
      "```",
    ].join("\n");
    const parsed = parseNote(text).links.filter((l) => l.raw.startsWith("[[")).map((l) => l.target);
    const seen: string[] = [];
    rewriteLinks(text, (t) => (seen.push(t), null));
    expect(seen).toEqual(parsed);
  });
});
