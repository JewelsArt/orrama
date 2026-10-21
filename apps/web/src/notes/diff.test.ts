/** The History sheet's line diff (1C). */
import { describe, expect, it } from "vitest";
import { changeWords, diffLines, withContext } from "./diff.js";

describe("diffLines", () => {
  it("keeps what is common, marks what was added and removed, in order", () => {
    expect(diffLines("a\nb\nc\nd", "a\nc\nx\nd")).toEqual([
      { kind: "same", text: "a" },
      { kind: "del", text: "b" },
      { kind: "same", text: "c" },
      { kind: "add", text: "x" },
      { kind: "same", text: "d" },
    ]);
  });

  it("the same text is all unchanged, and says so", () => {
    const d = diffLines("one\ntwo", "one\ntwo");
    expect(d.every((l) => l.kind === "same")).toBe(true);
    expect(changeWords(d)).toBeNull();
  });

  it("a note rewritten past the size limit is said as removed then added, not frozen on", () => {
    const before = Array.from({ length: 2000 }, (_, i) => `old ${i}`).join("\n");
    const after = Array.from({ length: 2000 }, (_, i) => `new ${i}`).join("\n");
    const d = diffLines(before, after);
    expect(d.filter((l) => l.kind === "del")).toHaveLength(2000);
    expect(d.filter((l) => l.kind === "add")).toHaveLength(2000);
  });
});

describe("withContext and changeWords", () => {
  it("folds long unchanged runs, keeping two lines around each change", () => {
    const before = Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n");
    const after = before.replace("l10", "changed");
    const shown = withContext(diffLines(before, after));
    expect(shown[0]).toEqual({ kind: "fold", count: 8 });
    expect(shown.filter((l) => l.kind !== "fold").map((l) => ("text" in l ? l.text : ""))).toEqual(["l8", "l9", "l10", "changed", "l11", "l12"]);
    expect(shown[shown.length - 1]).toEqual({ kind: "fold", count: 7 });
    expect(changeWords(diffLines(before, after))).toBe("1 line added, 1 removed");
    expect(changeWords(diffLines("a", "a\nb\nc"))).toBe("2 lines added");
  });
});
