/**
 * Audit B10, calendar half: a database from before calendar notes holds its
 * blocks and events as rows alone (cal_note_id NULL). The first boot writes
 * each into its owner's month note, once; from then on the notes are read.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

process.env.BASALT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "basalt-legacycal-"));
process.env.BASALT_VAULT_DIR = path.join(process.env.BASALT_DATA_DIR, "vault");
process.env.BASALT_JWT_SECRET = "test-secret";
process.env.BASALT_SECRET_KEY = "test-secret-key-0123456789abcdef";

await import("../src/seed.js");
const { buildServer } = await import("../src/main.js");
const { createDb, tables } = await import("../src/db.js");
const vault = process.env.BASALT_VAULT_DIR!;

afterAll(() => fs.rmSync(process.env.BASALT_DATA_DIR!, { recursive: true, force: true }));

describe("legacy calendar rows", () => {
  it("are written into calendar notes on first boot, with their ids", async () => {
    // The seed's promoted task (erin's spike) gets an old-style block; jules an old-style event.
    const db = createDb();
    const users = new Map(db.select().from(tables.users).all().map((u) => [u.username, u.id]));
    const obj = db.select().from(tables.taskObjects).get()!;
    db.insert(tables.taskBlocks).values({ id: "blk-legacy1", taskObjectId: obj.id, date: "2026-07-09", startMin: 600, durationMin: 90, createdAt: 1 }).run();
    db.insert(tables.events).values({ id: "ev-legacy1", ownerId: users.get("jules")!, title: "Old standup", date: "2026-07-10", startMin: 540, durationMin: 30, createdAt: 2 }).run();

    const b = await buildServer();
    const julesNote = fs.readFileSync(path.join(vault, "01-Me/Calendar/2026-07.md"), "utf8");
    expect(julesNote).toContain("| 2026-07-10 | 09:00 | 09:30 | Old standup |  | ev-legacy1 |");
    // The block belongs to the task's assignee (erin), who writes to her own calendar.
    const erinNote = fs.readFileSync(path.join(vault, "Personal/erin/Calendar/2026-07.md"), "utf8");
    expect(erinNote).toMatch(/\| 2026-07-09 \| 10:00 \| 11:30 \| partial checkout spike \| \[\[Engineering\/Atlas Roadmap#\^t-[\w-]+\]\] \| blk-legacy1 \|/);
    // …and the rows are now read from those notes.
    expect(b.db.select().from(tables.events).where(eq(tables.events.id, "ev-legacy1")).get()?.calNoteId).toBeTruthy();
    expect(b.db.select().from(tables.taskBlocks).where(eq(tables.taskBlocks.id, "blk-legacy1")).get()?.calNoteId).toBeTruthy();
    expect(b.db.select().from(tables.meta).where(eq(tables.meta.key, "b10-calendar-notes")).get()).toBeTruthy();
    await b.app.close();
  });
});
