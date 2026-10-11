/**
 * The plain-text reading of a mail (CLAUDE.md "Reading mail": image-only lines dropped, links
 * by host). WEB-021: a global regex's lastIndex leaked from one line's test into the next, so an
 * image-only line right after an ordinary link survived, and the result depended on line order.
 */
import { describe, expect, it } from "vitest";
import { isImageOnly, plainLines } from "./plainText.js";

const STORY = "Read the full story: https://news.example.com/articles/2026/10/02/a-long-tracking-path?utm_source=mail";
const HERO = "[https://cdn.example.com/i/hero.png]";

describe("plain-text mail", () => {
  it("drops an image-only line whatever the line before it (WEB-021)", () => {
    expect(plainLines([STORY, HERO].join("\n"))).toHaveLength(1);
    expect(plainLines([HERO, STORY].join("\n"))).toHaveLength(1);
    expect(plainLines([STORY, STORY, HERO, HERO].join("\n"))).toHaveLength(2);
  });

  it("asks the same question twice and gets the same answer", () => {
    expect([isImageOnly(STORY), isImageOnly(HERO), isImageOnly(HERO), isImageOnly(STORY)]).toEqual([false, true, true, false]);
  });

  it("keeps a line with words beside an image URL, and a bare image URL goes too", () => {
    expect(isImageOnly("See https://cdn.example.com/i/map.png for the route")).toBe(false);
    expect(isImageOnly("  https://cdn.example.com/i/pixel.gif?u=1  ")).toBe(true);
  });

  it("labels a link by its host and keeps the full URL on the href", () => {
    const [line] = plainLines(STORY);
    expect(line).toEqual(["Read the full story: ", { href: STORY.slice(21), label: "news.example.com" }]);
  });

  it("takes the brackets off a bracketed link", () => {
    expect(plainLines("Agenda [https://www.westerdok.example/agenda] attached")).toEqual([["Agenda ", { href: "https://www.westerdok.example/agenda", label: "westerdok.example" }, " attached"]]);
  });

  it("keeps empty lines as the gaps between paragraphs", () => {
    expect(plainLines("Hi Jules,\n\nSee you Friday.")).toEqual([["Hi Jules,"], [], ["See you Friday."]]);
  });
});
