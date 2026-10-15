/**
 * Calendar notes (audit B10): the block and event tables are an index of
 * Markdown notes in 01-Me/Calendar/. These pin the rules the index follows
 * when the note is edited by hand — in Obsidian, or anywhere else.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.ORRAMA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "basalt-calnotes-"));
process.env.ORRAMA_VAULT_DIR = path.join(process.env.ORRAMA_DATA_DIR, "vault");
process.env.ORRAMA_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.ORRAMA_SECRET_KEY = "test-secret-key-0123456789abcdef";

await import("../src/seed.js");
const { buildServer } = await import("../src/main.js");
const { tables } = await import("../src/db.js");
const { parseCalendarRows, placeRow, renderRow } = await import("../src/calendarNotes.js");

const vault = process.env.ORRAMA_VAULT_DIR!;
const TABLE = "| Date | Start | End | What | Task | id |\n| --- | --- | --- | --- | --- | --- |\n";

describe("parseCalendarRows", () => {
  it("reads rows, skips the malformed ones, and gives a hand-typed row a stable id", () => {
    const note = `# Oct\n\n${TABLE}| 2026-10-02 | 09:00 | 10:30 | Dentist |  | ev-abc123 |\n| 2026-10-03 | 11:00 | 10:00 | ends before it starts |  |  |\n| 2026-13-01 | 09:00 | 10:00 | no such month |  |  |\n| 2026-02-30 | 09:00 | 10:00 | no such day |  |  |\n| someday | 09:00 | 10:00 | not a date |  |  |\n| 2026-10-04 | 14:00 | 15:00 | Typed in Obsidian |  |  |\n\nafter the table`;
    const rows = parseCalendarRows("jules", note);
    expect(rows.map((r) => [r.id.slice(0, 3), r.date, r.startMin, r.durationMin, r.title])).toEqual([
      ["ev-", "2026-10-02", 540, 90, "Dentist"],
      ["ev-", "2026-10-04", 840, 60, "Typed in Obsidian"],
    ]);
    expect(rows[0]!.id).toBe("ev-abc123");
    // Same text, same id — the index does not churn on every re-read.
    expect(parseCalendarRows("jules", note)[1]!.id).toBe(rows[1]!.id);
    // Keyed by the calendar's owner: another person's identical line is
    // another event; a copy of the same person's note is the same one.
    expect(parseCalendarRows("erin", note)[1]!.id).not.toBe(rows[1]!.id);
  });

  it("round-trips a title with a pipe and a task link", () => {
    const row = { id: "blk-1", date: "2026-10-05", startMin: 600, durationMin: 30, title: "A | B", task: { notePath: "04-Projects/thesis", blockId: "t-x1" } };
    const [back] = parseCalendarRows("n", `${TABLE}${renderRow(row)}\n`);
    expect(back).toMatchObject(row);
  });

  it("places a new row in date order and replaces an existing one in place", () => {
    let c = `${TABLE}| 2026-10-01 | 09:00 | 10:00 | a |  | ev-a |\n| 2026-10-09 | 09:00 | 10:00 | c |  | ev-c |\n`;
    c = placeRow("n", c, { id: "ev-b", date: "2026-10-05", startMin: 540, durationMin: 60, title: "b", task: null });
    expect(parseCalendarRows("n", c).map((r) => r.id)).toEqual(["ev-a", "ev-b", "ev-c"]);
    c = placeRow("n", c, { id: "ev-a", date: "2026-10-01", startMin: 600, durationMin: 60, title: "a later", task: null });
    expect(parseCalendarRows("n", c).map((r) => `${r.id}:${r.title}`)).toEqual(["ev-a:a later", "ev-b:b", "ev-c:c"]);
  });
});

describe("the index follows the notes", () => {
  let b: Awaited<ReturnType<typeof buildServer>>;
  let julesId = "";
  const eventsOf = () => b.db.select().from(tables.events).where(eq(tables.events.ownerId, julesId)).all().map((e) => e.title).sort();
  // The watcher debounces 300ms; under a loaded CI box (or three suites in
  // parallel) that has taken over 3s, so wait up to 10.
  const until = async (ok: () => boolean) => {
    for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 50));
  };

  beforeAll(async () => {
    // The folder exists before the watcher starts: a file created in the same
    // instant as its new folder can land before chokidar attaches to the
    // folder — a watcher race, not the calendar's, and it made this flaky
    // under a loaded full run.
    fs.mkdirSync(path.join(vault, "01-Me/Calendar"), { recursive: true });
    b = await buildServer();
    // 01-Me as it is on a one-person install: no other account reads it. The
    // seed's root viewer grants would let erin and mara read it, and the app
    // then keeps jules's calendar in Personal/jules/Calendar instead (ACL-009).
    b.db.insert(tables.teams).values({ id: "t-solo", slug: "solo", name: "Solo", color: "#888888" }).run();
    b.db.insert(tables.folderGrants).values({ id: "g-solo", teamId: "t-solo", folder: "01-Me", role: "editor" }).run();
    julesId = b.db.select().from(tables.users).where(eq(tables.users.username, "jules")).get()!.id;
  });
  afterAll(async () => {
    await b.app.close();
    fs.rmSync(process.env.ORRAMA_DATA_DIR!, { recursive: true, force: true });
  });

  it("an edit made outside Basalt (Obsidian) moves the calendar", async () => {
    const file = path.join(vault, "01-Me/Calendar/2026-10.md");
    fs.writeFileSync(file, `---\ncalendar: jules\nmonth: "2026-10"\n---\n${TABLE}| 2026-10-02 | 09:00 | 10:00 | Dentist |  | ev-d1 |\n`);
    await until(() => eventsOf().includes("Dentist"));
    expect(eventsOf()).toEqual(["Dentist"]);

    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("Dentist", "Dentist (moved)"));
    await until(() => eventsOf().includes("Dentist (moved)"));
    expect(eventsOf()).toEqual(["Dentist (moved)"]);
    expect(b.db.select().from(tables.events).where(eq(tables.events.id, "ev-d1")).get()?.title).toBe("Dentist (moved)");
  }, 25_000);

  it("a copy of a calendar note does not double its hand-typed rows", async () => {
    const dir = path.join(vault, "01-Me/Calendar");
    fs.writeFileSync(path.join(dir, "2026-11.md"), `---\ncalendar: jules\nmonth: "2026-11"\n---\n${TABLE}| 2026-11-03 | 09:00 | 10:00 | Typed by hand |  |  |\n`);
    await until(() => eventsOf().includes("Typed by hand"));
    // Finder's Duplicate / `cp`: same rows, the copy gets its own note id.
    fs.copyFileSync(path.join(dir, "2026-11.md"), path.join(dir, "2026-11 copy.md"));
    await until(() => !!b.store.index.getByPath("01-Me/Calendar/2026-11 copy.md"));
    await new Promise((r) => setTimeout(r, 400)); // the copy's re-read
    const copy = b.store.index.getByPath("01-Me/Calendar/2026-11 copy.md")!;
    expect(copy.id).not.toBe(b.store.index.getByPath("01-Me/Calendar/2026-11.md")!.id);
    expect(eventsOf().filter((t) => t === "Typed by hand")).toHaveLength(1);
    fs.rmSync(path.join(dir, "2026-11 copy.md"));
    fs.rmSync(path.join(dir, "2026-11.md"));
    await until(() => !eventsOf().includes("Typed by hand"));
  }, 25_000);

  it("a hand-typed row edited or deleted in the app is that row, not a new one", async () => {
    const file = path.join(vault, "01-Me/Calendar/2026-12.md");
    fs.writeFileSync(file, `---\ncalendar: jules\nmonth: "2026-12"\n---\n${TABLE}| 2026-12-07 | 09:00 | 10:00 | Typed row |  |  |\n| 2026-12-08 | 09:00 | 10:00 | Another typed row |  |  |\n| 2026-12-09 | 09:00 | 10:00 | Moving on |  |  |\n`);
    await until(() => ["Typed row", "Another typed row", "Moving on"].every((t) => eventsOf().includes(t)));
    const idOf = (title: string) => b.db.select().from(tables.events).where(eq(tables.events.title, title)).get()!.id;
    const token = (await b.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "jules@basalt.dev", password: "basalt-demo" } })).json().token;
    const headers = { authorization: `Bearer ${token}` };
    const rowsIn = () => fs.readFileSync(file, "utf8").split("\n").filter((l) => l.startsWith("| 2026-12-"));

    // Each acts on a row with no id in the file: the route must derive the
    // same id the index did, or it cannot find the line.
    const gone = await b.app.inject({ method: "DELETE", url: `/api/events/${idOf("Another typed row")}`, headers });
    expect(gone.statusCode).toBe(200);
    expect(rowsIn().map((l) => l.split("|")[4]!.trim())).toEqual(["Typed row", "Moving on"]);

    // To another month: out of this note, into January's.
    const january = await b.app.inject({ method: "PATCH", url: `/api/events/${idOf("Moving on")}`, headers, payload: { date: "2027-01-04" } });
    expect(january.statusCode).toBe(200);
    expect(rowsIn().map((l) => l.split("|")[4]!.trim())).toEqual(["Typed row"]);
    const jan = path.join(vault, "01-Me/Calendar/2027-01.md");
    expect(fs.readFileSync(jan, "utf8")).toContain("| 2027-01-04 | 09:00 | 10:00 | Moving on |");
    expect((await b.app.inject({ method: "DELETE", url: `/api/events/${idOf("Moving on")}`, headers })).statusCode).toBe(200);

    const moved = await b.app.inject({ method: "PATCH", url: `/api/events/${idOf("Typed row")}`, headers, payload: { startMin: 600 } });
    expect(moved.statusCode).toBe(200);
    expect(rowsIn()).toHaveLength(1); // replaced in place, not added beside the typed one
    expect(rowsIn()[0]).toContain("| 10:00 | 11:00 | Typed row |");
    fs.rmSync(file);
    await until(() => !eventsOf().includes("Typed row"));
  }, 25_000);

  it("deleting the note takes its rows with it", async () => {
    fs.rmSync(path.join(vault, "01-Me/Calendar/2026-10.md"));
    await until(() => eventsOf().length === 0);
    expect(eventsOf()).toEqual([]);
  }, 15_000);

  it("a note naming you outside a calendar folder does not reach your calendar", async () => {
    // erin can edit Engineering/; jules (an owner) can edit anything, so the
    // edit check alone would have let her put events on his calendar.
    const token = (await b.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "erin@basalt.dev", password: "basalt-demo" } })).json().token;
    const put = await b.app.inject({
      method: "PUT",
      url: "/api/vault/note",
      headers: { authorization: `Bearer ${token}` },
      payload: { path: "Engineering/not a calendar.md", content: `---\ncalendar: jules\nmonth: "2026-10"\n---\n${TABLE}| 2026-10-03 | 09:00 | 17:00 | Planted by erin |  | ev-planted |\n` },
    });
    expect(put.statusCode).toBe(200);
    expect(eventsOf()).not.toContain("Planted by erin");
    expect(b.db.select().from(tables.events).where(eq(tables.events.id, "ev-planted")).get()).toBeUndefined();
  });
});
