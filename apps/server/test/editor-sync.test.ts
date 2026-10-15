/**
 * The web editor's sync (packages/sync/src/client.ts) against the real server.
 *
 * Audit B5, client side. The editors adopted the NEW hash whenever the server
 * sent a newer note but only swapped in the new TEXT while unfocused, so a
 * focused editor saved its stale buffer under a current hash and the server
 * wrote it over the other edit. These tests drive the exact NoteSync the web
 * app uses, over app.inject, through each way that used to lose text.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NoteSync, type SyncedNote } from "@orrama/sync/client";

process.env.ORRAMA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-editor-sync-"));
process.env.ORRAMA_VAULT_DIR = path.join(process.env.ORRAMA_DATA_DIR, "vault");
process.env.ORRAMA_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.ORRAMA_SECRET_KEY = "test-secret-key-0123456789abcdef";

const { buildServer } = await import("../src/main.js");

const VAULT = process.env.ORRAMA_VAULT_DIR;
let app: Awaited<ReturnType<typeof buildServer>>["app"];
let store: Awaited<ReturnType<typeof buildServer>>["store"];
let token = "";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const call = async (method: string, url: string, body?: unknown) => {
  const res = await app.inject({
    method: method as "GET",
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
  });
  if (res.statusCode !== 200) throw new Error(`${method} ${url} → ${res.statusCode} ${res.body}`);
  return res.json();
};

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n") + "\n";

/** Create a note and let the watcher's echo of our own write settle. */
const create = async (rel: string, content: string) => {
  const r = await call("PUT", "/api/vault/note", { path: rel, content });
  await sleep(700);
  return { id: r.id as string, rel, abs: path.join(VAULT, rel) };
};

/** Obsidian saves the file, and the watcher has had time to take it in. */
const obsidianSave = async (abs: string, next: (s: string) => string) => {
  fs.writeFileSync(abs, next(fs.readFileSync(abs, "utf8")));
  await sleep(700);
};

/**
 * Open a NoteSync the way the editor does. A save gate holds a PUT before it
 * reaches the server; a load gate delivers a GET late, after reading early.
 */
const open = async (note: { id: string; rel: string }, gates: { save?: Gate; load?: Gate } = {}) => {
  const initial = (await call("GET", `/api/vault/note/${note.id}`)) as SyncedNote;
  const applied: string[] = [];
  const states: string[] = [];
  const sync = new NoteSync(
    note.rel,
    initial,
    {
      save: async (body) => {
        if (gates.save) await gates.save.hold();
        const r = await call("PUT", "/api/vault/note", body);
        return { content: r.content, hash: r.hash };
      },
      load: async () => {
        const r = await call("GET", `/api/vault/note/${note.id}`);
        if (gates.load) await gates.load.hold(); // read now, delivered later
        return { content: r.content, hash: r.hash };
      },
    },
    { apply: (t) => applied.push(t), status: (s) => states.push(s) },
    60_000, // tests flush explicitly; the debounce never fires on its own
  );
  return { sync, applied, states, initial: initial.content };
};

/** Holds a request until released, and says when one has arrived at it. */
interface Gate {
  hold(): Promise<void>;
  reached: Promise<void>;
  release(): void;
}
const gate = (): Gate => {
  let release!: () => void;
  let arrive!: () => void;
  const wait = new Promise<void>((r) => (release = r));
  const reached = new Promise<void>((r) => (arrive = r));
  return { hold: () => (arrive(), wait), reached, release };
};

const count = (s: string, sub: string) => s.split(sub).length - 1;

beforeAll(async () => {
  await import("../src/seed.js");
  const built = await buildServer();
  app = built.app;
  store = built.store;
  const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "jules@orrama.dev", password: "orrama-demo" } });
  token = r.json().token;
});

afterAll(async () => {
  await app.close();
  fs.rmSync(process.env.ORRAMA_DATA_DIR!, { recursive: true, force: true });
});

describe("editor sync against the server", () => {
  it("saving while focused keeps an Obsidian edit the server already has — and shows it", async () => {
    const note = await create("Engineering/Sync Focused.md", lines(40));
    const { sync, applied, initial } = await open(note);

    sync.edit(initial.replace("line 5\n", "line 5 typed in Orrama\n"));
    await obsidianSave(note.abs, (s) => s.replace("line 30\n", "line 30 from Obsidian\n"));
    expect(store.index.get(note.id)!.content).toContain("line 30 from Obsidian"); // the server has it
    await sync.flush();

    const disk = fs.readFileSync(note.abs, "utf8");
    expect(disk).toContain("line 5 typed in Orrama\n");
    expect(disk).toContain("line 30 from Obsidian\n");
    expect(sync.content).toBe(disk); // …and the editor now shows it too
    expect(applied.at(-1)).toBe(disk);
    sync.close();
  });

  it("a live-sync refresh merges into unsaved typing instead of waiting for it", async () => {
    const note = await create("Engineering/Sync Refresh.md", lines(20));
    const { sync, initial } = await open(note);

    sync.edit(initial.replace("line 2\n", "line 2 unsaved\n"));
    await obsidianSave(note.abs, (s) => s.replace("line 18\n", "line 18 from Obsidian\n"));
    await sync.refresh();

    expect(sync.content).toContain("line 2 unsaved\n");
    expect(sync.content).toContain("line 18 from Obsidian\n");
    expect(sync.dirty).toBe(true); // the typing is still ours to save
    await sync.flush();
    expect(fs.readFileSync(note.abs, "utf8")).toBe(sync.content);
    sync.close();
  });

  it("two editors on one note (desktop and phone) both keep their edits and converge", async () => {
    const note = await create("Engineering/Sync Two.md", lines(40));
    const a = await open(note);
    const b = await open(note);

    a.sync.edit(a.initial.replace("line 5\n", "line 5 desktop\n"));
    b.sync.edit(b.initial.replace("line 30\n", "line 30 phone\n"));
    await a.sync.flush();
    await b.sync.flush(); // b's base is now stale by a's save
    await a.sync.refresh();

    const disk = fs.readFileSync(note.abs, "utf8");
    expect(disk).toContain("line 5 desktop\n");
    expect(disk).toContain("line 30 phone\n");
    expect(a.sync.content).toBe(disk);
    expect(b.sync.content).toBe(disk);
    a.sync.close();
    b.sync.close();
  });

  it("typing while a save is in flight is neither lost nor doubled", async () => {
    const note = await create("Engineering/Sync Inflight.md", lines(10));
    const g = gate();
    const { sync, initial } = await open(note, { save: g });

    const first = initial.replace("line 3\n", "line 3 first\n");
    sync.edit(first);
    const saving = sync.flush();
    await g.reached; // the request has left with `first`; now keep typing
    const more = first.replace("line 3 first\n", "line 3 first, then more\n") + "a new last line\n";
    sync.edit(more);
    g.release();
    await saving;
    await sync.flush();

    const disk = fs.readFileSync(note.abs, "utf8");
    expect(disk).toBe(more);
    expect(sync.content).toBe(more);
    sync.close();
  });

  // A refresh whose GET reads the note BEFORE a save lands but is delivered
  // AFTER it. Unqueued, that stale text is taken as "someone else's edit" and
  // undoes the save in the editor. Queued, the save waits behind the refresh.
  it("a slow refresh cannot roll the editor back past a save that finished first", async () => {
    const note = await create("Engineering/Sync Queue.md", lines(20));
    const g = gate();
    const { sync, initial } = await open(note, { load: g });

    sync.edit(initial.replace("line 4\n", "line 4 mine\n"));
    const refreshing = sync.refresh();
    await g.reached; // the GET has read the note as it was
    const saving = sync.flush();
    await sleep(300); // unqueued, the save completes here
    g.release();
    await refreshing;
    await saving;

    const disk = fs.readFileSync(note.abs, "utf8");
    expect(disk).toContain("line 4 mine\n");
    expect(sync.content).toBe(disk);
    sync.close();
  });

  it("an Obsidian edit and a save in the same moment both land, once each", async () => {
    const note = await create("Engineering/Sync Both.md", lines(20));
    const g = gate();
    const { sync, initial } = await open(note, { save: g });

    sync.edit(initial.replace("line 4\n", "line 4 mine\n"));
    const saving = sync.flush();
    await g.reached;
    await obsidianSave(note.abs, (s) => s.replace("line 16\n", "line 16 theirs\n"));
    const refreshing = sync.refresh();
    g.release();
    await saving;
    await refreshing;

    const disk = fs.readFileSync(note.abs, "utf8");
    expect(disk).toContain("line 4 mine\n");
    expect(count(disk, "line 16 theirs")).toBe(1);
    expect(sync.content).toBe(disk);
    sync.close();
  });

  // The project page's note card loaded its note once and never again, while
  // the Decisions, Inbox and Goals cards write into that same note through the
  // server. Here no refresh reaches the card at all — the save alone must keep
  // the decision.
  it("a decision logged while the project note card is open survives the card's next save", async () => {
    const w = await call("GET", "/api/projects/atlas");
    const { sync, initial } = await open({ id: w.noteId, rel: w.path });
    await call("POST", "/api/projects/atlas/decisions", { text: "Ship the beta in October" });

    sync.edit(initial + "typed in the card\n");
    await sync.flush();

    const disk = fs.readFileSync(path.join(VAULT, w.path), "utf8");
    expect(disk).toContain("Ship the beta in October");
    expect(disk).toContain("typed in the card");
    expect(sync.content).toBe(disk);
    sync.close();
  });

  it("a failed save keeps the typing and retries on the next flush", async () => {
    const note = await create("Engineering/Sync Error.md", lines(5));
    const initial = (await call("GET", `/api/vault/note/${note.id}`)) as SyncedNote;
    let fail = true;
    const states: string[] = [];
    const sync = new NoteSync(
      note.rel,
      initial,
      {
        save: async (body) => {
          if (fail) throw new Error("offline");
          const r = await call("PUT", "/api/vault/note", body);
          return { content: r.content, hash: r.hash };
        },
        load: async () => call("GET", `/api/vault/note/${note.id}`),
      },
      { apply: () => {}, status: (s) => states.push(s) },
      60_000,
    );
    const typed = initial.content.replace("line 1\n", "line 1 offline\n");
    sync.edit(typed);
    await sync.flush();
    expect(states.at(-1)).toBe("error");
    expect(sync.content).toBe(typed);
    fail = false;
    await sync.flush();
    expect(states.at(-1)).toBe("saved");
    expect(fs.readFileSync(note.abs, "utf8")).toBe(typed);
    sync.close();
  });
});

describe("PUT /api/vault/note with baseContent", () => {
  // What every editor used to send. Written anyway, it erased the edit made in
  // between; there is no base text to merge against, so it is refused.
  it("refuses a stale hash that comes without its base text, and leaves the file alone", async () => {
    const note = await create("Engineering/Sync Stale.md", lines(5));
    const opened = await call("GET", `/api/vault/note/${note.id}`);
    await call("PUT", "/api/vault/note", { path: note.rel, content: opened.content + "someone else\n" });
    const before = fs.readFileSync(note.abs, "utf8");

    const res = await app.inject({
      method: "PUT",
      url: "/api/vault/note",
      headers: { authorization: `Bearer ${token}` },
      payload: { path: note.rel, content: opened.content.replace("line 1\n", "line 1 stale\n"), baseHash: opened.hash },
    });
    expect(res.statusCode).toBe(409);
    expect(fs.readFileSync(note.abs, "utf8")).toBe(before);
    expect(before).toContain("someone else\n");
  });

  it("rejects a base that does not match its hash", async () => {
    const note = await create("Engineering/Sync Mismatch.md", "a\n");
    const current = await call("GET", `/api/vault/note/${note.id}`);
    const res = await app.inject({
      method: "PUT",
      url: "/api/vault/note",
      headers: { authorization: `Bearer ${token}` },
      payload: { path: note.rel, content: current.content + "b\n", baseHash: current.hash, baseContent: "something else\n" },
    });
    expect(res.statusCode).toBe(400);
    expect(fs.readFileSync(note.abs, "utf8")).toBe(current.content);
  });
});
