import { describe, expect, it } from "vitest";
import type { CalEvent, Contact, DashboardTask, GraphRelations, ProjectRow } from "@orrama/schema/responses";
import { boxState, comingUp, dueGroups, moneyPace, peopleToday, projectsInMotion, relationLine, taskKey, weekEnd } from "./model.js";

const TODAY = "2026-10-08"; // a Thursday

let line = 0;
const task = (text: string, o: Partial<DashboardTask> = {}): DashboardTask => ({
  line: line++,
  checked: false,
  status: "todo",
  text,
  raw: `- [ ] ${text}`,
  indent: 0,
  noteId: "n-thesis",
  notePath: "04-Projects/thesis.md",
  noteTitle: "Graduation thesis",
  project: "Graduation thesis",
  object: null,
  ...o,
});

describe("Due", () => {
  const tasks = [
    task("Dashboard review with Thijs", { key: true, due: "2026-10-09", project: "Reporting dashboard" }),
    task("Research plan submitted", { key: true, due: "2026-10-19" }),
    task("Refine research question", { due: TODAY, status: "in-progress" }),
    task("Cover letter", { project: "Traineeship applications" }),
    task("Ask Thijs to sign", { due: "2026-10-05" }),
    task("Pull 3 years of reach data", { due: "2026-10-04", status: "blocked" }),
    task("Old key deadline, missed", { key: true, due: "2026-10-01" }),
    task("Calculated fields", { due: "2026-10-09" }),
    task("Weekend run", { due: "2026-10-11" }),
    task("Next week", { due: "2026-10-12" }),
    task("Done already", { due: TODAY, checked: true, status: "done" }),
  ];
  const cover = tasks[3]!;
  const g = dueGroups(tasks, TODAY, new Map([[taskKey(cover), { start: 14 * 60, end: 16 * 60 }]]));

  it("lifts the next key deadline still ahead, never a missed one", () => {
    expect(g.key?.text).toBe("Dashboard review with Thijs");
    expect(g.key?.days).toBe(1);
  });
  it("Today holds what is due today and what is booked today, booked first", () => {
    expect(g.today.map((t) => t.text)).toEqual(["Cover letter", "Refine research question"]);
    expect(g.today[0]!.booked).toEqual({ start: 840, end: 960 });
  });
  it("Late is least late first, a missed key deadline included", () => {
    expect(g.late.map((t) => [t.text, t.days])).toEqual([
      ["Ask Thijs to sign", 3],
      ["Pull 3 years of reach data", 4],
      ["Old key deadline, missed", 7],
    ]);
  });
  it("Later this week runs to Sunday and skips the key row", () => {
    expect(g.later.map((t) => t.text)).toEqual(["Calculated fields", "Weekend run"]);
  });
  it("counts this week's work, late included", () => {
    expect(g.count).toBe(2 + 3 + 2 + 1);
  });
  it("Sunday is the end of the week", () => {
    expect(weekEnd(TODAY)).toBe("2026-10-11");
    expect(weekEnd("2026-10-11")).toBe("2026-10-11");
    expect(weekEnd("2026-10-12")).toBe("2026-10-18");
  });
  it("draws the box from the line's own mark", () => {
    expect([boxState("todo"), boxState("in-progress"), boxState("blocked"), boxState("done")]).toEqual(["open", "progress", "blocked", "done"]);
  });
});

const project = (o: Partial<ProjectRow>): ProjectRow => ({
  slug: "x", key: "project/x", name: "X", domain: null, noteId: null, total: 4, done: 1, status: null, start: null, deadline: null, group: null, nextDue: null, overdue: 0, ...o,
});

describe("Coming up", () => {
  const ev = (o: Partial<CalEvent>): CalEvent => ({ id: "e", ownerId: "u", username: "jules", mine: true, title: "Event", date: TODAY, startMin: 600, durationMin: 60, ...o });
  it("is the next three weeks of events, key deadlines and project dates, soonest first", () => {
    const key = task("Race day", { key: true, due: "2026-10-18" });
    const rows = comingUp(
      {
        events: [ev({ id: "1", title: "Interview", date: "2026-10-12", startMin: 660 }), ev({ id: "2", title: "Today's", date: TODAY }), ev({ id: "3", title: "Far", date: "2026-11-30" })],
        tasks: [key, task("Plain due date", { due: "2026-10-13" }), task("Shown in Due already", { key: true, due: "2026-10-09" })],
        projects: [project({ slug: "thesis", name: "Graduation thesis", deadline: "2026-10-19" }), project({ slug: "done", name: "Done", deadline: "2026-10-20", status: "done" })],
      },
      TODAY,
      new Set([`n-thesis:${line - 1}`]),
    );
    expect(rows.map((r) => [r.date, r.kind, r.title])).toEqual([
      ["2026-10-12", "event", "Interview"],
      ["2026-10-18", "key", "Race day"],
      ["2026-10-19", "milestone", "Graduation thesis due"],
    ]);
  });
});

describe("Projects", () => {
  it("are the active ones, soonest date first, undated last", () => {
    const rows = projectsInMotion([
      project({ slug: "a", name: "A" }),
      project({ slug: "b", name: "B", nextDue: "2026-10-20" }),
      project({ slug: "c", name: "C", deadline: "2026-10-12", nextDue: "2026-10-30" }),
      project({ slug: "d", name: "D", total: 2, done: 2 }),
      project({ slug: "e", name: "E", status: "paused" }),
    ]);
    expect(rows.map((p) => [p.slug, p.when])).toEqual([
      ["c", "2026-10-12"],
      ["b", "2026-10-20"],
      ["a", null],
    ]);
  });
});

describe("People today", () => {
  const c = (name: string, email = ""): Contact => ({ id: `c-${name}`, name, path: `Contacts/${name}.md`, sector: "", role: "", company: "", email, phone: "", linkedin: "", personal: false });
  const contacts = [c("Emma Jansen", "emma@example.com"), c("Ines Vermaat", "ines@westerdok.example"), c("Thijs Brouwer"), c("Emma")];
  it("are whole names in today's events and senders of today's unread mail, never a first name alone", () => {
    const people = peopleToday({
      events: [
        { title: "Lunch with Emma", start: 750 },
        { title: "Review with Thijs Brouwer", start: 900 },
        { title: "Coffee, emma jansen", start: 600 },
      ],
      mail: [
        { from: "INES@westerdok.example", uid: 7, ms: 1 },
        { from: "emma@example.com", uid: 8, ms: 2 },
        { from: "stranger@example.com", uid: 9, ms: 3 },
      ],
      contacts,
    });
    expect(people.map((p) => [p.contact.name, p.via, p.what])).toEqual([
      ["Emma Jansen", "event", "Coffee, emma jansen"],
      ["Thijs Brouwer", "event", "Review with Thijs Brouwer"],
      ["Ines Vermaat", "mail", "wrote to you"],
    ]);
  });
  it("needs a word boundary: Thijs Brouwers is someone else", () => {
    expect(peopleToday({ events: [{ title: "Call Thijs Brouwers", start: 600 }], mail: [], contacts })).toEqual([]);
  });
});

describe("the graph, in words", () => {
  const rel = (relations: GraphRelations["relations"]): GraphRelations => ({ entity: { id: "p", title: "Ines Vermaat", type: "person", summary: "", fields: {} }, relations, warnings: [] });
  const to = (title: string, type: string) => ({ id: title, title, type, via: "field" as const, where: "", source: { id: "p", title: "Ines Vermaat" } });
  it("prefers a relation to a project", () => {
    expect(relationLine(rel([{ relation: "works_at", to: [to("Westerdok", "company")] }, { relation: "supervises", to: [to("Graduation thesis", "project")] }]))).toEqual({
      relation: "supervises",
      to: { id: "Graduation thesis", title: "Graduation thesis", type: "project" },
    });
    expect(relationLine(rel([{ relation: "works_at", to: [to("Westerdok", "company")] }]))?.relation).toBe("works at");
  });
  it("says nothing when the graph knows nothing", () => {
    expect(relationLine(rel([]))).toBeNull();
    expect(relationLine(null)).toBeNull();
  });
});

describe("Money", () => {
  const spending = { month: "2026-09", total: 1210, typical: 1180, categories: [], running: null, savings: { target: 0, surplus: 0, trimmable: 0, observed: null, targetRate: null, top: [] }, basedOn: 5 };
  it("is the month in progress when the statement reaches into it", () => {
    expect(moneyPace({ ...spending, running: { month: "2026-10", total: 412, dayOf: 8, daysIn: 31 } })).toEqual({ month: "2026-10", spent: 412, typical: 1180, dayOf: 8, daysIn: 31 });
  });
  it("is the last complete month otherwise, and nothing without a statement", () => {
    expect(moneyPace(spending)).toEqual({ month: "2026-09", spent: 1210, typical: 1180, dayOf: null, daysIn: null });
    expect(moneyPace(null)).toBeNull();
  });
});
