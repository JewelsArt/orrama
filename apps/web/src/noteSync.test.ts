/**
 * The web app's side of "typing is never lost" (WEB-002): what happens to a note's unsaved text
 * when the note is closed, reopened, or the page goes away while the server is not answering.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RETRY_FIRST_MS } from "@orrama/sync/client";

const server = vi.hoisted(() => ({
  down: false,
  files: new Map<string, string>(),
  puts: [] as { path: string; content: string }[],
}));

vi.mock("./api.js", () => ({
  sessionFetch: (url: string, init: RequestInit) => fetch(url, init),
  api: async (method: string, url: string, body?: { path: string; content: string }) => {
    if (server.down) throw new TypeError("Failed to fetch");
    if (method === "PUT" && body) {
      server.puts.push(body);
      server.files.set(body.path, body.content);
      return { content: body.content, hash: `h:${body.content}`, path: body.path };
    }
    const id = url.split("/").pop()!;
    const path = `${id}.md`;
    const content = server.files.get(path) ?? "";
    return { id, path, content, hash: `h:${content}` };
  },
}));

const mem = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
});

const { openNoteSync, retire, readDraft, restoredText, sendBeforeLeaving, failing, unsavedCount, resetNoteSyncs, installLeaveGuard } = await import("./noteSync.js");

const note = (id: string, content: string) => {
  server.files.set(`${id}.md`, content);
  return { id, path: `${id}.md`, title: id, content, hash: `h:${content}`, tags: [], tasks: [], links: [], backlinks: [], canEdit: true };
};

beforeEach(() => {
  vi.useFakeTimers();
  server.down = false;
  server.files.clear();
  server.puts = [];
  mem.clear();
  resetNoteSyncs();
});
afterEach(() => vi.useRealTimers());

describe("closing a note while its save fails (WEB-002)", () => {
  it("keeps the text, and saves it once the server is back", async () => {
    const sync = openNoteSync(note("a", "one\n"), {}, 600);
    sync.edit("one\ntwo\n");
    server.down = true; // pnpm ship restarts the agent
    retire(sync); // you click another note
    await vi.advanceTimersByTimeAsync(0);
    expect(server.files.get("a.md")).toBe("one\n");
    expect(unsavedCount()).toBe(1);
    server.down = false;
    await vi.advanceTimersByTimeAsync(RETRY_FIRST_MS);
    expect(server.files.get("a.md")).toBe("one\ntwo\n");
    expect(unsavedCount()).toBe(0);
    expect(readDraft("a")).toBeNull();
  });

  it("opening the note again picks up the same unsaved text, not the server's older copy", async () => {
    const first = openNoteSync(note("a", "one\n"), {}, 600);
    first.edit("one\ntwo\n");
    server.down = true;
    retire(first);
    await vi.advanceTimersByTimeAsync(0);
    const again = openNoteSync(note("a", "one\n"), {}, 600);
    expect(again).toBe(first);
    expect(again.content).toBe("one\ntwo\n");
  });

  it("reports a closed note's failure to nobody, not to the note open now", async () => {
    const statusA = vi.fn();
    const statusB = vi.fn();
    const a = openNoteSync(note("a", "one\n"), { status: statusA }, 600);
    a.edit("one\ntwo\n");
    server.down = true;
    statusA.mockClear();
    retire(a);
    openNoteSync(note("b", "bee\n"), { status: statusB }, 600);
    await vi.advanceTimersByTimeAsync(RETRY_FIRST_MS * 3);
    expect(statusB).not.toHaveBeenCalledWith("error", expect.anything());
    expect(statusA).not.toHaveBeenCalled(); // its screen let go of it
  });

  it("keeps a draft in storage while unsaved, and offers it back merged onto the note as it is now", async () => {
    const sync = openNoteSync(note("a", "one\nthree\n"), {}, 600);
    server.down = true;
    sync.edit("one\ntwo\nthree\n");
    await vi.advanceTimersByTimeAsync(600);
    const draft = readDraft("a")!;
    expect(draft).toMatchObject({ content: "one\ntwo\nthree\n", base: "one\nthree\n" });
    // The page died; meanwhile Obsidian added a line at the end.
    expect(restoredText(draft, "one\nthree\nfour\n")).toBe("one\ntwo\nthree\nfour\n");
    // A draft the note already holds (the keepalive save made it) is nothing to offer.
    expect(restoredText(draft, "one\ntwo\nthree\n")).toBeNull();
  });
});

describe("leaving the page (WEB-002)", () => {
  it("sends what is pending inside the debounce, and writes it down too", async () => {
    const sync = openNoteSync(note("a", "one\n"), {}, 600);
    sync.edit("one\ntwo\n"); // ⌘R 100 ms later
    const sent: { path: string; content: string }[] = [];
    sendBeforeLeaving((body) => sent.push(body));
    expect(sent).toEqual([expect.objectContaining({ path: "a.md", content: "one\ntwo\n", baseContent: "one\n" })]);
    expect(readDraft("a")?.content).toBe("one\ntwo\n");
    expect(failing()).toBe(false); // nothing has failed: no need to ask
  });

  it("asks first when a save is already failing", async () => {
    const sync = openNoteSync(note("a", "one\n"), {}, 600);
    server.down = true;
    sync.edit("one\ntwo\n");
    await vi.advanceTimersByTimeAsync(600);
    expect(failing()).toBe(true);
  });

  it("reload, ⌘R and Update ready pass through the leave guard: it sends, and asks only when failing", async () => {
    const win = new EventTarget() as unknown as Window;
    const off = installLeaveGuard(win);
    const fetched: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: { body: string; keepalive: boolean }) => {
      if (init.keepalive) fetched.push(JSON.parse(init.body).content);
      return new Response("{}");
    });
    const sync = openNoteSync(note("a", "one\n"), {}, 600);
    sync.edit("one\ntwo\n");
    const leave = () => {
      const e = new Event("beforeunload", { cancelable: true });
      win.dispatchEvent(e);
      win.dispatchEvent(new Event("pagehide"));
      return e.defaultPrevented;
    };
    expect(leave()).toBe(false); // a plain ⌘R inside the debounce: saved on the way out, no question
    expect(fetched).toEqual(["one\ntwo\n"]); // once, not once per event
    win.dispatchEvent(new Event("pageshow"));
    server.down = true;
    await vi.advanceTimersByTimeAsync(600);
    expect(leave()).toBe(true); // the server is not answering: ask first
    off();
    vi.unstubAllGlobals();
    vi.stubGlobal("localStorage", { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) });
  });
});
