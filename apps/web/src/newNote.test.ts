/**
 * The "New …" flows create, never upsert (audit WEB-001), and their templates
 * are valid front matter whatever the name holds.
 */
import { parseNote } from "@orrama/core";
import { describe, expect, it, vi } from "vitest";

vi.stubGlobal("localStorage", { getItem: () => "t-abc", setItem: () => {}, removeItem: () => {} });
vi.stubGlobal("window", new EventTarget());
const sent: { method: string; url: string; body: Record<string, unknown> }[] = [];
let answer: () => Response = () => new Response(JSON.stringify({ id: "n-1", path: "x.md" }));
vi.stubGlobal("fetch", async (url: string, init: { method: string; body: string }) => {
  sent.push({ method: init.method, url, body: JSON.parse(init.body) });
  return answer();
});

const { blankNote, companyNote, contactNote, createNote } = await import("./newNote.js");

describe("createNote", () => {
  it("asks the server for create-only", async () => {
    await createNote("Ideas/Reading list.md", blankNote("Reading list"));
    expect(sent.at(-1)).toMatchObject({ method: "PUT", url: "/api/vault/note", body: { path: "Ideas/Reading list.md", create: true } });
  });

  it("a taken path is an error carrying the server's words, for the form to show", async () => {
    answer = () => new Response(JSON.stringify({ error: "A note already exists at Contacts/Jan.md." }), { status: 409 });
    await expect(createNote("Contacts/Jan.md", "x")).rejects.toThrow("A note already exists at Contacts/Jan.md.");
  });
});

describe("templates", () => {
  const tricky = 'Smith: "Consulting" #1 [eu]';

  it("a contact's fields read back exactly", () => {
    const note = parseNote(
      contactNote({ name: tricky, sector: "", role: "CEO: interim", company: "A, B & C", email: "a@b.c", phone: "+31 6", linkedin: "in/x" }),
      "fallback",
    );
    expect(note.title).toBe(tricky);
    expect(note.frontmatter).toMatchObject({ sector: "Other", role: "CEO: interim", company: "A, B & C", email: "a@b.c" });
    expect(note.tags.map((t) => t.tag)).toContain("contact");
    expect(contactNote({ name: "x", sector: "", role: "", company: "", email: "", phone: "", linkedin: "" })).toContain("\ntags: [contact]\n");
  });

  it("a company's fields read back exactly", () => {
    const note = parseNote(
      companyNote({ name: tricky, sector: "Finance", description: 'says "hi": twice', linkedin: "", website: "", careers: "", location: "Paris", positions: ["a: b", "c"] }),
      "fallback",
    );
    expect(note.title).toBe(tricky);
    expect(note.frontmatter).toMatchObject({ description: 'says "hi": twice', positions: ["a: b", "c"], location: "Paris" });
    expect(note.tags.map((t) => t.tag)).toContain("company");
  });

  it("a blank note's title reads back exactly", () => {
    expect(parseNote(blankNote("Q3: plan"), "fallback").title).toBe("Q3: plan");
  });
});
