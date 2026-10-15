/**
 * A copy made outside Orrama keeps the original's `title:`, so the file tree
 * listed "Atlas Roadmap" twice with nothing to tell them apart. Rows whose
 * title another note in the same folder shares also show their filename.
 */
import { describe, expect, it } from "vitest";
import { sameTitleFilenames } from "./FileTree.js";

const n = (id: string, title: string, path: string) => ({ id, title, path, folder: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "" });

describe("sameTitleFilenames", () => {
  it("names the file for notes sharing a title in one folder", () => {
    const out = sameTitleFilenames([
      n("a", "Atlas Roadmap", "Eng/Atlas Roadmap.md"),
      n("b", "Atlas Roadmap", "Eng/Atlas Roadmap 1.md"),
      n("c", "atlas roadmap", "Eng/atlas copy.md"),
      n("d", "Other", "Eng/Other.md"),
    ]);
    expect(Object.fromEntries(out)).toEqual({ a: "Atlas Roadmap.md", b: "Atlas Roadmap 1.md", c: "atlas copy.md" });
  });

  it("leaves alone the same title in different folders — the tree already separates them", () => {
    expect(sameTitleFilenames([n("a", "Index", "Eng/Index.md"), n("b", "Index", "Mkt/Index.md"), n("c", "Index", "Index.md")]).size).toBe(0);
  });
});
