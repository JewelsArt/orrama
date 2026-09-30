/** Which of several files carrying one note id keeps it (noteIds.ts). */
import { describe, expect, it } from "vitest";
import { carriedId, chooseIdOwner } from "../src/noteIds.js";

const c = (rel: string, birthtimeMs: number, mtimeMs: number) => ({ rel, birthtimeMs, mtimeMs });

describe("chooseIdOwner", () => {
  it("the path the notes table has wins, however young the file", () => {
    // An editor that saves by writing a temp file and renaming it over the
    // original gives the original a NEW creation time on every save.
    const orig = c("Notes/Plan.md", 9_000, 9_000);
    const copy = c("Notes/Plan 1.md", 1_000, 1_000);
    expect(chooseIdOwner([copy, orig], "Notes/Plan.md")).toBe(orig);
  });

  it("a known path that is no longer among the files decides nothing", () => {
    const a = c("A.md", 1_000, 5_000);
    const b = c("B.md", 2_000, 1_000);
    expect(chooseIdOwner([b, a], "Gone.md")).toBe(a);
  });

  it("then the file created first — not the older mtime", () => {
    // The original keeps being edited; the stale copy has the older mtime.
    const orig = c("Notes/Plan.md", 1_000, 9_000);
    const copy = c("Notes/Plan 1.md", 2_000, 3_000);
    expect(chooseIdOwner([copy, orig], undefined)).toBe(orig);
  });

  it("then the older mtime, when a file has no creation time", () => {
    const a = c("A.md", 0, 5_000);
    const b = c("B.md", 1_000, 2_000);
    expect(chooseIdOwner([a, b], undefined)).toBe(b);
  });

  it("then the path, in code-unit order", () => {
    const a = c("Zeta/Plan.md", 1_000, 1_000);
    const b = c("Alpha/Plan.md", 1_000, 1_000);
    expect(chooseIdOwner([a, b], undefined)).toBe(b);
    expect(chooseIdOwner([b, a], undefined)).toBe(b);
  });
});

describe("carriedId", () => {
  it("reads the front-matter id as parseNote does", () => {
    expect(carriedId("---\nid: n-abc\ntitle: x\n---\nbody\n")).toBe("n-abc");
    expect(carriedId("no front matter\n")).toBeUndefined();
    expect(carriedId("---\nid: 42\n---\n")).toBeUndefined();
    expect(carriedId("---\ntitle: a: b\nid: n-abc\n---\n")).toBeUndefined(); // malformed: no metadata at all
  });
});
