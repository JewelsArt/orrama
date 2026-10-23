/**
 * Planning, redrawn (R6): every feature it had still works in its new place, and the address
 * is the week, month or day on screen. A fixture server answers the five GETs; every write is
 * recorded, never sent.
 */
import { act, createEvent, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CalEvent, DayMarker, Feed, PlanTask } from "@orrama/schema/responses";
import { event, marker, task } from "./test/planning-fixtures.js";
import { AREAS_REPLY } from "./test/areas.js";

const server = vi.hoisted(() => ({
  calls: [] as { method: string; url: string; body: unknown }[],
  tasks: [] as PlanTask[],
  events: [] as CalEvent[],
  markers: [] as DayMarker[],
  feeds: [] as Feed[],
  fail: false,
  /** A write to a matching address fails as a server that isn't there would (WEB-010). */
  writeFail: null as RegExp | null,
  proposals: [] as unknown[],
  /** The first plan says `refining`; `?refined=1` answers when `refined` settles (P1). */
  refining: false,
  refined: null as Promise<PlanTask[]> | null,
  gets: [] as string[],
}));

const planOf = (tasks: PlanTask[], refining: boolean) => ({
  team: null, source: refining ? "heuristic" : "ai", refining, hoursPerDay: 6, generatedAt: 0,
  assignees: [{ assignee: "jules", totalHours: 0, tasks }], atRisk: 0, totalHours: 0,
});

vi.mock("./api.js", async (orig) => {
  const real = await orig<typeof import("./api.js")>();
  return {
    ...real,
    api: async (method: string, url: string, body?: unknown) => {
      if (method === "GET") {
        server.gets.push(url);
        if (server.fail) throw new Error("down");
        if (url === "/api/plan") return { ...planOf(server.tasks, server.refining), source: "heuristic" };
        if (url === "/api/plan?refined=1") return planOf(await server.refined!, false);
        if (url.startsWith("/api/events")) return server.events;
        if (url.startsWith("/api/calendar/markers")) return server.markers;
        if (url === "/api/calendar/feeds") return server.feeds;
        if (url === "/api/areas") return AREAS_REPLY;
        if (url === "/api/vault/tree")
          return [
            { id: "n-thesis", path: "04-Projects/graduation-thesis.md", folder: "04-Projects", title: "Graduation thesis", hash: "", mtimeMs: 0, tags: [], openTasks: 0, category: "school" },
            { id: "n-report", path: "04-Projects/reporting.md", folder: "04-Projects", title: "Reporting", hash: "", mtimeMs: 0, tags: [], openTasks: 0, category: "work" },
          ];
        if (url === "/api/projects") return [];
        throw new Error(`unexpected GET ${url}`);
      }
      server.calls.push({ method, url, body });
      if (server.writeFail?.test(url)) throw new TypeError("Failed to fetch");
      if (url === "/api/plan/auto") return { proposals: server.proposals, unplaced: 0 };
      return {};
    },
  };
});

const { Planning } = await import("./Planning.js");
const { useRoute, navigate } = await import("./ui/router.js");

/** Planning as App mounts it: reading the address. */
function Page() {
  const r = useRoute();
  return <Planning me={{} as never} route={r?.kind === "planning" ? r : { kind: "planning", scale: "week" }} onOpenNote={() => {}} />;
}

const writes = (url?: string) => server.calls.filter((c) => !url || c.url === url || c.url.startsWith(url));

/** Thursday 8 October 2026, 10:40: the boards' now. */
const NOW = new Date(2026, 9, 8, 10, 40);

async function open(path = "/planning/week") {
  history.replaceState(null, "", path);
  const view = render(<Page />);
  await act(async () => {});
  await act(async () => {});
  return view;
}

/** A drag or mouse event at a point (happy-dom's event constructors drop clientX/Y). */
function at(kind: "dragOver" | "drop" | "dblClick", el: HTMLElement, x: number, y: number, init: object = {}) {
  const ev = createEvent[kind](el, init);
  Object.defineProperty(ev, "clientX", { value: x });
  Object.defineProperty(ev, "clientY", { value: y });
  fireEvent(el, ev);
}

/** A DataTransfer good enough for React's drag events. */
function dt() {
  const data: Record<string, string> = {};
  return {
    data,
    setData: (k: string, v: string) => (data[k] = v),
    getData: (k: string) => data[k] ?? "",
    get types() {
      return Object.keys(data);
    },
    dropEffect: "",
    effectAllowed: "",
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  server.calls = [];
  server.fail = false;
  server.writeFail = null;
  server.feeds = [];
  server.proposals = [];
  server.refining = false;
  server.refined = null;
  server.gets = [];
  server.tasks = [
    task({ text: "Refine research question", line: 5, blockId: "t-aaa111", due: "2026-10-08", blocks: [{ id: "blk-1", date: "2026-10-05", startMin: 600, durationMin: 120 }], scheduledHours: 2, estimateHours: 4, remainingHours: 2 }),
    task({ text: "Ask Thijs to sign the data agreement", line: 6, due: "2026-10-05", remainingHours: 0.5, estimateHours: 0.5 }),
    task({ text: "Build the October slides", noteId: "n-report", noteTitle: "Reporting", project: "Reporting dashboard", line: 3, due: "2026-10-10" }),
  ];
  server.events = [
    event({ id: "ev-standup", date: "2026-10-06", title: "Kade standup", startMin: 570, durationMin: 15 }),
    event({ id: "ics-1", date: "2026-10-07", title: "Research methods", startMin: 780, durationMin: 120, source: "ics", readonly: true, mine: false, feedLabel: "Westerdok" }),
  ];
  server.markers = [
    marker({ id: "d1", date: "2026-10-08", title: "Refine research question", line: 5 }),
    marker({ id: "d2", date: "2026-10-05", title: "Ask Thijs to sign the data agreement", line: 6, overdue: true }),
    marker({ id: "d3", date: "2026-10-10", title: "Build the October slides", noteId: "n-report", line: 3, source: "Reporting" }),
    marker({ id: "k1", date: "2026-10-09", title: "Dashboard review with Thijs", noteId: "n-report", line: 9, key: true }),
    marker({ id: "c1", date: "2026-10-08", title: "Adobe CC", kind: "charge", amount: -19.66, currency: "EUR", noteId: "n-subs", line: null }),
  ];
});
afterEach(() => {
  vi.useRealTimers();
  history.replaceState(null, "", "/");
});

describe("the header (§8 #2: the five stat tiles go)", () => {
  it("has no stat tiles; '4 due · 1 late' are links that open To plan on that cut", async () => {
    await open();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Week 41");
    expect(screen.getByText("5–11 October")).toBeTruthy();
    for (const gone of ["Booked", "Meetings", "Unplanned", "Due this week"]) expect(screen.queryByText(gone)).toBeNull();
    expect(document.querySelector(".plan-strip, .plan-tile")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "1 late" }));
    const sheet = screen.getByRole("dialog", { name: "To plan" });
    expect(within(sheet).getByRole("tab", { name: /Late/ }).getAttribute("aria-selected")).toBe("true");
    expect(within(sheet).getByText("Ask Thijs to sign the data agreement")).toBeTruthy();
    expect(screen.getByRole("button", { name: "4 due" })).toBeTruthy();
  });
});

describe("addresses", () => {
  it("the week is in the address, the arrows and ← → go by it, and this week has no date", async () => {
    await open("/planning/week/2026-10-12");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Week 42");
    fireEvent.click(screen.getByRole("button", { name: "Previous week" }));
    await act(async () => {});
    expect(location.pathname).toBe("/planning/week");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Week 41");
    fireEvent.keyDown(window, { key: "ArrowRight" });
    await act(async () => {});
    expect(location.pathname).toBe("/planning/week/2026-10-12");
    // Not while typing.
    const input = document.createElement("input");
    document.body.append(input);
    fireEvent.keyDown(input, { key: "ArrowRight" });
    expect(location.pathname).toBe("/planning/week/2026-10-12");
    input.remove();
  });

  it("the scale tabs link to the month and the day, keeping the date in view", async () => {
    await open("/planning/week/2026-11-02");
    expect(screen.getByRole("tab", { name: "Month" }).getAttribute("href")).toBe("/planning/month/2026-11");
    expect(screen.getByRole("tab", { name: "Day" }).getAttribute("href")).toBe("/planning/day/2026-11-02");
    fireEvent.click(screen.getByRole("tab", { name: "Month" }));
    await act(async () => {});
    expect(location.pathname).toBe("/planning/month/2026-11");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("November 2026");
  });

  it("a day's name opens that day; in the month, its number and '+N more' do too", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Open Friday 9 October" }));
    await act(async () => {});
    expect(location.pathname).toBe("/planning/day/2026-10-09");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Friday 9 October");
    act(() => navigate("/planning/month"));
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Open Saturday 10 October" }));
    await act(async () => {});
    expect(location.pathname).toBe("/planning/day/2026-10-10");
  });
});

describe("Lanes and Hours", () => {
  it("opens in Lanes; Hours is remembered", async () => {
    const first = await open();
    expect(screen.getByRole("radio", { name: "Lanes" }).getAttribute("aria-checked")).toBe("true");
    expect(document.querySelector(".wk")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "Hours" }));
    expect(document.querySelector(".hg")).toBeTruthy();
    expect(screen.getByRole("complementary", { name: "To plan" })).toBeTruthy();
    first.unmount();
    await open();
    expect(screen.getByRole("radio", { name: "Hours" }).getAttribute("aria-checked")).toBe("true");
  });

  it("lanes are the life areas; key deadlines and money sit in the dated row above the horizon", async () => {
    await open();
    const lanes = [...document.querySelectorAll(".wk-lh.lane b")].map((b) => b.textContent);
    expect(lanes).toEqual(["School", "Work", "Calendar"]);
    const dated = [...document.querySelectorAll(".plan-dated .tm")].map((t) => t.textContent);
    expect(dated).toHaveLength(2);
    expect(dated[0]).toMatch(/^Adobe CC.€19\.66$/);
    expect(dated[1]).toMatch(/^Dashboard review with Thijs/);
    expect(document.querySelector(".plan-dated .tm.key")?.textContent).toContain("Dashboard review");
    // Orr stands on the horizon at now.
    expect(screen.getByRole("img", { name: "Orr, at now" })).toBeTruthy();
    expect(document.querySelector(".wk-hz .tnow")?.textContent).toBe("10:40");
  });

  it("only late items are red", async () => {
    await open();
    const late = [...document.querySelectorAll(".tm.late")].map((t) => t.querySelector("b")?.textContent);
    expect(late).toEqual(["Ask Thijs to sign the data agreement"]);
  });
});

describe("items open what they are", () => {
  it("a due step opens its task card", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Build the October slides" }));
    const card = screen.getByRole("dialog", { name: "Build the October slides" });
    expect(within(card).getByText("Put it in the week")).toBeTruthy();
  });

  it("booked time opens its popover: longer, then off the calendar", async () => {
    await open();
    fireEvent.click(document.querySelector<HTMLElement>(".tm.bk")!);
    const pop = screen.getByRole("dialog", { name: "Refine research question" });
    fireEvent.click(within(pop).getByRole("button", { name: "Half an hour longer" }));
    await act(async () => {});
    expect(writes("/api/blocks/blk-1")).toEqual([{ method: "PATCH", url: "/api/blocks/blk-1", body: { durationMin: 150 } }]);
    fireEvent.click(within(pop).getByRole("button", { name: "Remove from calendar" }));
    await act(async () => {});
    expect(writes().at(-1)).toEqual({ method: "DELETE", url: "/api/blocks/blk-1", body: undefined });
  });
});

describe("Plan my week proposes; it never writes", () => {
  const proposals = [
    { noteId: "n-report", line: 3, blockId: null, text: "Build the October slides", project: "Reporting dashboard", due: "2026-10-10", atRisk: false, date: "2026-10-09", startMin: 780, durationMin: 120, estimateHours: 2 },
    { noteId: "n-thesis", line: 6, blockId: null, text: "Ask Thijs to sign the data agreement", project: "Graduation thesis", due: "2026-10-05", atRisk: false, date: "2026-10-09", startMin: 600, durationMin: 30, estimateHours: 0.5 },
  ];

  it("draws proposals hatched with Orr's head, writes nothing, and Not now leaves them out", async () => {
    server.proposals = proposals;
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Plan my week" }));
    await act(async () => {});
    expect(writes()).toEqual([{ method: "POST", url: "/api/plan/auto", body: { from: "2026-10-05", to: "2026-10-11" } }]);
    expect(document.querySelectorAll(".tm.pp")).toHaveLength(2);
    expect(document.querySelector(".tm.pp .hd")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toMatch(/2 blocks, 2\.5h, for 2 steps/);
    // A click on one leaves it out.
    fireEvent.click(screen.getByRole("button", { name: "Ask Thijs to sign the data agreement, proposed by Orr" }));
    expect(document.querySelectorAll(".tm.pp")).toHaveLength(1);
    expect(screen.getByRole("status").textContent).toMatch(/^Build the October slides is due Saturday with no time booked\. Friday 13:00–15:00 is free\. Book it\?/);
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(document.querySelectorAll(".tm.pp")).toHaveLength(0);
    expect(writes("/api/tasks/blocks")).toEqual([]);
  });

  it("booking goes through the ordinary block endpoint, one per proposal", async () => {
    server.proposals = proposals;
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Plan my week" }));
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Book them" }));
    await act(async () => {});
    expect(writes("/api/tasks/blocks").map((c) => c.body)).toEqual([
      { noteId: "n-report", line: 3, blockId: undefined, text: "Build the October slides", date: "2026-10-09", startMin: 780, durationMin: 120, estimateHours: 2 },
      { noteId: "n-thesis", line: 6, blockId: undefined, text: "Ask Thijs to sign the data agreement", date: "2026-10-09", startMin: 600, durationMin: 30, estimateHours: 0.5 },
    ]);
    expect(document.querySelectorAll(".tm.pp")).toHaveLength(0);
  });
});

describe("drag and drop", () => {
  const cellOf = (lane: string, col: number) => {
    const head = screen.getByRole("button", { name: new RegExp(`^${lane}`) });
    const row = head.style.gridRow;
    return [...document.querySelectorAll<HTMLElement>(".wk-c")].find((c) => c.style.gridRow === row && c.style.gridColumn === String(col))!;
  };

  it("booked time dragged to another day moves its block; a due step moves its due:", async () => {
    await open();
    const transfer = dt();
    fireEvent.dragStart(document.querySelector<HTMLElement>(".tm.bk")!, { dataTransfer: transfer });
    const wed = cellOf("School", 4);
    fireEvent.dragOver(wed, { dataTransfer: transfer });
    fireEvent.drop(wed, { dataTransfer: transfer });
    await act(async () => {});
    expect(writes("/api/blocks/blk-1")).toEqual([{ method: "PATCH", url: "/api/blocks/blk-1", body: { date: "2026-10-07" } }]);

    const due = dt();
    fireEvent.dragStart(screen.getByRole("button", { name: "Build the October slides" }), { dataTransfer: due });
    const sun = cellOf("Work", 8);
    fireEvent.dragOver(sun, { dataTransfer: due });
    fireEvent.drop(sun, { dataTransfer: due });
    await act(async () => {});
    expect(writes("/api/tasks/dates")).toEqual([{ method: "POST", url: "/api/tasks/dates", body: { noteId: "n-report", line: 3, blockId: undefined, text: "Build the October slides", due: "2026-10-11" } }]);
  });

  it("a subscribed calendar's occurrence doesn't move", async () => {
    await open();
    expect(screen.getByRole("button", { name: "Research methods" }).getAttribute("draggable")).toBeNull();
  });

  it("in Hours, a step dropped from To plan is booked where it lands; a double-click makes an event", async () => {
    localStorage.setItem("orrama-plan-view", "hours");
    await open();
    const cols = document.querySelector<HTMLElement>(".plan-hg-cols")!;
    cols.getBoundingClientRect = () => ({ left: 0, top: 0, width: 700, height: 1000, right: 700, bottom: 1000, x: 0, y: 0, toJSON() {} }) as DOMRect;
    const thu = cols.children[3] as HTMLElement;
    // The window here is 07:00–23:00 at 48 px an hour: 10:00 is 3 h down.
    const at10 = 3 * 48;

    const transfer = dt();
    const step = within(screen.getByRole("complementary", { name: "To plan" })).getByText("Build the October slides").closest<HTMLElement>(".tk")!;
    fireEvent.dragStart(step, { dataTransfer: transfer });
    at("dragOver", thu, 350, at10, { dataTransfer: transfer });
    expect(thu.querySelector(".slot.is-ghost")?.textContent).toBe("Thu 10:00–12:00");
    at("drop", thu, 350, at10, { dataTransfer: transfer });
    await act(async () => {});
    expect(writes("/api/tasks/blocks").map((c) => c.body)).toEqual([{ noteId: "n-report", line: 3, blockId: undefined, text: "Build the October slides", date: "2026-10-08", startMin: 600, estimateHours: 2 }]);

    at("dblClick", thu, 350, at10 + 24);
    const pop = screen.getByRole("dialog", { name: "New event" });
    const title = within(pop).getByRole("textbox", { name: "Event title" });
    fireEvent.change(title, { target: { value: "Lunch with Emma" } });
    fireEvent.keyDown(title, { key: "Enter" });
    await act(async () => {});
    expect(writes("/api/events")).toEqual([{ method: "POST", url: "/api/events", body: { title: "Lunch with Emma", date: "2026-10-08", startMin: 630, durationMin: 60 } }]);
  });
});

describe("a write that didn't save (WEB-010)", () => {
  it("a new event that didn't save keeps its popover and its title, says why, and goes on the next try", async () => {
    localStorage.setItem("orrama-plan-view", "hours");
    const { Toaster } = await import("./ui/overlays.js");
    render(<Toaster />);
    await open();
    server.writeFail = /^\/api\/events$/;
    const thu = document.querySelector<HTMLElement>(".plan-hg-cols")!.children[3] as HTMLElement;
    at("dblClick", thu, 350, 3 * 48);
    const pop = screen.getByRole("dialog", { name: "New event" });
    const title = within(pop).getByRole("textbox", { name: "Event title" }) as HTMLInputElement;
    fireEvent.change(title, { target: { value: "Lunch with Emma" } });
    await act(async () => {
      fireEvent.keyDown(title, { key: "Enter" });
    });
    expect(screen.getByRole("dialog", { name: "New event" })).toBe(pop);
    expect(title.value).toBe("Lunch with Emma");
    expect([...document.querySelectorAll(".toast span")].map((t) => t.textContent)).toContain("The event wasn't added. The server didn't answer. Check it's running, then try again.");
    server.writeFail = null;
    await act(async () => {
      fireEvent.keyDown(title, { key: "Enter" });
    });
    expect(writes("/api/events")).toHaveLength(2);
    expect(screen.queryByRole("dialog", { name: "New event" })).toBeNull();
  });
});

describe("states", () => {
  it("a calendar feed that failed is named, with Retry; the week still shows", async () => {
    server.feeds = [{ id: "f1", label: "Westerdok", host: "example.org", createdAt: 0, lastSyncedAt: null, lastError: "timeout" }];
    await open();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("The calendar “Westerdok” didn't update.");
    expect(alert.textContent).not.toContain("timeout");
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    await act(async () => {});
    expect(writes("/api/calendar/feeds/f1/refresh")).toHaveLength(1);
    expect(document.querySelector(".wk")).toBeTruthy();
  });

  it("a page that can't load says so in plain words, with Retry, and Orr stays away", async () => {
    server.fail = true;
    await open();
    expect(screen.getByRole("alert").textContent).toContain("Planning didn't load.");
    expect(document.querySelector(".orr, [aria-label^='Orr']")).toBeNull();
    server.fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await act(async () => {});
    expect(document.querySelector(".wk")).toBeTruthy();
  });

  it("an empty week offers the steps that have no time yet", async () => {
    await open("/planning/week/2026-11-23");
    expect(screen.getByText("An open week.")).toBeTruthy();
    expect(screen.getByText("3 steps in your notes have no time yet.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Pick some for this week" }));
    expect(within(screen.getByRole("dialog", { name: "To plan" })).getByRole("tab", { name: /All/ }).getAttribute("aria-selected")).toBe("true");
  });

  it("an empty day in a lane adds a step due that day, to the inbox", async () => {
    await open();
    fireEvent.click(screen.getAllByRole("button", { name: "+ Add to Saturday" })[0]!);
    const dialog = screen.getByRole("dialog", { name: "A step due Sat 10 Oct" });
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "Print the poster" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add it" }));
    await act(async () => {});
    expect(writes("/api/capture")).toEqual([{ method: "POST", url: "/api/capture", body: { text: "- [ ] Print the poster due:2026-10-10" } }]);
  });
});

describe("the phone", () => {
  it("the week stands up: days down the screen, the days gone folded to what's still open", async () => {
    const mm = window.matchMedia;
    window.matchMedia = ((q: string) => ({ matches: q.includes("760"), media: q, addEventListener() {}, removeEventListener() {} })) as never;
    try {
      await open();
      const days = [...document.querySelectorAll(".pd > b")].map((b) => b.firstChild?.textContent);
      expect(days).toEqual(["Mon – Wed", "Thursday", "Friday", "Saturday", "Sunday"]);
      const gone = document.querySelector(".pd.past")!;
      expect([...gone.querySelectorAll(".tm b")].map((b) => b.textContent)).toEqual(["Ask Thijs to sign the data agreement"]);
      expect(screen.queryByRole("radio", { name: "Hours" })).toBeNull();
      expect(document.querySelector(".pd.today .porr")).toBeTruthy();
    } finally {
      window.matchMedia = mm;
    }
  });
});

describe("the estimates arrive after the page (P1)", () => {
  /** The refined answer, held until the test lets it go. */
  const later = () => {
    let release!: (tasks: PlanTask[]) => void;
    server.refining = true;
    server.refined = new Promise((ok) => (release = ok));
    return release;
  };
  const refinedTasks = () => server.tasks.map((t) => (t.text === "Build the October slides" ? { ...t, estimateHours: 3, remainingHours: 3 } : t));
  const slidesHours = () =>
    within(screen.getByRole("complementary", { name: "To plan" })).getByText("Build the October slides").closest(".tk")!.querySelector(".r")!.textContent;

  it("shows the heuristic plan at once, then the refined one", async () => {
    localStorage.setItem("orrama-plan-view", "hours");
    const release = later();
    await open();
    expect(slidesHours()).toBe("2h");
    expect(document.querySelector(".plan-est")?.textContent).toContain("heuristic until AI refines them");
    release(refinedTasks());
    await act(async () => {});
    expect(slidesHours()).toBe("3h");
    expect(document.querySelector(".plan-est")?.textContent).toContain("refined by AI");
  });

  it("a drag in progress is not redrawn under it: the refined plan waits for the drop", async () => {
    localStorage.setItem("orrama-plan-view", "hours");
    const release = later();
    await open();
    const step = within(screen.getByRole("complementary", { name: "To plan" })).getByText("Build the October slides").closest<HTMLElement>(".tk")!;
    fireEvent.dragStart(step, { dataTransfer: dt() });
    release(refinedTasks());
    await act(async () => {});
    expect(slidesHours()).toBe("2h");
    fireEvent.dragEnd(step);
    await act(async () => {});
    expect(slidesHours()).toBe("3h");
  });

  it("a plan that isn't refining (no AI key) asks for nothing more", async () => {
    localStorage.setItem("orrama-plan-view", "hours");
    await open();
    expect(document.querySelector(".plan-est")?.textContent).toContain("Estimates are heuristic;");
    expect(server.gets.filter((u) => u.startsWith("/api/plan"))).toEqual(["/api/plan"]);
  });
});
