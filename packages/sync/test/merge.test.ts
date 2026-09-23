import { describe, expect, it } from "vitest";
import { createNoteDoc, docContent, lineHunks, mergeText, updateDocContent } from "../src/index.js";

/** mulberry32. An LCG's low bits cycle with period 4, which made the two sides'
 *  edit patterns move in lockstep — every round "overlapped" and none tested
 *  anything else. */
const prng = (seed: number) => (n: number) => {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) % n;
};

const note = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}\n`).join("");

describe("mergeText", () => {
  // The audit's B5 scenario, stated against the old behaviour first so the
  // test shows what it is guarding: one splice from the stale side wipes the
  // other side's edit. If this ever stops holding, the second half proves less.
  it("keeps both edits where one splice against the live text loses one", () => {
    const base = note(100);
    const tabA = base.replace("line 5\n", "line 5 EDITED-BY-A\n");
    const tabB = base.replace("line 90\n", "line 90 EDITED-BY-B\n");

    const doc = createNoteDoc(tabA); // A saved first
    updateDocContent(doc, tabB); //     B saves its stale buffer the old way
    expect(docContent(doc)).not.toContain("EDITED-BY-A");

    const merged = mergeText(base, tabB, tabA);
    expect(merged).toContain("line 5 EDITED-BY-A\n");
    expect(merged).toContain("line 90 EDITED-BY-B\n");
    expect(merged.split("\n")).toHaveLength(101);
  });

  it("keeps an edit between two of the other side's, which one splice would span", () => {
    const base = note(100);
    const ours = base.replace("line 5\n", "line 5 ours\n").replace("line 90\n", "line 90 ours\n");
    const theirs = base.replace("line 50\n", "line 50 theirs\n");
    const merged = mergeText(base, ours, theirs);
    expect(merged).toBe(
      base.replace("line 5\n", "line 5 ours\n").replace("line 50\n", "line 50 theirs\n").replace("line 90\n", "line 90 ours\n"),
    );
  });

  it("applies a change both sides made only once", () => {
    const base = "- [ ] a\n- [ ] b\n";
    const both = "- [x] a\n- [ ] b\n";
    expect(mergeText(base, both, both)).toBe(both);
    // Same hunk plus a different one on one side: still no duplicate.
    const ours = "- [x] a\n- [ ] b\n- [ ] c\n";
    expect(mergeText(base, ours, both)).toBe(ours);
  });

  it("returns the only side that changed", () => {
    expect(mergeText("x\n", "x\n", "y\n")).toBe("y\n");
    expect(mergeText("x\n", "y\n", "x\n")).toBe("y\n");
  });

  it("merges a checkbox toggle with an appended line — the watcher-window case", () => {
    const base = "---\nid: n-1\n---\n- [ ] task one\n";
    const obsidian = base + "OBSIDIAN-EDIT\n";
    const toggle = base.replace("- [ ]", "- [x]");
    expect(mergeText(base, toggle, obsidian)).toBe("---\nid: n-1\n---\n- [x] task one\nOBSIDIAN-EDIT\n");
  });

  it("keeps a replaced line above a line the other side added under it, either way round", () => {
    const base = "a\nb\n";
    expect(mergeText(base, "a\nB\n", "a\nb\nnew\n")).toBe("a\nB\nnew\n");
    expect(mergeText(base, "a\nb\nnew\n", "a\nB\n")).toBe("a\nB\nnew\n");
  });

  // Disjoint edits must compose exactly, whatever they are. Each side rewrites,
  // deletes or inserts after its own lines, never the other side's, and the
  // merge has to equal both edit sets applied together.
  it("composes disjoint random line edits exactly (2,000 seeded rounds)", () => {
    const rand = prng(42);
    for (let round = 0; round < 2000; round++) {
      const n = 3 + rand(40);
      const base = Array.from({ length: n }, (_, i) => `L${i}\n`);
      const owner = base.map(() => rand(3)); // 0 untouched, 1 ours, 2 theirs
      const op = base.map(() => rand(3)); //   0 rewrite, 1 delete, 2 insert-after
      const render = (who: number[]) =>
        base
          .map((l, i) => {
            if (!who.includes(owner[i]!)) return l;
            const tag = owner[i] === 1 ? "o" : "t";
            return op[i] === 0 ? `${l.trim()}-${tag}\n` : op[i] === 1 ? "" : `${l}ins-${tag}${i}\n`;
          })
          .join("");
      const merged = mergeText(base.join(""), render([1]), render([2]));
      expect(merged, `round ${round}`).toBe(render([1, 2]));
    }
  });

  // Where the sides DO collide there is no single right answer, but there is a
  // floor: no line either side typed may be missing from the result.
  it("never drops a line either side typed, even when their edits overlap", () => {
    const rand = prng(7);
    let overlapped = 0;
    for (let round = 0; round < 2000; round++) {
      const base = Array.from({ length: 2 + rand(30) }, (_, i) => `L${i}\n`);
      const ours = base.map(() => rand(4) === 0);
      const theirs = base.map(() => rand(4) === 0);
      if (ours.some((x, i) => x && theirs[i])) overlapped++;
      const O = base.map((l, i) => (ours[i] ? `${l.trim()}-o\n` : l)).join("");
      const T = base.map((l, i) => (theirs[i] ? `${l.trim()}-t\n` : l)).join("");
      const merged = mergeText(base.join(""), O, T).split("\n");
      for (const typed of [...O.split("\n").filter((x) => x.endsWith("-o")), ...T.split("\n").filter((x) => x.endsWith("-t"))]) {
        expect(merged, `round ${round}`).toContain(typed);
      }
    }
    // Guard against a generator that never produces the case under test.
    expect(overlapped).toBeGreaterThan(500);
  });

  it("keeps both insertions at the same spot, theirs first, deterministically", () => {
    const base = "a\n";
    const merged = mergeText(base, "a\nours\n", "a\ntheirs\n");
    expect(merged).toBe("a\ntheirs\nours\n");
    expect(mergeText(base, "a\nours\n", "a\ntheirs\n")).toBe(merged);
  });

  it("handles a last line with no newline", () => {
    expect(mergeText("a\nb", "A\nb", "a\nB")).toBe("A\nB");
  });

  it("keeps a deletion on one side and an edit elsewhere on the other", () => {
    const base = note(10);
    const ours = base.replace("line 3\n", "");
    const theirs = base.replace("line 8\n", "line 8!\n");
    expect(mergeText(base, ours, theirs)).toBe(base.replace("line 3\n", "").replace("line 8\n", "line 8!\n"));
  });
});

describe("lineHunks", () => {
  it("reports separate hunks for separate edits, in base offsets", () => {
    const base = "a\nb\nc\nd\n";
    const hunks = lineHunks(base, "A\nb\nc\nD\n");
    expect(hunks).toEqual([
      { start: 0, end: 2, insert: "A\n" },
      { start: 6, end: 8, insert: "D\n" },
    ]);
  });
});
