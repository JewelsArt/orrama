/**
 * Cmd-click on a wiki link opens the note the link names (WEB-007): `[[Target|alias]]`,
 * `[[folder/Target]]` and `[[Target#Heading|alias]]` all open Target. The label is what the
 * reader sees; the target is what was resolved.
 */
import { describe, expect, it } from "vitest";
import { wikiLinks } from "../livePreview.js";
import { noteForLink } from "./links.js";

describe("wikiLinks: what the preview hides, marks and follows", () => {
  it("keeps the target apart from the label for every form", () => {
    const line = "see [[Graduation Thesis|thesis]], [[02-Areas/finance/Budget]] and [[Target#Plan|the plan]]";
    expect(wikiLinks(line).map((l) => [l.label, l.target, l.heading])).toEqual([
      ["thesis", "Graduation Thesis", undefined],
      ["02-Areas/finance/Budget", "02-Areas/finance/Budget", undefined],
      ["the plan", "Target", "Plan"],
    ]);
  });

  it("marks exactly the label, also when the alias starts with spaces", () => {
    const line = "[[Note|  My alias]] and [[Plain]]";
    const [a, b] = wikiLinks(line, 100);
    expect(line.slice(a!.labelFrom - 100, a!.labelTo - 100)).toBe("My alias");
    expect(line.slice(b!.labelFrom - 100, b!.labelTo - 100)).toBe("Plain");
    expect([a!.from, a!.to]).toEqual([100, 100 + "[[Note|  My alias]]".length]);
  });
});

describe("noteForLink: the server's resolution first, then the tree", () => {
  const tree = [
    { id: "t", path: "04-Projects/Graduation Thesis.md", title: "Graduation Thesis" },
    { id: "b", path: "02-Areas/finance/Budget.md", title: "Monthly budget" },
    { id: "x", path: "Inbox/thesis.md", title: "thesis" }, // a note titled like the alias
  ];

  it("an aliased link opens its target, not a note titled like the alias", () => {
    const links = [{ target: "Graduation Thesis", targetId: "t", locked: false }];
    expect(noteForLink("Graduation Thesis", links, tree)).toBe("t");
  });

  it("a path link opens the note at that path", () => {
    expect(noteForLink("02-Areas/finance/Budget", [], tree)).toBe("b");
    expect(noteForLink("Budget", [], tree)).toBe("b"); // by file name
  });

  it("a locked target opens nothing, and an unresolved one falls back to the tree", () => {
    expect(noteForLink("Secret", [{ target: "Secret", targetId: null, locked: true }], [{ id: "s", path: "Secret.md", title: "Secret" }])).toBeNull();
    expect(noteForLink("monthly budget", [], tree)).toBe("b");
  });
});
