/**
 * The architecture's promise: delete the database, re-index the Markdown, and
 * everything the vault says comes back (CLAUDE.md, "Architecture in one
 * paragraph"). Audit B10 found three things that did not — task status,
 * time blocks and calendar events. This drives all three through the API,
 * throws the index away, boots on the same vault, and compares.
 *
 * Accounts and team settings are not vault data: they are copied across, the
 * way a real rebuild would keep them. Everything else starts empty.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";

process.env.BASALT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "basalt-rebuild-"));
process.env.BASALT_VAULT_DIR = path.join(process.env.BASALT_DATA_DIR, "vault");
process.env.BASALT_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.BASALT_SECRET_KEY = "test-secret-key-0123456789abcdef";

await import("../src/seed.js");
const { buildServer } = await import("../src/main.js");
const { tables, createDb } = await import("../src/db.js");
const { closeDb } = await import("./helpers/db.js");

type Booted = Awaited<ReturnType<typeof buildServer>>;
const dbFile = path.join(process.env.BASALT_DATA_DIR!, "basalt.db");
const vault = process.env.BASALT_VAULT_DIR!;

afterAll(() => fs.rmSync(process.env.BASALT_DATA_DIR!, { recursive: true, force: true }));

async function session(b: Booted) {
  const tokens: Record<string, string> = {};
  for (const who of ["jules", "erin"]) {
    tokens[who] = (await b.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: `${who}@basalt.dev`, password: "basalt-demo" } })).json().token;
  }
  return async (who: string, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: object) => {
    const r = await b.app.inject({ method, url, headers: { authorization: `Bearer ${tokens[who]}` }, ...(payload ? { payload } : {}) });
    return { status: r.statusCode, body: r.body ? r.json() : null };
  };
}

/** What the vault says, read back through the index — ids included. */
function snapshot(b: Booted) {
  const { db, store } = b;
  const user = new Map(db.select().from(tables.users).all().map((u) => [u.id, u.username]));
  const objects = new Map(db.select().from(tables.taskObjects).all().map((o) => [o.id, o]));
  const statuses = store.index
    .all()
    .flatMap((n) => n.tasks.map((t) => `${n.path}:${t.line}:${t.status}`))
    .sort();
  const events = db
    .select()
    .from(tables.events)
    .all()
    .map((e) => `${e.id} ${user.get(e.ownerId)} ${e.date} ${e.startMin}+${e.durationMin} ${e.title}`)
    .sort();
  const blocks = db
    .select()
    .from(tables.taskBlocks)
    .all()
    .map((bk) => {
      const o = objects.get(bk.taskObjectId);
      return `${bk.id} ${bk.date} ${bk.startMin}+${bk.durationMin} ${store.index.get(o?.noteId ?? "")?.path}#${o?.blockId} ${o?.status}`;
    })
    .sort();
  return { statuses, events, blocks };
}

describe("delete the database, re-index the vault", () => {
  let before: ReturnType<typeof snapshot>;

  it("builds real state through the API", async () => {
    const b = await buildServer();
    const call = await session(b);
    const roadmap = b.store.index.getByPath("Engineering/Atlas Roadmap.md")!;
    const arch = b.store.index.getByPath("Engineering/Atlas Architecture.md")!;
    const at = (n: typeof roadmap, text: string) => {
      const t = n.tasks.find((x) => x.text.startsWith(text))!;
      return { line: t.line, text: t.raw };
    };

    // status: one of each middle state
    expect((await call("jules", "POST", "/api/tasks/status", { noteId: roadmap.id, ...at(roadmap, "dashboard API"), status: "in-progress" })).status).toBe(200);
    expect((await call("jules", "POST", "/api/tasks/status", { noteId: arch.id, ...at(arch, "threat-model"), status: "blocked" })).status).toBe(200);

    // blocks: booked, moved into the next month, resized; erin books her own
    const blk = await call("jules", "POST", "/api/tasks/blocks", { noteId: arch.id, ...at(arch, "threat-model"), date: "2026-10-30", startMin: 540, durationMin: 90 });
    expect(blk.status).toBe(200);
    expect((await call("jules", "PATCH", `/api/blocks/${blk.body.id}`, { date: "2026-11-02", startMin: 600, durationMin: 120 })).status).toBe(200);
    const second = await call("jules", "POST", "/api/tasks/blocks", { noteId: roadmap.id, ...at(roadmap, "dashboard API"), date: "2026-10-05", startMin: 840 });
    expect(second.status).toBe(200);
    const erinBlk = await call("erin", "POST", "/api/tasks/blocks", { noteId: roadmap.id, ...at(b.store.index.get(roadmap.id)!, "permission test suite"), date: "2026-10-06", startMin: 480 });
    expect(erinBlk.status).toBe(200);

    // events: created, renamed (with a pipe in the title), moved, one deleted
    const dentist = await call("jules", "POST", "/api/events", { title: "Dentist", date: "2026-10-02", startMin: 540 });
    const sup = await call("jules", "POST", "/api/events", { title: "Supervision", date: "2026-10-09", startMin: 780, durationMin: 60 });
    const gone = await call("jules", "POST", "/api/events", { title: "Cancelled call", date: "2026-10-12", startMin: 600 });
    expect((await call("jules", "PATCH", `/api/events/${sup.body.id}`, { title: "Supervision | thesis", date: "2026-11-09" })).status).toBe(200);
    expect((await call("jules", "DELETE", `/api/events/${gone.body.id}`)).status).toBe(200);
    expect((await call("erin", "POST", "/api/events", { title: "Erin 1:1", date: "2026-10-07", startMin: 600 })).status).toBe(200);
    expect(dentist.status).toBe(200);

    before = snapshot(b);
    expect(before.events).toHaveLength(3);
    expect(before.blocks).toHaveLength(3);
    expect(before.statuses.some((s) => s.endsWith(":in-progress"))).toBe(true);
    expect(before.statuses.some((s) => s.endsWith(":blocked"))).toBe(true);
    await b.app.close();
  });

  it("wrote it where a person can read it", () => {
    // erin and mara read 01-Me through the seed's root viewer grants, so
    // jules's calendar is in his personal folder (ACL-009).
    const oct = fs.readFileSync(path.join(vault, "Personal/jules/Calendar/2026-10.md"), "utf8");
    const nov = fs.readFileSync(path.join(vault, "Personal/jules/Calendar/2026-11.md"), "utf8");
    expect(oct).toMatch(/^calendar: jules$/m);
    expect(oct).toContain("| 2026-10-02 | 09:00 | 10:00 | Dentist |  |");
    expect(oct).toMatch(/\| 2026-10-05 \| 14:00 \| 16:00 \| dashboard API \| \[\[Engineering\/Atlas Roadmap#\^t-[\w-]+\]\] \| blk-/);
    expect(oct).not.toContain("Cancelled call");
    expect(oct).not.toContain("threat-model"); // moved to November
    expect(nov).toMatch(/\| 2026-11-02 \| 10:00 \| 12:00 \| threat-model the sync server \| \[\[Engineering\/Atlas Architecture#\^t-/);
    expect(nov).toContain("| Supervision \\| thesis |");
    // erin cannot edit 01-Me, so her calendar is hers by path
    expect(fs.readFileSync(path.join(vault, "Personal/erin/Calendar/2026-10.md"), "utf8")).toContain("Erin 1:1");
    expect(fs.readFileSync(path.join(vault, "Engineering/Atlas Architecture.md"), "utf8")).toMatch(/- \[b\] threat-model/);
  });

  it("comes back identical on an empty database", async () => {
    wipeIndex();
    const b = await buildServer();
    expect(snapshot(b)).toEqual(before);

    // …and it is the calendar the API serves, not just rows in a table.
    const call = await session(b);
    const titles = (await call("jules", "GET", "/api/events?from=2026-10-01&to=2026-11-30")).body.map((e: { title: string }) => e.title).sort();
    expect(titles).toEqual(["Dentist", "Supervision | thesis"]);
    await b.app.close();
  });

  it("a note copied while the database is gone: the original keeps its id, and its blocks", async () => {
    // Nothing in the notes table says which file is the note, so the one
    // created first keeps the id (noteIds.ts). The original is then edited,
    // which makes the stale copy the file with the OLDER mtime.
    const ORIG = "Engineering/Atlas Roadmap.md";
    const COPY = "Engineering/Atlas Roadmap copy.md"; // Finder's Duplicate
    const idOf = (rel: string) => /^id: (n-\S+)$/m.exec(fs.readFileSync(path.join(vault, rel), "utf8"))?.[1];
    const id = idOf(ORIG)!;
    fs.copyFileSync(path.join(vault, ORIG), path.join(vault, COPY));
    await new Promise((r) => setTimeout(r, 20));
    fs.appendFileSync(path.join(vault, ORIG), "\nEdited after the copy.\n");
    expect(fs.statSync(path.join(vault, COPY)).mtimeMs).toBeLessThan(fs.statSync(path.join(vault, ORIG)).mtimeMs);

    wipeIndex();
    const b = await buildServer();
    expect(idOf(ORIG)).toBe(id);
    expect(idOf(COPY)).toMatch(/^n-/);
    expect(idOf(COPY)).not.toBe(id);
    expect(b.store.index.get(id)?.path).toBe(ORIG);
    expect(b.store.index.getByPath(COPY)?.id).toBe(idOf(COPY));
    // The calendar rows name the task by path; they still land on the note.
    expect(snapshot(b).blocks).toEqual(before.blocks);
    expect(snapshot(b).events).toEqual(before.events);
    await b.app.close();
  });
});

/** Drop the index, keep the accounts — the way a real rebuild would. */
function wipeIndex() {
  const old = new Database(dbFile, { readonly: true });
  const keep = ["users", "teams", "memberships", "folder_grants", "workspace"].map((t) => ({ t, rows: old.prepare(`SELECT * FROM ${t}`).all() as Record<string, unknown>[] }));
  old.close();
  for (const f of ["basalt.db", "basalt.db-wal", "basalt.db-shm"]) fs.rmSync(path.join(process.env.BASALT_DATA_DIR!, f), { force: true });
  closeDb(createDb()); // bootstrap the schema
  const fresh = new Database(dbFile);
  for (const { t, rows } of keep) {
    for (const r of rows) {
      const cols = Object.keys(r);
      fresh.prepare(`INSERT INTO ${t} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(...cols.map((c) => r[c] as never));
    }
  }
  expect(fresh.prepare("SELECT count(*) AS n FROM events").get()).toEqual({ n: 0 });
  fresh.close();
}
