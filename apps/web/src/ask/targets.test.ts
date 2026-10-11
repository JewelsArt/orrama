import { describe, expect, it } from "vitest";
import { citedNote, contextNoteOf, noteRoute, targetRoute, type Vault } from "./targets.js";

const V: Vault = {
  tree: [
    { id: "n-thesis", path: "04-Projects/graduation-thesis.md", title: "Graduation thesis", tags: ["project", "project/graduation-thesis"] },
    { id: "n-thijs", path: "Contacts/Thijs Brouwer.md", title: "Thijs Brouwer", tags: ["contact"] },
    { id: "n-kade", path: "Contacts/Companies/Kade Social.md", title: "Kade Social", tags: ["company"] },
    { id: "n-weekly", path: "Shared/Weekly meetings.md", title: "Weekly meetings", tags: [] },
    { id: "n-plan", path: "04-Projects/graduation-thesis/Research plan.md", title: "The research plan", tags: ["project/graduation-thesis"] },
  ],
  projects: [{ slug: "graduation-thesis", noteId: "n-thesis" }],
};

describe("where a name in Ask Orr leads", () => {
  it("opens a note as what it is: project, person, company or note", () => {
    expect(noteRoute("n-thesis", V)).toEqual({ kind: "project", slug: "graduation-thesis" });
    expect(noteRoute("n-thijs", V)).toEqual({ kind: "person", slug: "thijs-brouwer" });
    expect(noteRoute("n-kade", V)).toEqual({ kind: "company", slug: "kade-social" });
    expect(noteRoute("n-weekly", V)).toEqual({ kind: "notes", path: "Shared/Weekly meetings" });
    // Not in the tree (yet): opened by its id, which the app turns into its address.
    expect(noteRoute("n-new", V)).toEqual({ kind: "notes", id: "n-new" });
  });

  it("opens mail, drafts and days in their places", () => {
    expect(targetRoute({ kind: "mail", uid: 7 }, V)).toEqual({ kind: "mail", id: "7" });
    expect(targetRoute({ kind: "waiting" }, V)).toEqual({ kind: "mail", waiting: true });
    expect(targetRoute({ kind: "day", date: "2026-10-16" }, V)).toEqual({ kind: "planning", scale: "day", at: "2026-10-16" });
    expect(targetRoute({ kind: "project", slug: "lisbon-trip" }, V)).toEqual({ kind: "project", slug: "lisbon-trip" });
  });
});

describe("the note the page is about (AI-012)", () => {
  it("is the open note, the project's note, the person's or the company's", () => {
    expect(contextNoteOf({ kind: "notes", path: "Shared/Weekly meetings" }, V)).toBe("n-weekly");
    expect(contextNoteOf({ kind: "notes", id: "n-plan" }, V)).toBe("n-plan");
    expect(contextNoteOf({ kind: "project", slug: "graduation-thesis", tab: "timeline" }, V)).toBe("n-thesis");
    expect(contextNoteOf({ kind: "person", slug: "thijs-brouwer" }, V)).toBe("n-thijs");
    expect(contextNoteOf({ kind: "company", slug: "kade-social" }, V)).toBe("n-kade");
  });

  it("is nothing on a page that is not about one note", () => {
    expect(contextNoteOf({ kind: "today" }, V)).toBeUndefined();
    expect(contextNoteOf({ kind: "notes" }, V)).toBeUndefined();
    expect(contextNoteOf({ kind: "people" }, V)).toBeUndefined();
    // A person slug that happens to match a note that is not a contact is not that person.
    expect(contextNoteOf({ kind: "person", slug: "weekly-meetings" }, V)).toBeUndefined();
  });
});

describe("the note a [[citation]] names", () => {
  it("is first the note Orr read under that name, then the vault's path, file name or title", () => {
    // Orr read "Plan" as n-plan; the vault alone has no note by that name.
    expect(citedNote("Plan", [{ target: "Plan", targetId: "n-plan" }], V)).toBe("n-plan");
    expect(citedNote("Plan", [], V)).toBeNull();
    expect(citedNote("Research plan", [], V)).toBe("n-plan"); // its file name
    expect(citedNote("the research plan", [], V)).toBe("n-plan"); // its title
    expect(citedNote("Shared/Weekly meetings", [], V)).toBe("n-weekly");
    expect(citedNote("Nowhere", [], V)).toBeNull();
  });
});
