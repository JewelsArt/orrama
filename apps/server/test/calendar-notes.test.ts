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

process.env.BASALT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "basalt-calnotes-"));
process.env.BASALT_VAULT_DIR = path.join(process.env.BASALT_DATA_DIR, "vault");
process.env.BASALT_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.BASALT_SECRET_KEY = "test-secret-key-0123456789abcdef";

await import("../src/seed.js");
const { buildServer } = await import("../src/main.js");
const { tables } = await import("../src/db.js");
const { parseCalendarRows, placeRow, renderRow } = await import("../src/calendarNotes.js");

const vault = process.env.BASALT_VAULT_DIR!;
const TABLE = "| Date | Start | End | What | Task | id |\n| --- | --- | --- | --- | --- | --- |\n";

describe("parseCalendarRows", () => {
  it("reads rows, skips the malformed ones, and gives a hand-typed row a stable id", () => {
    const note = `# Oct\n\n${TABLE}| 2026-10-02 | 09:00 | 10:30 | Dentist |  | ev-abc123 |\n| 2026-10-03 | 11:00 | 10:00 | ends before it starts |  |  |\n| 2026-13-01 | 09:00 | 10:00 | no such month |  |  |\n| 2026-02-30 | 09:00 | 10:00 | no such day |  |  |\n| someday | 09:00 | 10:00 | not a date |  |  |\n| 2026-10-04 | 14:00 | 15:00 | Typed in Obsidian |  |  |\n\nafter the table`;
    const rows = parseCalendarRows("n-1", note);
    expect(rows.map((r) => [r.id.slice(0, 3), r.date, r.startMin, r.durationMin, r.title])).toEqual([
      ["ev-", "2026-10-02", 540, 90, "Dentist"],
      ["ev-", "2026-10-04", 840, 60, "Typed in Obsidian"],
    ]);
    expect(rows[0]!.id).toBe("ev-abc123");
    // Same text, same id — the index does not churn on every re-read.
    expect(parseCalendarRows("n-1", note)[1]!.id).toBe(rows[1]!.id);
    expect(parseCalendarRows("n-2", note)[1]!.id).not.toBe(rows[1]!.id);
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
    julesId = b.db.select().from(tables.users).where(eq(tables.users.username, "jules")).get()!.id;
  });
  afterAll(async () => {
    await b.app.close();
    fs.rmSync(process.env.BASALT_DATA_DIR!, { recursive: true, force: true });
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
