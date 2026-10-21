/**
 * Today (structure.md §2.1): the timetable and its seven modules on a fixed day, with every row
 * reachable from the keyboard (WEB-018, Today's half), each module's plain form when the data
 * isn't there, Customise, and the things the Dashboard did that Today still does.
 */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HIDDEN_KEY, Today } from "./Today.js";
import { Toaster } from "./ui/overlays.js";
import { ShellLookContext } from "./ui/shell/SectionBar.js";
import { DRAFTS, INBOX, NOW, SCHEMA_TYPED, stubToday, WARNINGS_TYPED } from "./test/today-fixture.js";

// Live sync, without a socket: a test says a note changed.
const ws = vi.hoisted(() => ({ listeners: new Set<(m: unknown) => void>() }));
vi.mock("./ws.js", () => ({
  onWs: (fn: (m: unknown) => void) => {
    ws.listeners.add(fn);
    return () => ws.listeners.delete(fn);
  },
}));
const emitWs = (m: Record<string, unknown>) => ws.listeners.forEach((fn) => fn({ path: "", authorId: null, ...m }));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  history.replaceState(null, "", "/today");
});
afterEach(() => {
  cleanup(); // before the stubs go: a late request from the page must not reach happy-dom's real fetch
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const mod = (name: string) => screen.getByRole("region", { name });
const path = () => location.pathname + location.search;
/** Today, loaded: the timetable and the last module in. */
async function shown() {
  render(<Today />);
  await screen.findByRole("region", { name: "Today, hour by hour" });
  await waitFor(() => expect(within(mod("Due")).queryByRole("status")).toBeNull());
}

describe("Today: the timetable", () => {
  it("draws the day's items, the now line at 10:40, and Orr reading during the booked block", async () => {
    stubToday();
    await shown();
    const tt = mod("Today, hour by hour");
    expect(within(tt).getByText("Now")).toBeTruthy();
    expect(tt.querySelector(".tt-now b")!.textContent).toBe("October report — data pull");
    expect(tt.querySelector(".tt-next")!.textContent).toBe("Next Lunch with Emma Jansen 12:30");
    expect(tt.querySelector(".tnow")!.textContent).toBe("10:40");
    expect(tt.querySelector(".tt-orr")!.getAttribute("data-pose")).toBe("read");
    const items = [...tt.querySelectorAll<HTMLAnchorElement>("a.it")];
    expect(items.map((a) => a.getAttribute("aria-label"))).toEqual([
      "Event: Kade standup, 09:30–09:45, past",
      "Booked: October report — data pull, 09:45–12:00, now",
      "Event: Lunch with Emma Jansen, 12:30–13:30",
      "Calendar: Thesis workshop, 17:00–18:30",
    ]);
    expect(items[0]!.classList.contains("past")).toBe(true);
    expect(items[1]!.classList.contains("cur")).toBe(true);
    expect(items[3]!.classList.contains("fd")).toBe(true);
    // The track opens on 08–20.
    expect([...tt.querySelectorAll(".hrs span")].map((s) => s.textContent)).toEqual(["08", "09", "10", "11", "12", "13", "14", "15", "16", "17", "18", "19", "20"]);
  });

  it("an empty day: an open day, Orr sits, and two real first steps", async () => {
    stubToday({ "GET /api/home": { ...(await import("./test/today-fixture.js")).HOME, agenda: [] } });
    await shown();
    const tt = mod("Today, hour by hour");
    expect(within(tt).getByText("An open day.")).toBeTruthy();
    expect(tt.querySelector(".tt-orr")!.getAttribute("data-pose")).toBe("sit");
    expect(within(tt).getByRole("link", { name: "Add a date to a task" }).getAttribute("href")).toBe("/planning/week");
    expect(within(tt).getByRole("link", { name: "Connect a calendar" }).getAttribute("href")).toBe("/settings/connections");
  });
});

describe("Today: the modules", () => {
  it("shows the seven modules in their order, and none of the four that left (§8 #1)", async () => {
    stubToday();
    await shown();
    const names = [...document.querySelectorAll(".td-dash section.mod")].map((s) => s.getAttribute("aria-label"));
    expect(names).toEqual(["Due", "Mail", "People today", "Coming up", "Projects", "Money", "Orr noticed"]);
    for (const gone of ["Vault Overview", "In Focus", "By category", "Notes written", "Add component"]) expect(screen.queryByText(gone)).toBeNull();
  });

  it("Due: the key deadline first, then Today, then Late, least late first", async () => {
    stubToday();
    await shown();
    const due = mod("Due");
    expect(within(due).getByText("Key deadline")).toBeTruthy();
    expect(due.querySelector(".keyrow .t")!.textContent).toBe("Dashboard review with Thijs");
    expect(due.querySelector(".keyrow .when")!.textContent).toBe("TomorrowFri 9 Oct");
    const rows = [...due.querySelectorAll(".td-row .t")].map((t) => t.textContent);
    expect(rows).toEqual(["October report — data pull", "Refine research question", "Ask Thijs Brouwer to sign the data agreement", "Pull 3 years of reach data"]);
    expect([...due.querySelectorAll(".td-row .r.late")].map((r) => r.textContent)).toEqual(["3 days", "4 days"]);
    expect(within(due).getByRole("checkbox", { name: "Done: Pull 3 years of reach data (blocked)" })).toBeTruthy();
    expect(within(due).getByRole("link", { name: "5 this week" }).getAttribute("href")).toBe("#");
  });

  it("ticking a task names it by its block id and text", async () => {
    const { sent } = stubToday();
    const user = userEvent.setup();
    await shown();
    await user.click(within(mod("Due")).getByRole("checkbox", { name: "Done: Refine research question" }));
    await waitFor(() => expect(sent.some((r) => r.method === "POST")).toBe(true));
    expect(sent.find((r) => r.method === "POST")).toEqual({
      method: "POST",
      url: "/api/tasks/check",
      body: { noteId: "n-thesis", line: expect.any(Number), blockId: "t-refine", text: "Refine research question", checked: true },
    });
    // Ticking the box does not open the row (the task card is named by its task).
    expect(screen.queryByRole("dialog", { name: "Refine research question" })).toBeNull();
    expect(document.querySelector(".tt-orr")!.getAttribute("data-pose")).toBe("read");
  });

  it("a tick can be taken back: the row leaves the list, and its toast's Undo unticks the step (1B)", async () => {
    const { sent } = stubToday();
    const user = userEvent.setup();
    render(<Toaster />);
    await shown();
    await user.click(within(mod("Due")).getByRole("checkbox", { name: "Done: Refine research question" }));
    // The newest toast's Undo: an earlier test's tick may still be on screen.
    await user.click((await screen.findAllByRole("button", { name: "Undo" })).at(-1)!);
    await waitFor(() => expect(sent.filter((r) => r.method === "POST")).toHaveLength(2));
    expect(sent.filter((r) => r.method === "POST").map((r) => (r.body as { checked: boolean }).checked)).toEqual([true, false]);
    expect(sent.filter((r) => r.method === "POST")[1]!.body).toMatchObject({ noteId: "n-thesis", blockId: "t-refine", text: "Refine research question" });
  });

  it("a tick the server didn't take is said with Retry; a task that moved is said as such (WEB-010)", async () => {
    const { routes, sent } = stubToday({ "POST /api/tasks/check": 500 });
    const user = userEvent.setup();
    render(<Toaster />);
    await shown();
    const said = () => [...document.querySelectorAll(".toast span")].map((t) => t.textContent);
    await user.click(within(mod("Due")).getByRole("checkbox", { name: "Done: Refine research question" }));
    await waitFor(() => expect(said()).toContain("The task wasn't ticked. Try again in a moment."));
    routes["POST /api/tasks/check"] = { ok: true };
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(sent.filter((r) => r.method === "POST")).toHaveLength(2));
    routes["POST /api/tasks/check"] = 409;
    await user.click(within(mod("Due")).getByRole("checkbox", { name: "Done: Refine research question" }));
    await waitFor(() => expect(said()).toContain("That task changed in its note since Today was drawn. Here it is as it is now."));
  });

  it("Orr jumps once when a key deadline is met, wherever it was ticked, then goes back to the day", async () => {
    const { routes } = stubToday();
    await shown();
    expect(document.querySelector(".tt-orr")!.getAttribute("data-pose")).toBe("read");
    const { TASKS } = await import("./test/today-fixture.js");
    routes["GET /api/tasks"] = TASKS.map((t) => (t.text === "Dashboard review with Thijs" ? { ...t, checked: true, status: "done" } : t));
    act(() => emitWs({ type: "note-changed", noteId: "n-dash" }));
    await waitFor(() => expect(document.querySelector(".tt-orr")!.getAttribute("data-pose")).toBe("jump"), { timeout: 2000 });
    await waitFor(() => expect(document.querySelector(".tt-orr")!.getAttribute("data-pose")).toBe("read"), { timeout: 4000 });
  });

  it("…and when a project finishes", async () => {
    const { routes } = stubToday();
    await shown();
    const { PROJECTS } = await import("./test/today-fixture.js");
    routes["GET /api/projects"] = PROJECTS.map((p) => (p.slug === "reporting" ? { ...p, done: p.total } : p));
    act(() => emitWs({ type: "note-changed", noteId: "n-dash" }));
    await waitFor(() => expect(document.querySelector(".tt-orr")!.getAttribute("data-pose")).toBe("jump"), { timeout: 2000 });
  });

  it("Coming up: events, key deadlines and project dates in the next three weeks", async () => {
    stubToday();
    await shown();
    const up = mod("Coming up");
    await waitFor(() => expect(up.querySelectorAll(".row").length).toBe(3));
    expect([...up.querySelectorAll(".row .t")].map((t) => t.textContent)).toEqual(["Interview, Polder Capital", "Race day", "Graduation thesis due"]);
    expect(within(up).getAllByText("Key deadline")).toHaveLength(1);
  });

  it("Projects: in motion, with progress and the next date; late is red", async () => {
    stubToday();
    await shown();
    const pr = mod("Projects");
    expect(within(pr).getByText("2 open")).toBeTruthy();
    expect([...pr.querySelectorAll(".row .x .t")].map((t) => t.textContent)).toEqual(["Reporting dashboard", "Graduation thesis"]);
    expect(pr.querySelector(".td-ell.late")!.textContent).toBe("Deadline Mon 19 Oct · 2 late");
  });

  it("Money: spent so far this month against a typical month, and today's charge", async () => {
    stubToday();
    await shown();
    const m = mod("Money");
    expect(within(m).getByText("October")).toBeTruthy();
    expect(m.querySelector(".big")!.textContent).toBe("€958 spent by day 8");
    expect(m.querySelector(".big")!.getAttribute("href")).toBe("/money/spending?month=2026-10");
    expect(m.querySelector("p")!.textContent).toBe("A typical month comes to €1,600; 60% of that is spent so far. Adobe Creative Cloud charges €19.66 today.");
  });

  it("People today: a whole name on today's calendar, with how you know them from the graph", async () => {
    stubToday({ "GET /api/graph/schema": SCHEMA_TYPED });
    await shown();
    const p = mod("People today");
    await waitFor(() => expect(p.querySelectorAll(".row").length).toBe(1));
    expect(p.querySelector(".row .t")!.textContent).toBe("Lunch with Emma Jansen");
    expect(p.querySelector(".row")!.getAttribute("href")).toBe("/people/emma-jansen");
  });

  it("Orr noticed: how many need a look, the first said in words as Orr noticed says it", async () => {
    stubToday({ "GET /api/graph/schema": SCHEMA_TYPED, "GET /api/graph/warnings": WARNINGS_TYPED });
    await shown();
    const n = mod("Orr noticed");
    await waitFor(() => expect(within(n).getByText("2 in the graph")).toBeTruthy());
    expect(n.querySelector(".noticed p")!.textContent).toBe("Pieter Bakker works at Bakker & Zn, which has no note, and 1 more.");
    expect(within(n).getByRole("link", { name: "1 more" }).getAttribute("href")).toBe("/notes/health");
    expect(within(n).getByRole("link", { name: "Review" }).getAttribute("href")).toBe("/notes/health");
  });

  it("Mail: unread mail in Primary with the sender's relation, and Orr's drafts", async () => {
    stubToday({
      "GET /api/mail/account": { connected: true, email: "jules@example.com", imapHost: "imap.gmail.com", lastCheckedAt: null, lastError: null },
      "GET /api/mail/inbox": { email: "jules@example.com", messages: INBOX },
      "GET /api/mail/drafts": DRAFTS,
      "GET /api/graph/schema": SCHEMA_TYPED,
    });
    await shown();
    const m = mod("Mail");
    await waitFor(() => expect(within(m).getByText("1 unread")).toBeTruthy());
    await waitFor(() => expect(m.querySelector(".row .m")!.textContent).toBe("Ines Vermaat · supervises Graduation thesis"));
    expect(m.querySelector(".row")!.getAttribute("href")).toBe("/mail/101");
    expect(m.querySelector(".oprop p")!.textContent).toBe("2 drafts from Orr are waiting: “Re: Research plan — section 3” and “Agenda for Friday's review”.");
    expect(within(m).getByRole("link", { name: "Review drafts" }).getAttribute("href")).toBe("/mail/waiting");
    // Ines also wrote today: she joins People today.
    await waitFor(() => expect([...mod("People today").querySelectorAll(".row .t")].map((t) => t.textContent)).toContain("Ines Vermaat · wrote at 10:01"));
    expect(screen.getByText(/read from 312 notes and Gmail/)).toBeTruthy();
  });

  it("Mail that can't be reached says so and offers Retry; drafts still show", async () => {
    stubToday({
      "GET /api/mail/account": { connected: true, email: "jules@example.com", imapHost: "imap.example.com", lastCheckedAt: null, lastError: null },
      "GET /api/mail/inbox": 502,
      "GET /api/mail/drafts": DRAFTS,
    });
    await shown();
    const m = mod("Mail");
    await waitFor(() => expect(within(m).getByText("Couldn't reach your mail.")).toBeTruthy());
    expect(within(m).getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(m.querySelector(".oprop")).toBeTruthy();
  });

  it("each module has a plain form when its data isn't there: never invented text", async () => {
    stubToday({ "GET /api/home": { ...(await import("./test/today-fixture.js")).HOME, spending: null }, "GET /api/projects": [], "GET /api/events": [], "GET /api/tasks": [] });
    await shown();
    expect(within(mod("Mail")).getByText("Your mail isn't connected yet.")).toBeTruthy();
    expect(within(mod("Money")).getByText("No bank statement yet.")).toBeTruthy();
    expect(within(mod("Due")).getByText("Nothing is due this week.")).toBeTruthy();
    expect(within(mod("Projects")).getByText("No projects in motion.")).toBeTruthy();
    expect(within(mod("Coming up")).getByText("Nothing dated in the next three weeks.")).toBeTruthy();
    // No ontology note: no relations asked for, nothing said about the graph but that.
    expect(within(mod("Orr noticed")).getByText(/Your notes have no types yet/)).toBeTruthy();
  });

  it("a module that fails says so and offers Retry; the others still render", async () => {
    stubToday({ "GET /api/tasks": 500 });
    render(<Today />);
    await waitFor(() => expect(within(mod("Due")).getByText("Your tasks didn't load.")).toBeTruthy());
    expect(within(mod("Due")).getByRole("button", { name: "Retry" })).toBeTruthy();
    await waitFor(() => expect(mod("Money").querySelector(".big")).toBeTruthy());
  });
});

describe("Today: every row has a keyboard path (WEB-018)", () => {
  it("rows are links or buttons, arrow keys move between them, Enter opens", async () => {
    stubToday();
    const user = userEvent.setup();
    await shown();
    const due = mod("Due");
    const key = due.querySelector<HTMLAnchorElement>("a.keyrow")!;
    key.focus();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement!.textContent).toContain("October report — data pull");
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement!.textContent).toContain("Refine research question");
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("dialog", { name: "Refine research question" })).toBeTruthy();
  });

  it("a project row opens the project from the keyboard", async () => {
    stubToday();
    const user = userEvent.setup();
    await shown();
    const row = mod("Projects").querySelector<HTMLAnchorElement>("a.row")!;
    row.focus();
    await user.keyboard("{Enter}");
    expect(path()).toBe("/projects/reporting");
  });

  it("every control can be reached with Tab, and no control sits inside another", async () => {
    stubToday({ "GET /api/graph/schema": SCHEMA_TYPED });
    await shown();
    // Anything clickable is a link with an address, a button, or a switch: nothing listens on a bare element.
    for (const el of document.querySelectorAll<HTMLElement>(".today .row, .today .it, .today .keyrow")) {
      const target = el.matches("a[href], button") ? el : el.querySelector("a[href]");
      expect(target, el.outerHTML.slice(0, 80)).toBeTruthy();
    }
    const html = document.querySelector(".today")!.outerHTML;
    expect(nestedControls(html)).toEqual([]);
  });
});

describe("Today: Customise, the header, New", () => {
  it("Customise lists the seven with switches; switching one off hides it and is remembered", async () => {
    stubToday();
    const user = userEvent.setup();
    await shown();
    await user.click(screen.getByRole("button", { name: "Customise" }));
    const sheet = await screen.findByRole("dialog", { name: "Customise Today" });
    expect(within(sheet).getAllByRole("switch").map((s) => s.getAttribute("aria-checked"))).toEqual(Array(7).fill("true"));
    await user.click(within(sheet).getAllByRole("switch")[5]!); // Money
    expect(screen.queryByRole("region", { name: "Money" })).toBeNull();
    expect(JSON.parse(localStorage.getItem(HIDDEN_KEY)!)).toEqual(["money"]);
  });

  it("starts with the modules switched off on this device", async () => {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify(["people", "noticed", "not-a-module"]));
    stubToday();
    await shown();
    const names = [...document.querySelectorAll(".td-dash section.mod")].map((s) => s.getAttribute("aria-label"));
    expect(names).toEqual(["Due", "Mail", "Coming up", "Projects", "Money"]);
  });

  it("says the date and week, plans tomorrow, and New offers task, note, event, project and the ledgers", async () => {
    stubToday();
    const user = userEvent.setup();
    await shown();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Thursday 8 October");
    expect(screen.getByText("Week 41")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Plan tomorrow" }).getAttribute("href")).toBe("/planning/day/2026-10-09");
    await user.click(screen.getByRole("button", { name: "New" }));
    const menu = await screen.findByRole("menu", { name: "New" });
    expect(within(menu).getAllByRole("menuitem").map((b) => b.textContent)).toEqual(["Task", "Note", "Event", "Project", "Subscription", "Income"]);
    // The task goes to your inbox, in New's own dialog (create/New.tsx), as Capture's did.
    await user.click(within(menu).getByRole("menuitem", { name: "Task" }));
    expect(await screen.findByRole("dialog", { name: "New task" })).toBeTruthy();
    expect(screen.getByText("It goes to your inbox.")).toBeTruthy();
  });

  it("New → Subscription adds a row to the ledger note, and says where", async () => {
    const { sent } = stubToday({ "POST /api/finance/subscriptions": { ok: true } });
    const user = userEvent.setup();
    render(<Toaster />);
    await shown();
    await user.click(screen.getByRole("button", { name: "New" }));
    await user.click(await screen.findByRole("menuitem", { name: "Subscription" }));
    const dialog = await screen.findByRole("dialog", { name: "Add a subscription" });
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "Spotify");
    await user.type(within(dialog).getByRole("textbox", { name: "Amount" }), "10.99");
    await user.click(within(dialog).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(sent.find((r) => r.url === "/api/finance/subscriptions")?.body).toMatchObject({ service: "Spotify", amount: "10.99", cadence: "monthly", next: "2026-10-08" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add a subscription" })).toBeNull());
    // The sheet's own sentence, the same as on Money's pages; no word about a note.
    expect(await screen.findByText("Spotify is in your commitments.")).toBeTruthy();
    expect(screen.queryByText(/added to its note/)).toBeNull();
  });

  it("New → Income with no income note yet is the same form: the first add makes the note (1G)", async () => {
    const { sent } = stubToday({ "POST /api/finance/income": { ok: true } });
    const user = userEvent.setup();
    render(<Toaster />);
    await shown();
    await user.click(screen.getByRole("button", { name: "New" }));
    await user.click(await screen.findByRole("menuitem", { name: "Income" }));
    const dialog = await screen.findByRole("dialog", { name: "Add income" });
    expect(within(dialog).queryByText(/tagged/)).toBeNull();
    await user.type(within(dialog).getByRole("textbox", { name: "Source" }), "Fictive BV");
    await user.type(within(dialog).getByRole("textbox", { name: "Amount" }), "2000");
    await user.click(within(dialog).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(sent.find((r) => r.url === "/api/finance/income")?.body).toMatchObject({ service: "Fictive BV", amount: "2000", cadence: "monthly" }));
    expect(await screen.findByText("Fictive BV is in your income.")).toBeTruthy();
    expect(screen.queryByText(/added to its note/)).toBeNull();
  });
});

describe("Today: Clay greets you (19 Oct)", () => {
  it("by name with the date underneath in Clay, and with the date alone in Paper", async () => {
    stubToday();
    const { unmount } = render(
      <ShellLookContext.Provider value={{ look: "clay", slot: null }}>
        <Today me={{ displayName: "Erin Vale" }} />
      </ShellLookContext.Provider>,
    );
    const head = await screen.findByRole("heading", { level: 1 });
    expect(head.textContent).toBe("Good morning, Erin"); // NOW is 10:40
    expect(head.parentElement?.querySelector(".meta")?.textContent).toBe("Thursday 8 October · Week 41");
    unmount();
    render(<Today me={{ displayName: "Erin Vale" }} />);
    expect((await screen.findByRole("heading", { level: 1 })).textContent).toBe("Thursday 8 October");
  });
});

describe("Today: live", () => {
  it("the now line moves with the clock, and Orr's pose with it", async () => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(NOW);
    stubToday();
    await shown();
    expect(document.querySelector(".tt-orr")!.getAttribute("data-pose")).toBe("read");
    vi.setSystemTime(new Date(2026, 9, 8, 12, 40));
    await act(async () => void vi.advanceTimersByTime(30_000));
    expect(document.querySelector(".tnow")!.textContent).toBe("12:40");
    expect(document.querySelector(".tt-orr")!.getAttribute("data-pose")).toBe("hello"); // at lunch
  });
});

/** Every interactive element that sits inside another one, as "outer > inner" (OverviewHead.test.tsx). */
function nestedControls(html: string): string[] {
  const INTERACTIVE_TAGS = new Set(["button", "a", "input", "select", "textarea"]);
  const INTERACTIVE_ROLES = /\brole="(button|link|switch|checkbox|menuitem|option|tab)"/;
  const VOID = new Set(["input", "img", "br", "hr", "meta", "link", "source", "path", "circle", "use", "rect", "line"]);
  const stack: { interactive: boolean; label: string }[] = [];
  const found: string[] = [];
  for (const m of html.matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g)) {
    const [, closing, tag, attrs = "", self] = m;
    if (closing) {
      stack.pop();
      continue;
    }
    const interactive = INTERACTIVE_TAGS.has(tag!) || INTERACTIVE_ROLES.test(attrs) || /\btabindex="0"/i.test(attrs);
    const label = `${tag}${/class="([^"]*)"/.exec(attrs)?.[1]?.replace(/^/, ".") ?? ""}`;
    const outer = stack.find((s) => s.interactive);
    if (interactive && outer) found.push(`${outer.label} > ${label}`);
    if (!self && !VOID.has(tag!)) stack.push({ interactive, label });
  }
  return found;
}
