/** A note whose title is only an id is shown by its kind, date and gist (F3). */
import { describe, expect, it } from "vitest";
import { VaultIndex, buildGraph, displayTitle, isIdTitle, parseNote, parseOntology, ONTOLOGY_TEMPLATE } from "../src/index.js";

const shown = (content: string, fallback = "x", extra: { id?: string; mtimeMs?: number } = {}) => {
  const p = parseNote(content, fallback);
  return displayTitle({ ...p, ...extra, content });
};

const SESSION = "---\ntitle: 394a1725\ntype: claude-session\ndate: 2026-06-04\ndescription: Tidying the reading list for the literature review\n---\n**Jules:** Can you tidy it?\n";

describe("isIdTitle", () => {
  it("a session id, a uuid or the note's own id is an id", () => {
    expect(isIdTitle("394a1725")).toBe(true);
    expect(isIdTitle("c0ffee12-bead")).toBe(true);
    expect(isIdTitle("3f2a9c1e-5b7d-4e2a-9c1f-0a1b2c3d4e5f")).toBe(true);
    expect(isIdTitle("n-mv44vlqv01p1pp")).toBe(true);
    expect(isIdTitle("anything", "anything")).toBe(true);
  });
  it("a real title is not, and nor is a word or a number that happens to be hex", () => {
    for (const t of ["Scoping the question", "facade", "Decade", "cafe-babe", "2026-10", "20261014", "deadbeef", "Q3 review", "", "394a172"]) expect(isIdTitle(t)).toBe(false);
  });
});

describe("displayTitle", () => {
  it("an id title is the kind, the date and the start of the gist", () => {
    expect(shown(SESSION)).toBe("Conversation, 4 Jun 2026: Tidying the reading list for the literature review");
  });
  it("a long gist is cut at a word, with an ellipsis", () => {
    const long = SESSION.replace("Tidying the reading list for the literature review", "Tidying the reading list for the literature review and tagging every source by chapter and year");
    const t = shown(long);
    expect(t).toBe("Conversation, 4 Jun 2026: Tidying the reading list for the literature review and…");
    expect(t.length).toBeLessThan(90);
  });
  it("without a description the gist is the conversation's opening; without a date, created: or the file's day", () => {
    const n = "---\ntitle: 394a1725\ntype: claude-session\ncreated: 2026-09-12T10:00:00Z\n---\n**Jules:** Remind me what Lotte asked.\n";
    expect(shown(n)).toBe("Conversation, 12 Sep 2026: Remind me what Lotte asked");
    const bare = "---\ntype: claude-session\n---\n**Jules:** Hello there\n";
    expect(shown(bare, "c0ffee12-bead", { mtimeMs: new Date(2026, 8, 12, 12).getTime() })).toBe("Conversation, 12 Sep 2026: Hello there");
  });
  it("an ordinary note titled by its own id says Note; with nothing to say, the kind and date alone", () => {
    expect(shown("---\nid: n-abc12345xy\ntitle: n-abc12345xy\ndate: 2026-10-01\n---\nGroceries for the week.\n", "x", { id: "n-abc12345xy" })).toBe("Note, 1 Oct 2026: Groceries for the week");
    expect(shown("---\ntitle: 394a1725\ndate: 2026-10-01\n---\n# Heading only\n")).toBe("Note, 1 Oct 2026");
  });
  it("a real title, and a title that only looks like hex, are shown as written", () => {
    expect(shown("---\ntitle: Scoping the question\ntype: conversation\ndate: 2026-10-01\n---\n**Jules:** Help me scope it.\n")).toBe("Scoping the question");
    expect(shown("---\ntitle: facade\n---\nNotes on the facade of the flat.\n")).toBe("facade");
    expect(shown("Body.\n", "Decade")).toBe("Decade");
  });
});

describe("the index shows names, and keeps the written title for links and search", () => {
  const index = () =>
    new VaultIndex([
      { path: "Claude Sessions/394a1725.md", content: SESSION, id: "n-s1" },
      { path: "Claude Sessions/c0ffee12-bead.md", content: "---\ntype: claude-session\ndate: 2026-09-12\n---\n**Jules:** Remind me about the filters.\n", id: "n-s2" },
      { path: "Shared/Facade.md", content: "---\ntitle: facade\n---\nThe facade.\n", id: "n-f" },
      { path: "Shared/Plan.md", content: "See [[394a1725]] and [[c0ffee12-bead]], and 394a1725 again.\n", id: "n-p" },
      { path: "Claude Sessions/old chat.md", content: "---\ntitle: 7f3e9a21\ntype: claude-session\n---\n**Jules:** Hello.\n", id: "n-s3" },
    ]);
  it("every name the index hands out is the display name; the file is not touched", () => {
    const v = index();
    expect(v.get("n-s1")!.title).toBe("Conversation, 4 Jun 2026: Tidying the reading list for the literature review");
    expect(v.get("n-s1")!.writtenTitle).toBe("394a1725");
    expect(v.get("n-s1")!.content).toBe(SESSION);
    expect(v.get("n-s2")!.title).toBe("Conversation, 12 Sep 2026: Remind me about the filters");
    expect(v.get("n-f")!.title).toBe("facade");
    expect(v.get("n-f")!.writtenTitle).toBeUndefined();
    expect(v.backlinks("n-s1").map((b) => b.fromTitle)).toEqual(["Plan"]);
  });
  it("a link by the id still finds the note, and so does a search for it", () => {
    const v = index();
    expect(v.resolveLink("394a1725")?.id).toBe("n-s1");
    expect(v.resolveLink("c0ffee12-bead")?.id).toBe("n-s2");
    expect(v.resolveLink("7f3e9a21")?.id).toBe("n-s3"); // by the title it writes, not its file name
    expect(v.search("394a1725").map((h) => h.id)[0]).toBe("n-s1"); // its written title still ranks it first
  });
  it("the graph and its warnings name the note by its display name", () => {
    const v = index();
    const ontology = parseOntology(ONTOLOGY_TEMPLATE);
    const g = buildGraph(v, ontology);
    const name = "Conversation, 4 Jun 2026: Tidying the reading list for the literature review";
    expect(g.entities.get("n-s1")?.title).toBe(name);
    const about = g.warnings.filter((w) => w.note === "n-s1").map((w) => w.message);
    expect(about.length).toBeGreaterThan(0);
    for (const m of about) expect(m.startsWith(name)).toBe(true);
    expect(JSON.stringify(g.warnings)).not.toContain("394a1725 ");
  });
});
