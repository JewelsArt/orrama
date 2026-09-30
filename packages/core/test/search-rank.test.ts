/**
 * Search returns the best matches first, and finds words however they are
 * accented. The route keeps the first 50: unranked, those were simply the
 * first 50 in index order.
 */
import { describe, expect, it } from "vitest";
import { VaultIndex } from "../src/index.js";

const note = (i: number, title: string, body: string) => ({ path: `n/${title}.md`, content: `---\nid: n-${i}\n---\n# ${title}\n\n${body}\n`, mtimeMs: i });

describe("search", () => {
  it("puts a note with the word in its title first, even behind 60 passing mentions", () => {
    const idx = new VaultIndex();
    for (let i = 0; i < 60; i++) idx.upsert(note(i, `Meeting ${i}`, "we touched on forecasting briefly"));
    idx.upsert(note(99, "Forecasting method", "The chapter on forecasting: forecasting NL vs FR, forecasting error."));
    const res = idx.search("forecasting");
    expect(res).toHaveLength(61);
    expect(res[0]!.title).toBe("Forecasting method");
    expect(res.slice(0, 50).some((n) => n.title === "Forecasting method")).toBe(true);
  });

  it("ranks more mentions above fewer when no title matches", () => {
    const idx = new VaultIndex();
    idx.upsert(note(1, "A", "budget"));
    idx.upsert(note(2, "B", "budget budget budget and the budget review"));
    idx.upsert(note(3, "C", "nothing here"));
    expect(idx.search("budget").map((n) => n.title)).toEqual(["B", "A"]);
  });

  it("ignores accents and case, and still matches mid-word", () => {
    const idx = new VaultIndex();
    idx.upsert(note(1, "Résumé draft", "Café meeting in Zürich"));
    expect(idx.search("resume").map((n) => n.title)).toEqual(["Résumé draft"]);
    expect(idx.search("ZURICH cafe")).toHaveLength(1);
    expect(idx.search("ecast")).toHaveLength(0);
    idx.upsert(note(2, "Plan", "forecast"));
    expect(idx.search("ecast").map((n) => n.title)).toEqual(["Plan"]); // substring, like before
  });

  it("forgets a removed or rewritten note", () => {
    const idx = new VaultIndex();
    const f = note(1, "Temp", "unicorn");
    idx.upsert(f);
    idx.upsert({ ...f, content: f.content.replace("unicorn", "horse") });
    expect(idx.search("unicorn")).toEqual([]);
    idx.remove(f.path);
    expect(idx.search("horse")).toEqual([]);
  });
});
