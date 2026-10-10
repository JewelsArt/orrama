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

/**
 * Audit STO-004. Hunks are whole lines, and the last line of a note Obsidian
 * saved has no "\n". When one side edited that line and the other appended
 * after it, the two insertions were joined with nothing between them:
 * "- [ ] oat milk- [ ] milk". No output line may be two lines glued.
 */
describe("mergeText at a final line with no newline (STO-004)", () => {
  it("keeps the editor's typing and the agent's appended line apart", () => {
    expect(mergeText("# Inbox\n- milk", "# Inbox\n- milk\n- call Marc", "# Inbox\n- milk and eggs")).toBe(
      "# Inbox\n- milk and eggs\n- call Marc",
    );
  });

  it("keeps an Obsidian edit of the last line and a quick capture apart", () => {
    expect(mergeText("# Inbox\n- milk", "# Inbox\n- milk\n- [ ] pay rent @jules\n", "# Inbox\n- oat milk")).toBe(
      "# Inbox\n- oat milk\n- [ ] pay rent @jules\n",
    );
  });

  it("matches the control where the base ends with a newline", () => {
    expect(mergeText("# Inbox\n- milk\n", "# Inbox\n- milk\n- [ ] pay rent @jules\n", "# Inbox\n- oat milk\n")).toBe(
      "# Inbox\n- oat milk\n- [ ] pay rent @jules\n",
    );
  });

  it("never glues a line from one side onto a line from the other (seeded, 3,000 rounds)", () => {
    const rand = prng(404);
    let open = 0;
    for (let round = 0; round < 3000; round++) {
      const base = Array.from({ length: 1 + rand(6) }, (_, i) => `L${i}`);
      const side = (tag: string) => {
        const out: string[] = [];
        for (const l of base) {
          const r = rand(5);
          if (r === 0) out.push(`${l}${tag}`); // edit
          else if (r === 1) continue; // delete
          else if (r === 2) out.push(l, `new${tag}${rand(9)}`); // insert after
          else out.push(l);
        }
        if (rand(3) === 0) out.push(`end${tag}`); // append
        return out;
      };
      // Each text ends with or without a final newline, independently.
      const text = (ls: string[]) => ls.join("\n") + (rand(2) ? "\n" : "");
      const B = text(base);
      const O = text(side("o"));
      const T = text(side("t"));
      if (![B, O, T].every((s) => s === "" || s.endsWith("\n"))) open++;
      // "" too: an empty line is never two lines glued (and both sides
      // deleting everything leaves exactly that).
      const known = new Set(["", ...B.split("\n"), ...O.split("\n"), ...T.split("\n")]);
      for (const line of mergeText(B, O, T).split("\n")) {
        expect(known.has(line), `round ${round}: ${JSON.stringify(line)} from ${JSON.stringify([B, O, T])}`).toBe(true);
      }
    }
    expect(open).toBeGreaterThan(1500);
  });
});
