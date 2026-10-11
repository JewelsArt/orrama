import { describe, expect, it } from "vitest";
import { parseBlocks, parseInline } from "./markdown.js";

describe("Orr's answers as Markdown", () => {
  it("reads citations, with a label or a heading, as citations", () => {
    expect(parseInline("See [[Research plan]] and [[Thijs Brouwer|Thijs]] or [[Weekly meetings#Friday]].")).toEqual([
      { t: "text", s: "See " },
      { t: "cite", target: "Research plan", label: "Research plan" },
      { t: "text", s: " and " },
      { t: "cite", target: "Thijs Brouwer", label: "Thijs" },
      { t: "text", s: " or " },
      { t: "cite", target: "Weekly meetings", label: "Weekly meetings › Friday" },
      { t: "text", s: "." },
    ]);
  });

  it("leaves a half-written citation or bold as text while the answer streams", () => {
    expect(parseInline("Three things wait on [[Thijs Bro")).toEqual([{ t: "text", s: "Three things wait on [[Thijs Bro" }]);
    expect(parseInline("It is **late")).toEqual([{ t: "text", s: "It is **late" }]);
  });

  it("reads bold, italic, code and links, and nests a citation inside bold", () => {
    expect(parseInline("**[[Graduation thesis]]** is *on track*, see `due:` and [the site](https://example.org)")).toEqual([
      { t: "b", c: [{ t: "cite", target: "Graduation thesis", label: "Graduation thesis" }] },
      { t: "text", s: " is " },
      { t: "i", c: [{ t: "text", s: "on track" }] },
      { t: "text", s: ", see " },
      { t: "code", s: "due:" },
      { t: "text", s: " and " },
      { t: "link", href: "https://example.org", c: [{ t: "text", s: "the site" }] },
    ]);
  });

  it("keeps snake_case and a lone asterisk as text", () => {
    expect(parseInline("read_note then write_note, 2 * 3")).toEqual([{ t: "text", s: "read_note then write_note, 2 * 3" }]);
    expect(parseInline("set the_var_ now")).toEqual([{ t: "text", s: "set the_var_ now" }]);
    expect(parseInline("an _aside_ here")).toEqual([{ t: "text", s: "an " }, { t: "i", c: [{ t: "text", s: "aside" }] }, { t: "text", s: " here" }]);
  });

  it("reads paragraphs, numbered and bulleted lists, headings, quotes and code", () => {
    const blocks = parseBlocks(
      ["Three things wait on him:", "", "1. Sign the data agreement", "2. The API key,", "   sent yesterday", "", "## Next", "- one", "- two", "", "> quoted", "", "```", "**not bold**", "```"].join("\n"),
    );
    expect(blocks.map((b) => b.t)).toEqual(["p", "ol", "h", "ul", "quote", "code"]);
    const ol = blocks[1] as Extract<(typeof blocks)[number], { t: "ol" }>;
    expect(ol.start).toBe(1);
    expect(ol.items).toHaveLength(2);
    expect(ol.items[1]).toEqual([{ t: "text", s: "The API key,\nsent yesterday" }]);
    expect(blocks[5]).toEqual({ t: "code", s: "**not bold**" });
  });

  it("keeps one list across blank lines between its items", () => {
    const blocks = parseBlocks("1. one\n\n2. two\n\nAfter.");
    expect(blocks.map((b) => b.t)).toEqual(["ol", "p"]);
    expect((blocks[0] as { items: unknown[] }).items).toHaveLength(2);
  });
});
