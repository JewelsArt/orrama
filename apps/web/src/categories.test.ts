/** The life areas' colours follow the list's order (Jules, 23 Oct 2026): the five, then grey. */
import { describe, expect, it } from "vitest";
import { areaColorAt, catchAllOf, categoriesOf, categoryColor } from "./categories.js";

const list = categoriesOf(["Family", "Home", "Work", "Running", "School", "Music", "Chess"].map((name, i) => ({ id: name.toLowerCase(), name, catchAll: i === 1 })));

describe("area colours", () => {
  it("the first five take --c1…--c5 in order; a sixth and after are --c-other", () => {
    expect(list.map((a) => a.color)).toEqual(["var(--c1)", "var(--c2)", "var(--c3)", "var(--c4)", "var(--c5)", "var(--c-other)", "var(--c-other)"]);
    expect(areaColorAt(5)).toBe("var(--c-other)");
  });

  it("an area's colour moves with it when the list is reordered", () => {
    const reordered = categoriesOf([list[3]!, list[0]!].map((a) => ({ id: a.id, name: a.label, catchAll: a.catchAll })));
    expect(categoryColor("running", reordered)).toBe("var(--c1)");
    expect(categoryColor("family", reordered)).toBe("var(--c2)");
    expect(categoryColor("gone", reordered)).toBe("var(--c-other)");
  });

  it("the catch-all is the one marked", () => {
    expect(catchAllOf(list)).toBe("home");
  });
});
