/**
 * Your own events say where, carry notes, last all day and repeat (1H). Their
 * calendar note gains Place, Notes and Repeat columns only when a row needs
 * them, so a note written before reads, and is rewritten, as it always was.
 * A repeating event is expanded by the ICS reader, so it lands on the days a
 * subscribed calendar with the same rule lands on.
 */
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessionOf, signedIn } from "./helpers/session.js";

process.env.ORRAMA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-calevents-"));
process.env.ORRAMA_VAULT_DIR = path.join(process.env.ORRAMA_DATA_DIR, "vault");
process.env.ORRAMA_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.ORRAMA_SECRET_KEY = "test-secret-key-0123456789abcdef";
process.env.ORRAMA_FETCH_ALLOW = "127.0.0.1";

await import("../src/seed.js");
const { buildServer } = await import("../src/main.js");
const { tables } = await import("../src/db.js");
const { parseCalendarRows, placeRow, parseRepeat, repeatCell } = await import("../src/calendarNotes.js");
const { expandIcs, parseIcs } = await import("../src/ics.js");

const vault = process.env.ORRAMA_VAULT_DIR!;
const TABLE = "| Date | Start | End | What | Task | id |\n| --- | --- | --- | --- | --- | --- |\n";

/**
 * Shaped like a calendar note written before 1H (Jules's own, 2026-07): an id in the front
 * matter, the old sentence, a block, an event, a hand-typed row and an escaped pipe. Made-up
 * rows; the shape is what matters.
 */
const OLD_NOTE = [
  "---",
  "id: n-abcd1234efgh5678",
  "calendar: jules",
  'month: "2026-07"',
  "---",
  "# Calendar · July 2026",
  "",
  "Time blocks and events from Basalt's Planning tab. Edit a row to move it, delete it to remove it; a row with a Task link is time booked on that task.",
  "",
  "| Date | Start | End | What | Task | id |",
  "| --- | --- | --- | --- | --- | --- |",
  "| 2026-07-09 | 10:00 | 12:00 | Draft the plan | [[04-Projects/kade#^t-ab12cd]] | blk-1a2b3c4d |",
  "| 2026-07-10 | 14:00 | 15:00 | Supervision A \\| B |  | ev-9f8e7d6c |",
  "| 2026-07-11 | 09:30 | 10:00 | Typed by hand |  |  |",
  "",
].join("\n");

describe("the calendar note's table", () => {
  it("reads a note from before the new columns exactly as it did", () => {
    const rows = parseCalendarRows("jules", OLD_NOTE);
    expect(rows.map(({ line: _l, id, ...r }) => ({ id: id.slice(0, 3), ...r }))).toEqual([
      { id: "blk", date: "2026-07-09", startMin: 600, durationMin: 120, title: "Draft the plan", task: { notePath: "04-Projects/kade", blockId: "t-ab12cd" } },
      { id: "ev-", date: "2026-07-10", startMin: 840, durationMin: 60, title: "Supervision A | B", task: null },
      { id: "ev-", date: "2026-07-11", startMin: 570, durationMin: 30, title: "Typed by hand", task: null },
    ]);
    // A hand-typed row keeps the id it was derived before (from the line, unchanged).
    expect(rows[2]!.id).toMatch(/^ev-[0-9a-f]{8}$/);
  });

  it("a plain event written into an old note keeps the old table, byte for byte around it", () => {
    const out = placeRow("jules", OLD_NOTE, { id: "ev-new1", date: "2026-07-12", startMin: 600, durationMin: 60, title: "Lunch", task: null });
    expect(out).toBe(OLD_NOTE.replace("| 2026-07-11 | 09:30 | 10:00 | Typed by hand |  |  |\n", "| 2026-07-11 | 09:30 | 10:00 | Typed by hand |  |  |\n| 2026-07-12 | 10:00 | 11:00 | Lunch |  | ev-new1 |\n"));
  });

  it("the first row with a place, notes or a repeat widens the table; every old row still reads the same", () => {
    const out = placeRow("jules", OLD_NOTE, {
      id: "ev-new2",
      date: "2026-07-13",
      startMin: 1080,
      durationMin: 60,
      title: "Choir",
      task: null,
      place: "De Kade | room 2",
      notes: "Bring the folder\nAnd water",
      repeat: "weekly until 2026-12-31",
    });
    expect(out).toContain("| Date | Start | End | What | Task | id | Place | Notes | Repeat |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n");
    expect(out).toContain("| 2026-07-13 | 18:00 | 19:00 | Choir |  | ev-new2 | De Kade \\| room 2 | Bring the folder<br>And water | weekly until 2026-12-31 |");
    const before = parseCalendarRows("jules", OLD_NOTE);
    const after = parseCalendarRows("jules", out);
    expect(after.slice(0, 3).map(({ line: _l, ...r }) => r)).toEqual(before.map(({ line: _l, ...r }) => r));
    expect(after[3]).toMatchObject({ id: "ev-new2", place: "De Kade | room 2", notes: "Bring the folder\nAnd water", repeat: "weekly until 2026-12-31" });
  });

  it("an all-day row says so in Start and reads back as the whole day", () => {
    const out = placeRow("jules", `${TABLE}`, { id: "ev-ad", date: "2026-10-06", startMin: 0, durationMin: 1440, title: "Open day", task: null, allDay: true });
    expect(out).toContain("| 2026-10-06 | all day |  | Open day |  | ev-ad |");
    expect(parseCalendarRows("jules", out)[0]).toMatchObject({ id: "ev-ad", allDay: true, startMin: 0, durationMin: 1440 });
    // A row with neither time is still no row (it was skipped before too).
    expect(parseCalendarRows("jules", `${TABLE}| 2026-10-07 |  |  | Nothing |  |  |\n`)).toEqual([]);
  });
});

describe("Repeat words", () => {
  it("reads what the app writes and what a person types", () => {
    expect(parseRepeat("weekly")).toEqual({ every: "week", interval: 1, until: null, skip: [] });
    expect(parseRepeat("Every 2 weeks until 2026-12-31, skip 2026-11-04 2026-11-18")).toEqual({ every: "week", interval: 2, until: "2026-12-31", skip: ["2026-11-04", "2026-11-18"] });
    expect(parseRepeat("fortnightly")).toMatchObject({ every: "week", interval: 2 });
    expect(parseRepeat("monthly")).toMatchObject({ every: "month", interval: 1 });
    expect(parseRepeat("yearly")).toMatchObject({ every: "year", interval: 1 });
    expect(parseRepeat("every day")).toBeNull();
    expect(parseRepeat("weekly until 2026-02-30")).toBeNull();
    for (const r of [
      { every: "week", interval: 1, until: null, skip: [] },
      { every: "week", interval: 2, until: "2026-12-31", skip: ["2026-11-04"] },
      { every: "month", interval: 1, until: null, skip: ["2026-12-07", "2026-11-07"] },
      { every: "year", interval: 1, until: "2030-01-01", skip: [] },
    ] as const) {
      expect(parseRepeat(repeatCell({ ...r, skip: [...r.skip] }))).toEqual({ ...r, skip: [...r.skip].sort() });
    }
  });
});

describe("your events over the API", () => {
  let b: Awaited<ReturnType<typeof buildServer>>;
  let headers: Record<string, string>;
  let feedServer: http.Server;
  let feedUrl = "";
  const call = async (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: object) => {
    const res = await b.app.inject({ method, url, headers, ...(payload && { payload }) });
    return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null, body: res.body };
  };
  type Ev = { id: string; title: string; date: string; startMin: number; durationMin: number; allDay?: boolean; source?: string; seriesId?: string; repeat?: unknown; details?: { location?: string; description?: string }; color?: string | null; feedId?: string };
  const range = async (from: string, to: string) => ((await call("GET", `/api/events?from=${from}&to=${to}`)).json as Ev[]).filter((e) => e.source !== "ics");
  const noteText = (month: string) => fs.readFileSync(path.join(vault, `01-Me/Calendar/${month}.md`), "utf8");

  // Every second Wednesday at 18:00 until the year's end, as a subscribed calendar writes it.
  const FEED = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    "UID:choir@example.com",
    "SUMMARY:Choir",
    "DTSTART:20261007T180000",
    "DTEND:20261007T193000",
    "RRULE:FREQ=WEEKLY;INTERVAL=2;UNTIL=20261231",
    "EXDATE:20261104T180000",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");

  beforeAll(async () => {
    fs.mkdirSync(path.join(vault, "01-Me/Calendar"), { recursive: true });
    b = await buildServer();
    // A one-person 01-Me, as in calendar-notes.test.ts: Jules's calendar lives in 01-Me/Calendar.
    b.db.insert(tables.teams).values({ id: "t-solo", slug: "solo", name: "Solo", color: "#888888" }).run();
    b.db.insert(tables.folderGrants).values({ id: "g-solo", teamId: "t-solo", folder: "01-Me", role: "editor" }).run();
    headers = signedIn(sessionOf(await b.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "jules@orrama.dev", password: "orrama-demo" } })));
    feedServer = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/calendar" });
      res.end(FEED);
    });
    await new Promise<void>((r) => feedServer.listen(0, "127.0.0.1", r));
    feedUrl = `http://127.0.0.1:${(feedServer.address() as AddressInfo).port}/choir.ics`;
  });
  afterAll(async () => {
    await b.app.close();
    await new Promise<void>((r) => feedServer.close(() => r()));
    fs.rmSync(process.env.ORRAMA_DATA_DIR!, { recursive: true, force: true });
  });

  it("an event takes a place, notes and an all-day day, and gives them back", async () => {
    const made = await call("POST", "/api/events", { title: "Dentist", date: "2026-10-20", startMin: 615, durationMin: 45, place: "Kade 12, Amsterdam", notes: "Bring the card\nAsk about the X-ray" });
    expect(made.status).toBe(200);
    expect(made.json).toMatchObject({ startMin: 615, durationMin: 45, place: "Kade 12, Amsterdam", notes: "Bring the card\nAsk about the X-ray" });
    expect(noteText("2026-10")).toContain("| 2026-10-20 | 10:15 | 11:00 | Dentist |  | " + made.json.id + " | Kade 12, Amsterdam | Bring the card<br>Ask about the X-ray |  |");
    const [ev] = (await range("2026-10-20", "2026-10-20")).filter((e) => e.title === "Dentist");
    expect(ev).toMatchObject({ details: { location: "Kade 12, Amsterdam", description: "Bring the card\nAsk about the X-ray" } });

    // Day and time typed; the place emptied goes, the notes stay.
    const moved = await call("PATCH", `/api/events/${made.json.id}`, { date: "2026-10-21", startMin: 840, durationMin: 30, place: "" });
    expect(moved.json).toMatchObject({ date: "2026-10-21", startMin: 840, durationMin: 30, place: null, notes: "Bring the card\nAsk about the X-ray" });

    const day = await call("POST", "/api/events", { title: "Open day", date: "2026-10-24", allDay: true });
    expect(day.status).toBe(200);
    expect((await range("2026-10-24", "2026-10-24")).find((e) => e.title === "Open day")).toMatchObject({ allDay: true, startMin: 0, durationMin: 1440 });
    expect(noteText("2026-10")).toContain("| 2026-10-24 | all day |  | Open day |  | " + day.json.id + " |");
  });

  it("a repeating event lands on the days a subscribed calendar with the same rule lands on", async () => {
    const made = await call("POST", "/api/events", { title: "Choir", date: "2026-10-07", startMin: 18 * 60, durationMin: 90, repeat: { every: "week", interval: 2, until: "2026-12-31" } });
    expect(made.status).toBe(200);
    // This one off, the way "Delete → This one" does it.
    expect((await call("DELETE", `/api/events/${made.json.id}@2026-11-04`)).status).toBe(200);
    expect(noteText("2026-10")).toContain(`| ${made.json.id} |  |  | every 2 weeks until 2026-12-31, skip 2026-11-04 |`);

    const own = (await range("2026-09-01", "2027-02-28")).filter((e) => e.title === "Choir").map((e) => [e.date, e.startMin, e.durationMin]);
    const feed = expandIcs(parseIcs(FEED), "2026-09-01", "2027-02-28").map((o) => [o.date, o.startMin, o.durationMin]);
    expect(own).toEqual(feed);
    expect(own.map((o) => o[0])).toEqual(["2026-10-07", "2026-10-21", "2026-11-18", "2026-12-02", "2026-12-16", "2026-12-30"]);

    // The same through a real subscription: both layers, the same days.
    const sub = await call("POST", "/api/calendar/feeds", { label: "Choir feed", url: feedUrl });
    expect(sub.status).toBe(200);
    const all = (await call("GET", "/api/events?from=2026-09-01&to=2027-02-28")).json as Ev[];
    expect(all.filter((e) => e.source === "ics").map((e) => [e.date, e.startMin, e.durationMin])).toEqual(own);
    expect((await call("DELETE", `/api/calendar/feeds/${sub.json.id}`)).status).toBe(200);
    expect((await call("DELETE", `/api/events/${made.json.id}?scope=all`)).status).toBe(200);
  });

  it("monthly and yearly repeat from their first day; for ever has no end", async () => {
    const rent = await call("POST", "/api/events", { title: "Rent call", date: "2026-10-15", startMin: 540, durationMin: 30, repeat: { every: "month", interval: 1, until: null } });
    const bday = await call("POST", "/api/events", { title: "Birthday", date: "2026-11-02", allDay: true, repeat: { every: "year", interval: 1, until: null } });
    const days = (await range("2026-10-01", "2028-12-31")).filter((e) => e.title === "Rent call" || e.title === "Birthday");
    expect(days.filter((e) => e.title === "Rent call")).toHaveLength(27);
    expect(days.filter((e) => e.title === "Birthday").map((e) => [e.date, e.allDay])).toEqual([
      ["2026-11-02", true],
      ["2027-11-02", true],
      ["2028-11-02", true],
    ]);
    expect(days.find((e) => e.title === "Rent call")).toMatchObject({ id: `${rent.json.id}@2026-10-15`, seriesId: rent.json.id, repeat: { every: "month", interval: 1, until: null } });
    for (const e of [rent, bday]) await call("DELETE", `/api/events/${e.json.id}?scope=all`);
  });

  it("this one changes one day of a series; all changes every day of it", async () => {
    const made = await call("POST", "/api/events", { title: "Standup", date: "2026-10-05", startMin: 540, durationMin: 15, repeat: { every: "week", interval: 1, until: "2026-12-14" } });
    const id = made.json.id as string;
    const standups = async () => (await range("2026-10-01", "2026-12-31")).filter((e) => e.title.startsWith("Standup"));

    // This one: the 19th moves to Tuesday at 10:00, renamed; every other Monday stays.
    const one = await call("PATCH", `/api/events/${id}@2026-10-19`, { scope: "one", date: "2026-10-20", startMin: 600, title: "Standup (moved)" });
    expect(one.status).toBe(200);
    expect(one.json).toMatchObject({ date: "2026-10-20", startMin: 600, durationMin: 15, repeat: null });
    let list = await standups();
    expect(list.map((e) => `${e.date} ${e.startMin} ${e.title}`).slice(0, 4)).toEqual(["2026-10-05 540 Standup", "2026-10-12 540 Standup", "2026-10-20 600 Standup (moved)", "2026-10-26 540 Standup"]);
    expect(list).toHaveLength(11);

    // All: a typed day a day later moves every day of the series, and the left-out day with it.
    const all = await call("PATCH", `/api/events/${id}@2026-10-26`, { scope: "all", date: "2026-10-27", startMin: 570 });
    expect(all.status).toBe(200);
    list = (await standups()).filter((e) => e.title === "Standup");
    expect(list.map((e) => e.date)).toEqual(["2026-10-06", "2026-10-13", "2026-10-27", "2026-11-03", "2026-11-10", "2026-11-17", "2026-11-24", "2026-12-01", "2026-12-08"]);
    expect(list.every((e) => e.startMin === 570)).toBe(true);
    expect(noteText("2026-10")).toContain(`| 2026-10-06 | 09:30 | 09:45 | Standup |  | ${id} |  |  | weekly until 2026-12-14, skip 2026-10-20 |`);

    // A day the series doesn't fall on is no day of it.
    expect((await call("PATCH", `/api/events/${id}@2026-10-28`, { title: "x" })).status).toBe(404);
    // A repeat that ends before it starts is refused, and nothing is written.
    expect((await call("PATCH", `/api/events/${id}@2026-10-27`, { scope: "all", repeat: { every: "week", interval: 1, until: "2026-01-01" } })).status).toBe(400);

    // Delete all: the series goes; the day changed on its own stays (it is its own event now).
    expect((await call("DELETE", `/api/events/${id}@2026-11-03?scope=all`)).status).toBe(200);
    expect((await standups()).map((e) => e.title)).toEqual(["Standup (moved)"]);
    await call("DELETE", `/api/events/${one.json.id}`);
  });

  it("Today's week and the scheduler see every day of a series", async () => {
    const today = new Date();
    const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const start = iso(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 14));
    const made = await call("POST", "/api/events", { title: "Daily-ish review", date: start, startMin: 23 * 60, durationMin: 30, repeat: { every: "week", interval: 1, until: null } });
    const home = (await call("GET", "/api/home")).json as { agenda: { kind: string; title: string; date: string }[] };
    expect(home.agenda.filter((r) => r.kind === "event" && r.title === "Daily-ish review")).toHaveLength(1);
    await call("DELETE", `/api/events/${made.json.id}?scope=all`);

    // Plan my week: a Wednesday that repeats from a month back is busy every week.
    const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate() + (((8 - today.getDay()) % 7) || 7) + 7, 12);
    const day = (n: number) => iso(new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + n, 12));
    await noteIdOf("01-Me/Backlog.md", `# Backlog\n\n${Array.from({ length: 16 }, (_, i) => `- [ ] carefully draft and review the full section number ${i} !p1`).join("\n")}\n`);
    const series = await call("POST", "/api/events", { title: "Lab day", date: day(2 - 35), startMin: 8 * 60, durationMin: 10 * 60, repeat: { every: "week", interval: 1, until: null } });
    const plan = (await call("POST", "/api/plan/auto", { from: day(0), to: day(4) })).json as { proposals: { date: string; startMin: number; durationMin: number }[] };
    expect(plan.proposals.length).toBeGreaterThan(0);
    expect(plan.proposals.filter((p) => p.date === day(2) && p.startMin < 18 * 60 && p.startMin + p.durationMin > 8 * 60)).toEqual([]);
    await call("DELETE", `/api/events/${series.json.id}?scope=all`);
  });

  it("a subscribed calendar is renamed and given a colour, and its days carry them", async () => {
    const sub = await call("POST", "/api/calendar/feeds", { label: "Uni", url: feedUrl });
    const renamed = await call("PATCH", `/api/calendar/feeds/${sub.json.id}`, { label: "Choir (uni)", color: "c3" });
    expect(renamed.status).toBe(200);
    expect(renamed.json).toMatchObject({ label: "Choir (uni)", color: "c3" });
    expect((await call("GET", "/api/calendar/feeds")).json.find((f: { id: string }) => f.id === sub.json.id)).toMatchObject({ label: "Choir (uni)", color: "c3" });
    const days = ((await call("GET", "/api/events?from=2026-10-01&to=2026-10-31")).json as Ev[]).filter((e) => e.source === "ics");
    expect(days.length).toBeGreaterThan(0);
    expect(days.every((e) => e.feedId === sub.json.id && e.color === "c3")).toBe(true);
    expect((await call("PATCH", `/api/calendar/feeds/${sub.json.id}`, { color: null })).json.color).toBeNull();
    expect((await call("PATCH", `/api/calendar/feeds/${sub.json.id}`, { color: "red" })).status).toBe(400);
    expect((await call("PATCH", `/api/calendar/feeds/${sub.json.id}`, { label: " " })).status).toBe(400);
    expect((await call("PATCH", "/api/calendar/feeds/feed-nope", { label: "x" })).status).toBe(404);

    // Another account's calendar is not yours to rename.
    const erin = signedIn(sessionOf(await b.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "erin@orrama.dev", password: "orrama-demo" } })));
    expect((await b.app.inject({ method: "PATCH", url: `/api/calendar/feeds/${sub.json.id}`, headers: erin, payload: { label: "mine now" } })).statusCode).toBe(404);
    await call("DELETE", `/api/calendar/feeds/${sub.json.id}`);
  });

  it("the published feed has every step booked on your calendar, and your series as one rule", async () => {
    // A step written in a project's note carries no @you: its task object has no assignee.
    fs.mkdirSync(path.join(vault, "01-Me/Kade"), { recursive: true });
    const put = await call("POST", "/api/tasks/blocks", { noteId: await noteIdOf("01-Me/Kade/Plan.md", "# Plan\n\n- [ ] Draft the brief\n"), line: 2, text: "Draft the brief", date: "2026-10-22", startMin: 600, durationMin: 60 });
    expect(put.status).toBe(200);
    expect(b.db.select().from(tables.taskObjects).where(eq(tables.taskObjects.id, put.json.taskObject.id)).get()?.assigneeId ?? null).toBeNull();
    const series = await call("POST", "/api/events", { title: "Choir", date: "2026-10-07", startMin: 18 * 60, durationMin: 90, place: "De Kade", repeat: { every: "week", interval: 2, until: "2026-12-31" } });
    await call("DELETE", `/api/events/${series.json.id}@2026-11-04`);

    const token = (await call("POST", "/api/me/ics-token")).json.token as string;
    const ics = (await b.app.inject({ method: "GET", url: `/ics/${token}.ics` })).body;
    expect(ics).toContain("SUMMARY:Draft the brief");
    expect(ics).toContain("RRULE:FREQ=WEEKLY;INTERVAL=2;UNTIL=");
    expect(ics).toContain("LOCATION:De Kade");
    // Read back by the ICS reader, the series is the days Planning draws.
    const back = expandIcs(parseIcs(ics), "2026-10-01", "2026-12-31").filter((o) => o.title === "Choir").map((o) => [o.date, o.startMin]);
    expect(back).toEqual((await range("2026-10-01", "2026-12-31")).filter((e) => e.title === "Choir").map((e) => [e.date, e.startMin]));
    expect(back.map((o) => o[0])).not.toContain("2026-11-04");
    await call("DELETE", `/api/events/${series.json.id}?scope=all`);
  });

  /** Write a note through the API and wait for its id. */
  async function noteIdOf(p: string, content: string): Promise<string> {
    const res = await b.app.inject({ method: "PUT", url: "/api/vault/note", headers, payload: { path: p, content } });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body).id;
  }
});
