import { describe, expect, it } from "vitest";
import { NOTHING_KNOWN, kindOf, routeOf, slugOf } from "./links.js";
import { activityOf, companyDomains, documentAt, fileType, names, pathWorthSaying, relationGroups, sizeLabel, turnsOf, wordsIn, worksWith, youOf, type Brief } from "./model.js";

const b = (title: string, type = "note"): Brief => ({ id: `n-${title.toLowerCase().replace(/\W+/g, "-")}`, title, type });
const thesis = b("Graduation thesis", "project");
const westerdok = b("Westerdok", "company");

describe("relations, in words", () => {
  it("strongest first, each note once: Ines supervises the thesis, she is not also 'involved in' it", () => {
    const groups = relationGroups({
      relations: new Map([
        ["involved_in", [thesis, b("Reporting dashboard", "project")]],
        ["works_at", [westerdok]],
        ["supervises", [thesis]],
      ]),
    });
    expect(groups.map((g) => [g.word, g.items.map((i) => i.title)])).toEqual([
      ["supervises", ["Graduation thesis"]],
      ["works at", ["Westerdok"]],
      ["involved in", ["Reporting dashboard"]],
    ]);
  });

  it("two relations that say the same word are one row", () => {
    const groups = relationGroups({ relations: new Map([["involved_in", [thesis]], ["company_involved_in", [b("Lisbon trip", "project")]]]) });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.items.map((i) => i.title)).toEqual(["Graduation thesis", "Lisbon trip"]);
  });

  it("then who they work with, then the notes that mention them and are not said already", () => {
    const groups = relationGroups({
      relations: new Map([["supervises", [thesis]]]),
      worksWith: [{ ...b("Thijs Brouwer", "person"), note: "both on Graduation thesis" }],
      mentions: [thesis, b("Kade drinks")],
      links: [b("Westerdok", "company")],
    });
    expect(groups.map((g) => g.key)).toEqual(["supervises", "works_with", "mentioned_in"]);
    expect(groups[2]!.items.map((i) => i.title)).toEqual(["Kade drinks"]);
  });

  it("without typed relations (no ontology), the note's own links stand in", () => {
    const groups = relationGroups({ relations: new Map(), mentions: [b("Kade drinks")], links: [westerdok, b("Kade drinks")] });
    expect(groups.map((g) => [g.word, g.items.map((i) => i.title)])).toEqual([
      ["mentioned in", ["Kade drinks"]],
      ["links to", ["Westerdok"]],
    ]);
  });

  it("nothing to say is no groups (the page draws no empty box)", () => {
    expect(relationGroups({ relations: new Map(), mentions: [], links: [] })).toEqual([]);
  });
});

describe("works with", () => {
  const entries = [
    { id: "n-ines", relations: [{ relation: "supervises", to: [thesis] }, { relation: "works_at", to: [westerdok] }] },
    { id: "n-thijs", relations: [{ relation: "involved_in", to: [thesis] }] },
    { id: "n-kade", relations: [{ relation: "company_involved_in", to: [thesis] }] },
    { id: "n-emma", relations: [{ relation: "involved_in", to: [b("Lisbon trip", "project")] }] },
  ];
  const people = new Map([
    ["n-ines", "Ines Vermaat"],
    ["n-thijs", "Thijs Brouwer"],
    ["n-emma", "Emma Jansen"],
  ]);
  it("the other people on a project they're on, and which", () => {
    expect(worksWith("n-ines", entries, (id) => people.get(id))).toEqual([{ id: "n-thijs", title: "Thijs Brouwer", type: "person", note: "both on Graduation thesis" }]);
  });
  it("no projects, nobody", () => {
    expect(worksWith("n-nobody", entries, (id) => people.get(id))).toEqual([]);
  });
});

describe("you, and how you know them", () => {
  const contacts = [
    { id: "a", name: "Jules Demo", email: "JULES@basalt.dev" },
    { id: "b", name: "Jules", email: "" },
  ];
  it("you are the person note with your address, else your name", () => {
    expect(youOf(contacts, { email: "jules@basalt.dev", displayName: "Jules" })?.id).toBe("a");
    expect(youOf(contacts, { email: "other@x.dev", displayName: "Jules" })?.id).toBe("b");
    expect(youOf(contacts, { email: "other@x.dev", displayName: "Nobody" })).toBeUndefined();
  });
  it("a path is said only when it is short and not direct", () => {
    const step = { from: b("A", "person"), relation: "works_at", to: b("B", "company") };
    expect(pathWorthSaying([step])).toBe(false);
    expect(pathWorthSaying([step, step])).toBe(true);
    expect(pathWorthSaying([step, step, step, step])).toBe(true);
    expect(pathWorthSaying([step, step, step, step, step])).toBe(false);
    expect(pathWorthSaying(undefined)).toBe(false);
  });
});

describe("activity matches whole names and real domains", () => {
  it("a whole name as words, never a first name alone", () => {
    expect(names("Supervision with Ines Vermaat", "Ines Vermaat")).toBe(true);
    expect(names("Send [[Ines Vermaat]] section 3", "Ines Vermaat")).toBe(true);
    expect(names("Lunch with Ines", "Ines Vermaat")).toBe(false);
    expect(names("Inesvermaat", "Ines Vermaat")).toBe(false);
    expect(names("Kade Social review", "Kade Social")).toBe(true);
  });
  it("a company's mail domains: its site and its people's addresses, never a public one", () => {
    expect([...companyDomains({ website: "https://www.kade.example/jobs" }, [{ email: "thijs@kadesocial.example" }, { email: "noor@example.com" }, { email: "" }])].sort()).toEqual(["kade.example", "kadesocial.example"]);
  });
});

describe("a conversation as turns", () => {
  const body = "**Date:** 2026-10-01\n**Session:** abc\n\n**Jules:** Help me scope it.\nIn one sentence.\n\n**Claude:** Try this:\n\n> One sentence.\n\n```\n**Not:** a speaker\n```\n**Jules:** Too long?";
  it("each speaker's words up to the next, the header lines left out, never the markup", () => {
    const turns = turnsOf(body);
    expect(turns.map((t) => t.speaker)).toEqual(["Jules", "Claude", "Jules"]);
    expect(turns[0]!.text).toBe("Help me scope it.\nIn one sentence.");
    expect(turns[1]!.text).toContain("**Not:** a speaker"); // inside a fence: words, not a turn
    expect(turns.some((t) => t.text.includes("**Jules:**"))).toBe(false);
    expect(wordsIn(turns)).toBeGreaterThan(5);
  });
  it("a header line inside a turn is a fact, not words of the turn", () => {
    expect(turnsOf("**Jules:** hi\n**Session:** abc\nthere")).toEqual([{ speaker: "Jules", text: "hi\nthere" }]);
  });
  it("a note with no speakers has no turns", () => {
    expect(turnsOf("# Just a note\n\nSome words.")).toEqual([]);
  });
});

describe("documents and addresses", () => {
  it("a project's file, a finance file, or a note", () => {
    expect(documentAt("04-Projects/graduation-thesis/files/Research plan.pdf")).toEqual({ kind: "project-file", slug: "graduation-thesis", name: "Research plan.pdf", base: "/api/projects/graduation-thesis/files" });
    expect(documentAt("02-Areas/finance/files/revolut-2026.csv")).toEqual({ kind: "finance-file", name: "revolut-2026.csv", base: "/api/finance/files" });
    expect(documentAt("04-Projects/graduation-thesis/Chapter 1.md")).toEqual({ kind: "note", path: "04-Projects/graduation-thesis/Chapter 1.md" });
    expect(documentAt("04-Projects/graduation-thesis/Chapter 1")).toEqual({ kind: "note", path: "04-Projects/graduation-thesis/Chapter 1.md" });
  });
  it("sizes and types in words", () => {
    expect(sizeLabel(697)).toBe("697 bytes");
    expect(sizeLabel(12_700)).toBe("12 KB");
    expect(sizeLabel(3_400_000)).toBe("3.2 MB");
    expect(fileType("deck.pptx")).toBe("Presentation");
    expect(fileType("x.weird")).toBe("WEIRD");
  });
  it("a note opens at its own page: people, companies, projects, conversations, documents, else Notes", () => {
    const known = { ...NOTHING_KNOWN, people: new Set(["p"]), companies: new Set(["c"]), projects: new Map([["j", "graduation-thesis"]]), conversations: new Set(["t"]) };
    expect(routeOf({ id: "p", path: "Contacts/Ines Vermaat.md" }, known)).toEqual({ kind: "person", slug: "ines-vermaat" });
    expect(routeOf({ id: "c", path: "Contacts/Companies/Kade Social.md" }, known)).toEqual({ kind: "company", slug: "kade-social" });
    expect(routeOf({ id: "j", path: "04-Projects/graduation-thesis.md" }, known)).toEqual({ kind: "project", slug: "graduation-thesis" });
    expect(routeOf({ id: "t", path: "07-Claude/Scoping the question.md" }, known)).toEqual({ kind: "conversation", slug: "scoping-the-question" });
    expect(routeOf({ id: "d", path: "04-Projects/x/Chapter 1.md", type: "document" }, known)).toEqual({ kind: "document", path: "04-Projects/x/Chapter 1.md" });
    expect(routeOf({ id: "n", path: "Shared/Kade drinks.md" }, known)).toEqual({ kind: "notes", path: "Shared/Kade drinks" });
    expect(kindOf({ id: "x", type: "conversation" }, NOTHING_KNOWN)).toBe("conversation");
    expect(slugOf("Contacts/Élodie Fàbregas.md")).toBe("elodie-fabregas");
  });
});

describe("what is going on with them", () => {
  const who = { names: ["Ines Vermaat"], addresses: ["Ines@Westerdok.example"], domains: new Set<string>() };
  const mail = (uid: number, from: string, date: string) => ({ uid, from, fromName: "", subject: `m${uid}`, date, seen: false });
  it("their mail by exact address, newest first; events and open steps that name them, soonest first", () => {
    const a = activityOf(
      {
        mail: [mail(1, "ines@westerdok.example", "2026-10-01"), mail(2, "other@westerdok.example", "2026-10-09"), mail(3, "INES@westerdok.example", "2026-10-08")],
        events: [
          { title: "Supervision with Ines Vermaat", date: "2026-10-21", startMin: 960 },
          { title: "Lunch with Ines", date: "2026-10-12", startMin: 720 },
          { title: "Ines Vermaat: defence rehearsal", date: "2026-10-14", startMin: 600 },
        ],
        tasks: [
          { text: "Send Ines Vermaat section 3", status: "todo", due: "2026-10-16" },
          { text: "Thank Ines Vermaat", status: "done", due: "2026-10-01" },
          { text: "Ask [[Ines Vermaat]] for a date", status: "in-progress" },
        ],
      },
      who,
    );
    expect(a.mail.map((m) => m.uid)).toEqual([3, 1]);
    expect(a.events.map((e) => e.date)).toEqual(["2026-10-14", "2026-10-21"]);
    expect(a.tasks.map((t) => t.text)).toEqual(["Send Ines Vermaat section 3", "Ask [[Ines Vermaat]] for a date"]);
  });
  it("a company's mail by its domains", () => {
    const a = activityOf({ mail: [mail(1, "thijs@kadesocial.example", "2026-10-01"), mail(2, "x@elsewhere.example", "2026-10-02")], events: null, tasks: null }, { names: ["Kade Social"], addresses: [], domains: new Set(["kadesocial.example"]) });
    expect(a.mail.map((m) => m.uid)).toEqual([1]);
  });
});
