/** Planning's model: one item vocabulary, the lanes, To plan's cuts, Orr's words, the window. */
import { describe, expect, it } from "vitest";
import { event, marker, task } from "../test/planning-fixtures.js";
import {
  CALENDAR_LANE,
  DATED_LANE,
  buildItems,
  dueCounts,
  dueWords,
  firstScroll,
  nextWeeks,
  nowAlong,
  proposalWords,
  toPlanCuts,
  weekLanes,
  windowFor,
  type Proposal,
} from "./model.js";

const areas: Record<string, string> = { "n-thesis": "school", "n-report": "work", "n-errands": "personal" };
const areaOf = (id: string) => areas[id] ?? "personal";
const week = { from: "2026-10-05", to: "2026-10-11" };

describe("one vocabulary for every time view", () => {
  const items = buildItems({
    tasks: [
      task({ text: "Refine research question", blocks: [{ id: "blk-1", date: "2026-10-05", startMin: 600, durationMin: 120 }], due: "2026-10-04" }),
      task({ noteId: "n-report", line: 3, text: "Router label rules", blocks: [{ id: "blk-2", date: "2026-10-30", startMin: 600, durationMin: 90 }] }),
    ],
    events: [
      event({ id: "ev-1", date: "2026-10-07", title: "Supervision, Ines" }),
      event({ id: "ics-1", date: "2026-10-08", title: "Thesis workshop", source: "ics", readonly: true, feedLabel: "Westerdok", mine: false }),
      event({ id: "ev-2", date: "2026-10-09", title: "Open day", allDay: true }),
    ],
    markers: [
      marker({ id: "d1", date: "2026-10-05", title: "Ask Thijs to sign", overdue: true }),
      marker({ id: "d2", date: "2026-10-09", title: "Summarise MASE vs MAPE" }),
      marker({ id: "k1", date: "2026-10-09", title: "Dashboard review with Thijs", key: true, noteId: "n-report", line: 9 }),
      marker({ id: "c1", date: "2026-10-08", title: "Adobe CC", kind: "charge", amount: -19.66, currency: "EUR", noteId: "n-subs", line: null }),
      marker({ id: "m1", date: "2026-10-10", title: "Graduation thesis due", kind: "milestone", line: null }),
    ],
    proposals: [{ noteId: "n-report", line: 7, blockId: null, text: "Build the October slides", project: "Maison Verlaine", due: "2026-10-10", atRisk: false, date: "2026-10-09", startMin: 780, durationMin: 120, estimateHours: 2 }],
    areaOf,
    ...week,
  });
  const kind = (title: string) => items.find((i) => i.title === title)?.kind;
  const lane = (title: string) => items.find((i) => i.title === title)?.lane;

  it("names each kind as the boards do", () => {
    expect(kind("Refine research question")).toBe("bk");
    expect(kind("Supervision, Ines")).toBe("ev");
    expect(kind("Thesis workshop")).toBe("fd");
    expect(kind("Ask Thijs to sign")).toBe("du");
    expect(kind("Dashboard review with Thijs")).toBe("key");
    expect(kind("Adobe CC")).toBe("mn");
    expect(kind("Graduation thesis due")).toBe("ms");
    expect(kind("Build the October slides")).toBe("pp");
  });

  it("keeps to the range asked for", () => {
    expect(kind("Router label rules")).toBeUndefined();
  });

  it("runs each in its lane: steps in their note's area, events in the calendar, the rest above the horizon", () => {
    expect(lane("Refine research question")).toBe("school");
    expect(lane("Ask Thijs to sign")).toBe("school");
    expect(lane("Build the October slides")).toBe("work");
    expect(lane("Supervision, Ines")).toBe(CALENDAR_LANE);
    expect(lane("Thesis workshop")).toBe(CALENDAR_LANE);
    expect(lane("Open day")).toBe(DATED_LANE);
    expect(lane("Dashboard review with Thijs")).toBe(DATED_LANE);
    expect(lane("Adobe CC")).toBe(DATED_LANE);
    expect(lane("Graduation thesis due")).toBe(DATED_LANE);
  });

  it("marks only what is late in red: an overdue step, never a block or a due day still ahead", () => {
    expect(items.filter((i) => i.late).map((i) => i.title)).toEqual(["Ask Thijs to sign"]);
  });

  it("folds the quiet areas and puts the calendar after the areas", () => {
    const { lanes, quiet } = weekLanes(items.filter((i) => i.lane !== DATED_LANE));
    expect(lanes.map((l) => l.id)).toEqual(["school", "work", CALENDAR_LANE]);
    expect(quiet.map((l) => l.id)).toEqual(["knowledge", "tools", "personal"]);
    expect(lanes[0]!.note).toBe("Graduation thesis · 1 late");
    expect(lanes[2]!.note).toBe("1 event · 1 subscribed");
  });
});

describe("the next three weeks", () => {
  it("leaves out booked time, proposals, feeds and anything that repeats; keeps one-offs, due days and money", () => {
    const items = buildItems({
      tasks: [task({ text: "Block", blocks: [{ id: "b", date: "2026-10-13", startMin: 600, durationMin: 60 }] })],
      events: [
        ...[12, 13, 14].map((d) => event({ id: `s${d}`, date: `2026-10-${d}`, title: "Kade standup" })),
        event({ id: "iv", date: "2026-10-12", title: "Interview, Polder Capital", startMin: 660 }),
        event({ id: "fd", date: "2026-10-15", title: "Lecture", source: "ics", mine: false, readonly: true }),
      ],
      markers: [marker({ id: "k", date: "2026-10-19", title: "Research plan submitted", key: true }), marker({ id: "r", date: "2026-11-01", title: "Rent", kind: "charge", amount: -745, currency: "EUR" })],
      proposals: [],
      areaOf,
      from: "2026-10-12",
      to: "2026-11-01",
    });
    const { shown, more } = nextWeeks(items, "2026-10-12", "2026-11-01");
    expect(shown.map((i) => i.title)).toEqual(["Interview, Polder Capital", "Research plan submitted", "Rent"]);
    expect(more).toBe(0);
    expect(nextWeeks(items, "2026-10-12", "2026-11-01", 2).more).toBe(1);
  });
});

describe("the hour window follows the content", () => {
  it("opens on 07–23, widens around what falls outside, and gives the whole day on request", () => {
    expect(windowFor(false, [])).toEqual([420, 1380]);
    expect(windowFor(false, [{ startMin: 390, durationMin: 60 }])).toEqual([360, 1380]);
    expect(windowFor(false, [{ startMin: 1380, durationMin: 50 }])).toEqual([420, 1440]);
    expect(windowFor(false, [{ startMin: null, durationMin: 0 }])).toEqual([420, 1380]);
    expect(windowFor(true, [])).toEqual([0, 1440]);
  });

  it("scrolls to half an hour above the first item, else to 08:00 (not a fixed 11:30)", () => {
    const one = buildItems({ tasks: [], events: [event({ id: "e", date: "2026-10-05", title: "Standup", startMin: 570 })], markers: [], proposals: [], areaOf, ...week });
    expect(firstScroll(one, 420)).toBe(540);
    expect(firstScroll([], 420)).toBe(480);
    expect(firstScroll(one, 600)).toBe(600);
  });
});

describe("the header's counts and To plan", () => {
  const backlog = [
    task({ text: "Late one", due: "2026-10-03" }),
    task({ text: "Due Friday", due: "2026-10-09", line: 6 }),
    task({ text: "Due next week", due: "2026-10-14", line: 7 }),
    task({ text: "No day", line: 8 }),
  ];
  it("counts what is due in the span and what is late anywhere", () => {
    const items = buildItems({ tasks: [], events: [], markers: [marker({ id: "a", date: "2026-10-09", title: "a" }), marker({ id: "b", date: "2026-10-10", title: "b", key: true })], proposals: [], areaOf, ...week });
    expect(dueCounts(items, backlog, "2026-10-08")).toEqual({ due: 2, late: 1 });
  });
  it("cuts the backlog into late, this week (from today) and all, soonest first", () => {
    const cuts = toPlanCuts(backlog, "2026-10-08", "2026-10-05", "2026-10-11");
    expect(cuts.late.map((t) => t.text)).toEqual(["Late one"]);
    expect(cuts.week.map((t) => t.text)).toEqual(["Due Friday"]);
    expect(cuts.all.map((t) => t.text)).toEqual(["Late one", "Due Friday", "Due next week", "No day"]);
  });
  it("says how far a step's day is", () => {
    expect(dueWords("2026-10-05", "2026-10-08")).toEqual({ text: "3 days late", late: true });
    expect(dueWords("2026-10-07", "2026-10-08")).toEqual({ text: "1 day late", late: true });
    expect(dueWords("2026-10-08", "2026-10-08")).toEqual({ text: "due today", late: false });
    expect(dueWords("2026-10-09", "2026-10-08")).toEqual({ text: "due tomorrow", late: false });
    expect(dueWords("2026-10-10", "2026-10-08")).toEqual({ text: "due Sat", late: false });
    expect(dueWords("2026-10-23", "2026-10-08")).toEqual({ text: "due Fri 23 Oct", late: false });
    expect(dueWords(null, "2026-10-08")).toBeNull();
  });
});

describe("what Orr says about his proposal", () => {
  const p = (o: Partial<Proposal>): Proposal => ({ noteId: "n", line: 1, blockId: null, text: "The October slides", project: null, due: "2026-10-10", atRisk: false, date: "2026-10-09", startMin: 780, durationMin: 120, estimateHours: 2, ...o });
  it("one block: the board's sentence, and a Book with its day and time", () => {
    expect(proposalWords([p({})], "2026-10-08")).toEqual({
      text: "The October slides is due Saturday with no time booked. Friday 13:00–15:00 is free. Book it?",
      book: "Book Friday 13:00",
    });
    expect(proposalWords([p({ due: "2026-10-06" })], "2026-10-08").text).toMatch(/^The October slides was due Tuesday/);
  });
  it("several: how many, how long, for how many steps", () => {
    const w = proposalWords([p({}), p({ startMin: 900, durationMin: 60 }), p({ line: 2, durationMin: 30 })], "2026-10-08");
    expect(w.text).toMatch(/^3 blocks, 3\.5h, for 2 steps/);
    expect(w.book).toBe("Book them");
  });
  it("none: says why, offers nothing to book", () => {
    expect(proposalWords([], "2026-10-08").book).toBe("");
  });
});

describe("now on the horizon", () => {
  const mon = new Date(2026, 9, 5, 12);
  it("sits along the week by day and minute, and only in this week", () => {
    expect(nowAlong(mon, new Date(2026, 9, 8, 10, 40))).toBeCloseTo((3 + 640 / 1440) / 7, 6);
    expect(nowAlong(mon, new Date(2026, 9, 5, 0, 0))).toBe(0);
    expect(nowAlong(mon, new Date(2026, 9, 12, 0, 0))).toBeNull();
    expect(nowAlong(mon, new Date(2026, 9, 4, 23, 59))).toBeNull();
  });
});

describe("the page's name and addresses", async () => {
  const { planningRoute, planningTitle } = await import("./title.js");
  const now = new Date(2026, 9, 8, 10, 40);
  it("names the week, the month and the day as the phone's top bar shows them", () => {
    expect(planningTitle({ kind: "planning", scale: "week" }, now)).toBe("Week 41");
    expect(planningTitle({ kind: "planning", scale: "week", at: "2026-W42" }, now)).toBe("Week 42");
    expect(planningTitle({ kind: "planning", scale: "month", at: "2026-11" }, now)).toBe("November");
    expect(planningTitle({ kind: "planning", scale: "day", at: "2026-10-09" }, now)).toBe("Friday 9");
  });
  it("writes no date for the one holding today, and the Monday for any other week", () => {
    expect(planningRoute("week", new Date(2026, 9, 10, 12), now)).toEqual({ kind: "planning", scale: "week" });
    expect(planningRoute("week", new Date(2026, 9, 14, 12), now)).toEqual({ kind: "planning", scale: "week", at: "2026-10-12" });
    expect(planningRoute("month", new Date(2026, 10, 3, 12), now)).toEqual({ kind: "planning", scale: "month", at: "2026-11" });
    expect(planningRoute("day", now, now)).toEqual({ kind: "planning", scale: "day" });
  });
});
