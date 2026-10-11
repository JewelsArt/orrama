/**
 * NoteSync on its own, with a transport that fails the way a real one does (WEB-002, WEB-005).
 * The server-driven tests (apps/server/test/editor-sync.test.ts, editor-rename.test.ts) cover
 * the merges; these cover what happens when nothing is typed any more: a failed save must not
 * wait for a keystroke that never comes, and a refusal must not be hammered.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NoteSync, RETRY_FIRST_MS, RETRY_MAX_MS, type SaveBody, type SyncedNote } from "../src/client.js";

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** A server whose availability the test switches, storing what it is sent. */
function fakeServer(initial: string) {
  const s = {
    stored: initial,
    path: "Notes/a.md",
    down: false as false | "network" | number,
    saves: [] as SaveBody[],
    loads: 0,
    note: (): SyncedNote & { path: string } => ({ content: s.stored, hash: `h${s.stored.length}`, path: s.path }),
    transport: {
      save: async (body: SaveBody) => {
        s.saves.push(body);
        if (s.down === "network") throw new TypeError("Failed to fetch");
        if (typeof s.down === "number") throw new HttpError(s.down, s.down === 403 ? "you can't make this note unreadable to yourself" : "server error");
        s.stored = body.content;
        return s.note();
      },
      load: async () => {
        s.loads++;
        if (typeof s.down === "number") throw new HttpError(s.down, "nope");
        if (s.down) throw new TypeError("Failed to fetch");
        return s.note();
      },
    },
  };
  return s;
}

const states: [string, string | undefined][] = [];
const open = (srv: ReturnType<typeof fakeServer>, hooks: Record<string, unknown> = {}) =>
  new NoteSync(srv.path, srv.note(), srv.transport, { status: (st, why) => states.push([st, why]), ...hooks }, 600);

beforeEach(() => {
  vi.useFakeTimers();
  states.length = 0;
});
afterEach(() => vi.useRealTimers());

describe("a failed save (WEB-002)", () => {
  it("is retried on its own once the server is back, with no further edit", async () => {
    const srv = fakeServer("one\n");
    const sync = open(srv);
    srv.down = "network"; // pnpm ship restarts the agent
    sync.edit("one\ntwo\n");
    await vi.advanceTimersByTimeAsync(600);
    expect(states.at(-1)).toEqual(["error", "Failed to fetch"]);
    expect(sync.error).toBe("Failed to fetch");
    srv.down = false; // back up; nobody types
    await vi.advanceTimersByTimeAsync(RETRY_FIRST_MS);
    expect(srv.stored).toBe("one\ntwo\n");
    expect(sync.dirty).toBe(false);
    expect(sync.error).toBeNull();
    expect(states.at(-1)?.[0]).toBe("saved");
  });

  it("waits longer each time, up to a cap, and a server error counts as down", async () => {
    const srv = fakeServer("one\n");
    const sync = open(srv);
    srv.down = 503;
    sync.edit("one\ntwo\n");
    await vi.advanceTimersByTimeAsync(600);
    const tries = () => srv.saves.length;
    expect(tries()).toBe(1);
    await vi.advanceTimersByTimeAsync(RETRY_FIRST_MS);
    expect(tries()).toBe(2);
    await vi.advanceTimersByTimeAsync(RETRY_FIRST_MS * 2 - 1);
    expect(tries()).toBe(2); // the second wait is twice the first
    await vi.advanceTimersByTimeAsync(1);
    expect(tries()).toBe(3);
    await vi.advanceTimersByTimeAsync(RETRY_MAX_MS * 20);
    expect(tries()).toBeLessThanOrEqual(3 + 2 + 20); // capped, never a spin
    srv.down = false;
    await vi.advanceTimersByTimeAsync(RETRY_MAX_MS);
    expect(srv.stored).toBe("one\ntwo\n");
  });

  it("a refusal is said and not retried on its own; the text stays for the next edit", async () => {
    const srv = fakeServer("one\n");
    const sync = open(srv);
    srv.down = 403;
    sync.edit("one\n#only/finance\n");
    await vi.advanceTimersByTimeAsync(600);
    expect(states.at(-1)).toEqual(["error", "you can't make this note unreadable to yourself"]);
    await vi.advanceTimersByTimeAsync(RETRY_MAX_MS * 4);
    expect(srv.saves).toHaveLength(1);
    expect(sync.content).toBe("one\n#only/finance\n");
    expect(sync.pending()).toMatchObject({ content: "one\n#only/finance\n", baseContent: "one\n" });
  });

  it("closed, it stops retrying", async () => {
    const srv = fakeServer("one\n");
    const sync = open(srv);
    srv.down = "network";
    sync.edit("one\ntwo\n");
    await vi.advanceTimersByTimeAsync(600);
    sync.close();
    srv.down = false;
    await vi.advanceTimersByTimeAsync(RETRY_MAX_MS * 2);
    expect(srv.saves).toHaveLength(1);
  });
});

describe("a note renamed or deleted elsewhere (WEB-005)", () => {
  it("a refresh adopts the new path, and the next save goes there", async () => {
    const srv = fakeServer("one\n");
    const moved: string[] = [];
    const sync = open(srv, { moved: (p: string) => moved.push(p) });
    srv.path = "Notes/renamed.md"; // Obsidian renamed it
    await sync.refresh();
    expect(moved).toEqual(["Notes/renamed.md"]);
    expect(sync.where).toBe("Notes/renamed.md");
    sync.edit("one\ntwo\n");
    await sync.flush();
    expect(srv.saves.at(-1)!.path).toBe("Notes/renamed.md");
  });

  it("a save's answer naming another path moves the sync too", async () => {
    const srv = fakeServer("one\n");
    const sync = open(srv);
    sync.edit("one\ntwo\n");
    srv.path = "Notes/Moved.md";
    await sync.flush();
    expect(sync.where).toBe("Notes/Moved.md");
  });

  it("gone: saving stops, so the old path is never recreated, and the typing is kept", async () => {
    const srv = fakeServer("one\n");
    let gone = 0;
    const sync = open(srv, { gone: () => gone++ });
    sync.edit("one\ntwo\n");
    srv.down = 404;
    await sync.refresh();
    expect(gone).toBe(1);
    expect(sync.gone).toBe(true);
    srv.down = false;
    await sync.flush();
    await vi.advanceTimersByTimeAsync(RETRY_MAX_MS * 2);
    expect(srv.saves).toHaveLength(0);
    expect(sync.content).toBe("one\ntwo\n");
    expect(states.at(-1)?.[0]).toBe("error");
  });
});
