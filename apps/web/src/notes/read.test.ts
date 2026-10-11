/**
 * What the Notes page says about a note, read off its text (structure.md §2.3): its length, its
 * due date, its pin, whether it is an ordinary note (§8 #7), a backlink's line, a relation's words.
 */
import { describe, expect, it } from "vitest";
import { filterNotes } from "../FileTree.js";
import { dueOf, editedLabel, isOrdinary, pinnedIn, relationWords, snippet, wordCount } from "./read.js";

describe("wordCount", () => {
  it("counts the body's words, not the front matter, the Markdown marks or the code", () => {
    const note = "---\ntitle: A long title here\ntags: [x]\n---\n# Heading two\n\n- [ ] Call [[Ines Vermaat|Ines]] **today**\n\n```\nnot words at all\n```\n";
    expect(wordCount(note)).toBe(5); // Heading two Call Ines today
  });
});

describe("dueOf and pinnedIn", () => {
  it("reads deadline or due, and a pin, from the front matter only", () => {
    expect(dueOf("---\ndeadline: 2026-10-19\n---\nbody")).toBe("2026-10-19");
    expect(dueOf("---\ndue: 2026-11-01\n---\n")).toBe("2026-11-01");
    expect(dueOf("body due:2026-10-19")).toBeNull();
    expect(pinnedIn("---\npinned: true\n---\n")).toBe(true);
    expect(pinnedIn("---\npinned: false\n---\n")).toBe(false);
    expect(pinnedIn("pinned: true")).toBe(false);
  });
});

describe("isOrdinary: where Make this a project belongs (§8 #7)", () => {
  const n = (content: string, tags: string[] = []) => ({ content, tags: tags.map((tag) => ({ tag })) });
  it("an ordinary note, yes", () => {
    expect(isOrdinary(n("# Ideas"), { project: false })).toBe(true);
    expect(isOrdinary(n("# Ideas"), { project: false, type: "note" })).toBe(true);
  });
  it("a project, a person, a company, a conversation, the ontology or a typed note, no", () => {
    expect(isOrdinary(n("# P"), { project: true })).toBe(false);
    expect(isOrdinary(n("# P", ["project/thesis"]), { project: false })).toBe(false);
    expect(isOrdinary(n("# Ines", ["contact"]), { project: false })).toBe(false);
    expect(isOrdinary(n("# Kade", ["company"]), { project: false })).toBe(false);
    expect(isOrdinary(n("# O", ["vault-ontology"]), { project: false })).toBe(false);
    expect(isOrdinary(n("---\ntype: claude-session\n---\nchat"), { project: false })).toBe(false);
    expect(isOrdinary(n("# Ines"), { project: false, type: "person" })).toBe(false);
  });
});

describe("snippet, relationWords, editedLabel", () => {
  it("a backlink's line is one clean line: links as words, no marks", () => {
    expect(snippet("- [ ] see the [[Research plan|plan]] and [[Ines Vermaat]]  \n")).toBe("see the plan and Ines Vermaat");
    expect(snippet("## The [[Research plan]] is due")).toBe("The Research plan is due");
  });
  it("relation ids read as words", () => {
    expect(relationWords("works_at")).toBe("works at");
    expect(relationWords("supervised_by")).toBe("supervised by");
  });
  it("an edit time is short: a time today, a weekday this week, a date before", () => {
    const now = new Date(2026, 9, 11, 15, 0);
    expect(editedLabel(new Date(2026, 9, 11, 9, 52).getTime(), now)).toBe("09:52");
    expect(editedLabel(new Date(2026, 9, 6, 12, 0).getTime(), now)).toBe("Tue");
    expect(editedLabel(new Date(2026, 9, 2, 12, 0).getTime(), now)).toBe("2 Oct");
  });
});

describe("the tree's filter", () => {
  const t = (title: string, path: string, tags: string[] = []) => ({ id: title, title, path, folder: "", tags, openTasks: 0, category: "other", hash: "", mtimeMs: 0 });
  it("matches title or path, and #tag by tag (a tag chip filters this way)", () => {
    const notes = [t("Research plan", "04-Projects/x/Research plan.md", ["thesis", "research"]), t("Thesis budget", "Money/Thesis budget.md"), t("Other", "Other.md", ["thesis/old"])];
    expect(filterNotes(notes, "thesis").map((n) => n.id)).toEqual(["Thesis budget"]);
    expect(filterNotes(notes, "#thesis").map((n) => n.id)).toEqual(["Research plan", "Other"]);
    expect(filterNotes(notes, "#res").map((n) => n.id)).toEqual([]);
  });
});
