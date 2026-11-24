import { describe, expect, it } from "vitest";
import { mailMarkdown, mailSafe } from "../src/mailText.js";
import { parseNote } from "../src/parse.js";

describe("mail text as Markdown (N1)", () => {
  it("reads as the mail does, and adds no task, tag, link or heading to a note", () => {
    const md = mailMarkdown("# Hello\n- [ ] buy milk #sale\n1. [x] done [[Secret]]\n> - [ ] quoted\nSee https://shop.example/a(b)?x=1 now\n[https://cdn.example/hero.png]\n\n\n\nBye");
    expect(md).toBe("\\# Hello\n- \\[ ] buy milk \\#sale\n1. \\[x] done \\[\\[Secret\\]\\]\n> - \\[ ] quoted\nSee [shop.example](https://shop.example/a)(b)?x=1 now\n\nBye");
    const n = parseNote(`---\ntitle: x\n---\n${md}\n`, "x");
    expect([n.tasks.length, n.tags.length, n.links.length, n.headings.length]).toEqual([0, 0, 0, 0]);
  });

  it("leaves a # inside a word alone", () => {
    expect(mailSafe("issue#4 and C# and (#tag)")).toBe("issue#4 and C# and (\\#tag)");
  });
});
