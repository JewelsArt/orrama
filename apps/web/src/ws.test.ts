/**
 * The live-sync socket's lifecycle (WEB-015, and REG-015's reconnect loop): backoff, a resync
 * after a reconnect, no retry for an ended session, and no reconnect from a socket that was
 * already replaced. It signs in with the session cookie on the handshake (WEB-013).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

class FakeSocket {
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
  /** The server says the session is good. */
  ready() {
    this.readyState = 1;
    this.onopen?.();
    this.onmessage?.({ data: JSON.stringify({ type: "ready" }) });
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

const win = new EventTarget();
vi.stubGlobal("window", win);
vi.stubGlobal("location", { protocol: "http:", host: "localhost:4623" });
vi.stubGlobal("WebSocket", FakeSocket);
/** What GET /api/me answers when a refused socket asks whether the session is still good. */
let me: () => Promise<Response> = async () => Response.json({ id: "u-1" });
const asked: string[] = [];
vi.stubGlobal("fetch", async (url: string) => {
  asked.push(url);
  return me();
});

let ws: typeof import("./ws.js");
let api: typeof import("./api.js");
let SESSION_ENDED: string;
beforeAll(async () => {
  ws = await import("./ws.js");
  api = await import("./api.js");
  SESSION_ENDED = api.SESSION_ENDED;
  api.sessionStarted();
});
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(1); // the top of each backoff window
  FakeSocket.all = [];
  asked.length = 0;
  me = async () => Response.json({ id: "u-1" });
});
afterEach(() => {
  ws.disconnectWs();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const last = () => FakeSocket.all[FakeSocket.all.length - 1]!;

describe("reconnectDelay", () => {
  it("doubles from 2 s to a 30 s ceiling, jittered within the upper half", () => {
    const top = () => 1;
    expect([0, 1, 2, 3, 4, 5, 9].map((n) => ws.reconnectDelay(n, top))).toEqual([2000, 4000, 8000, 16000, 30000, 30000, 30000]);
    expect(ws.reconnectDelay(0, () => 0)).toBe(1000);
  });
});

describe("connectWs", () => {
  it("sends nothing to sign in: the session cookie goes with the handshake", () => {
    ws.connectWs();
    last().ready();
    expect(last().url).toBe("ws://localhost:4623/api/ws");
    expect(last().sent).toEqual([]);
  });

  it("refused before it opens, it asks whether the session is still good, and a 401 signs the app out", async () => {
    let ended = 0;
    const on = () => ended++;
    win.addEventListener(SESSION_ENDED, on);
    me = async () => Response.json({ error: "this session has ended — sign in again" }, { status: 401 });
    ws.connectWs();
    last().drop(); // the handshake was refused: a browser sees only 1006
    await vi.advanceTimersByTimeAsync(0);
    expect(asked).toEqual(["/api/me"]);
    expect(ended).toBe(1);
    win.removeEventListener(SESSION_ENDED, on);
    api.sessionStarted();
  });

  it("refused while the server is away, it only tries again", async () => {
    let ended = 0;
    const on = () => ended++;
    win.addEventListener(SESSION_ENDED, on);
    me = async () => {
      throw new TypeError("Failed to fetch");
    };
    ws.connectWs();
    last().drop();
    await vi.advanceTimersByTimeAsync(2000);
    expect(ended).toBe(0);
    expect(FakeSocket.all).toHaveLength(2);
    win.removeEventListener(SESSION_ENDED, on);
  });

  it("a socket that was open and dropped does not ask: the server went away, not the session", async () => {
    ws.connectWs();
    last().ready();
    last().drop();
    await vi.advanceTimersByTimeAsync(0);
    expect(asked).toEqual([]);
  });

  it("backs off between failed attempts and starts over after a good connection", () => {
    ws.connectWs();
    last().drop();
    vi.advanceTimersByTime(1999);
    expect(FakeSocket.all).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.all).toHaveLength(2);
    last().drop();
    vi.advanceTimersByTime(3999);
    expect(FakeSocket.all).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.all).toHaveLength(3);
    last().ready(); // back: the next failure waits the shortest time again
    last().drop();
    vi.advanceTimersByTime(2000);
    expect(FakeSocket.all).toHaveLength(4);
  });

  it("after a reconnect, tells the views once that they may have missed changes", () => {
    const got: unknown[] = [];
    const off = ws.onWs((m) => got.push(m));
    ws.connectWs();
    last().ready();
    expect(got).toEqual([]); // the first connection is not a reconnect
    last().drop();
    vi.advanceTimersByTime(2000);
    last().ready();
    expect(got).toEqual([{ type: "note-changed", noteId: "", path: "", authorId: null, resync: true }]);
    off();
  });

  it("a session the server ended goes back to sign-in instead of retrying", () => {
    let ended = 0;
    const on = () => ended++;
    win.addEventListener(SESSION_ENDED, on);
    ws.connectWs();
    last().drop(4001);
    vi.advanceTimersByTime(60_000);
    expect(ended).toBe(1);
    expect(FakeSocket.all).toHaveLength(1);
    win.removeEventListener(SESSION_ENDED, on);
  });

  it("a replaced socket's late close schedules nothing (REG-015)", () => {
    ws.connectWs();
    const first = last();
    first.ready();
    ws.connectWs(); // e.g. a new sign-in on this tab
    expect(first.closed).toBe(true);
    first.drop(); // its close event arrives after the replacement exists
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.all).toHaveLength(2);
  });

  it("signing out forgets the old session: the next first connection is not a reconnect", () => {
    const got: unknown[] = [];
    const off = ws.onWs((m) => got.push(m));
    ws.connectWs();
    last().ready();
    ws.disconnectWs();
    ws.connectWs();
    last().ready();
    expect(got).toEqual([]);
    off();
  });
});
