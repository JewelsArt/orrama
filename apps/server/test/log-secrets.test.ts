/**
 * Secrets stay out of the request log (audit B7).
 *
 * The live-sync socket carried the 30-day session token in `?token=`, the
 * calendar feed's secret is its path, and search terms ride in `?q=` — and
 * Fastify logs every URL to a never-rotated file under launchd. These tests
 * read the REAL app's log output, and drive the live-sync socket through a
 * real WebSocket handshake (injectWS), because a plain GET to a websocket
 * route is refused whatever the token says and so proves nothing about auth.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import { POSIX_MODES } from "./helpers/platform.js";

process.env.ORRAMA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-logs-"));
process.env.ORRAMA_VAULT_DIR = path.join(process.env.ORRAMA_DATA_DIR, "vault");
process.env.ORRAMA_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.ORRAMA_SECRET_KEY = "test-secret-key-0123456789abcdef";

const { buildServer } = await import("../src/main.js");
const { privateLogFiles, redactUrl } = await import("../src/logging.js");
const { AUTH_TIMEOUT_MS } = await import("../src/routes/ws.js");

let logged = "";
const logStream = new Writable({
  write(chunk, _enc, done) {
    logged += chunk.toString();
    done();
  },
});

let app: Awaited<ReturnType<typeof buildServer>>["app"];
let token = "";

beforeAll(async () => {
  await import("../src/seed.js");
  app = (await buildServer({ logStream })).app;
  await app.ready();
  const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "jules@orrama.dev", password: "orrama-demo" } });
  token = r.json().token;
});

afterAll(async () => {
  await app.close();
  fs.rmSync(process.env.ORRAMA_DATA_DIR!, { recursive: true, force: true });
});

describe("redactUrl", () => {
  it("drops query strings and masks the calendar feed token", () => {
    expect(redactUrl("/api/vault/search?q=salary")).toBe("/api/vault/search?[redacted]");
    expect(redactUrl("/api/ws?token=eyJhbGciOi")).toBe("/api/ws?[redacted]");
    expect(redactUrl("/ics/3f9a1c.ics")).toBe("/ics/[redacted]");
    expect(redactUrl("/ics/3f9a1c.ics?x=1")).toBe("/ics/[redacted]?[redacted]");
    expect(redactUrl("/api/vault/tree")).toBe("/api/vault/tree");
  });
});

describe("the real app's request log", () => {
  it("records the requests, and none of the secrets in their URLs", async () => {
    const auth = { authorization: `Bearer ${token}` };
    await app.inject({ method: "GET", url: "/api/vault/search?q=SECRET-SEARCH-TERM", headers: auth });
    await app.inject({ method: "GET", url: "/ics/SECRET-FEED-TOKEN.ics" });
    await app.inject({ method: "GET", url: `/api/ws?token=${token}` });

    // The requests were logged — otherwise "no secret in the log" is vacuous.
    expect(logged).toContain('"url":"/api/vault/search?[redacted]"');
    expect(logged).toContain('"url":"/ics/[redacted]"');
    expect(logged).toContain('"url":"/api/ws?[redacted]"');

    expect(logged).not.toContain("SECRET-SEARCH-TERM");
    expect(logged).not.toContain("SECRET-FEED-TOKEN");
    expect(logged).not.toContain(token);
  });
});

/** Open a live-sync socket and collect what happens to it. */
const openSocket = async (url = "/api/ws") => {
  const ws: WebSocket = await app.injectWS(url);
  const got: { type?: string }[] = [];
  const closed = new Promise<number>((resolve) => ws.on("close", (code: number) => resolve(code)));
  ws.on("message", (data: Buffer) => got.push(JSON.parse(data.toString())));
  const waitFor = async (type: string, ms = 2000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (got.some((m) => m.type === type)) return true;
      await new Promise((r) => setTimeout(r, 20));
    }
    return false;
  };
  return { ws, got, closed, waitFor };
};

describe("/api/ws authenticates with its first frame", () => {
  it("a valid auth frame gets 'ready', then live events", async () => {
    const s = await openSocket();
    s.ws.send(JSON.stringify({ type: "auth", token }));
    expect(await s.waitFor("ready")).toBe(true);
    await app.inject({
      method: "PUT",
      url: "/api/vault/note",
      headers: { authorization: `Bearer ${token}` },
      payload: { path: "Engineering/Live.md", content: "# live\n" },
    });
    expect(await s.waitFor("note-changed")).toBe(true);
    s.ws.close();
  });

  it("a bad token is closed with 4001", async () => {
    const s = await openSocket();
    s.ws.send(JSON.stringify({ type: "auth", token: "not-a-jwt" }));
    expect(await s.closed).toBe(4001);
    expect(s.got.some((m) => m.type === "ready")).toBe(false);
  });

  it("anything but an auth frame first is closed with 4001", async () => {
    const s = await openSocket();
    s.ws.send(JSON.stringify({ type: "editing", noteId: "n-x" }));
    expect(await s.closed).toBe(4001);
  });

  it("a token in the URL no longer authenticates", async () => {
    const s = await openSocket(`/api/ws?token=${token}`);
    await app.inject({
      method: "PUT",
      url: "/api/vault/note",
      headers: { authorization: `Bearer ${token}` },
      payload: { path: "Engineering/Unseen.md", content: "# unseen\n" },
    });
    expect(await s.waitFor("note-changed", 500)).toBe(false);
    s.ws.send(JSON.stringify({ type: "editing", noteId: "n-x" }));
    expect(await s.closed).toBe(4001);
  });

  it("a valid signature for an account that no longer exists is refused", async () => {
    const s = await openSocket();
    s.ws.send(JSON.stringify({ type: "auth", token: app.jwt.sign({ sub: "u-deleted-long-ago" }) }));
    expect(await s.closed).toBe(4001);
  });

  it(`a socket that never authenticates is closed after ${AUTH_TIMEOUT_MS}ms`, async () => {
    const s = await openSocket();
    expect(await s.closed).toBe(4001);
  }, AUTH_TIMEOUT_MS + 3000);
});

describe("privateLogFiles", () => {
  it.skipIf(!POSIX_MODES)("makes a world-readable log file owner-only, and leaves non-files alone (POSIX modes)", () => {
    const file = path.join(process.env.ORRAMA_DATA_DIR!, "server.log");
    fs.writeFileSync(file, "");
    fs.chmodSync(file, 0o644);
    const fd = fs.openSync(file, "a");
    const dirFd = fs.openSync(process.env.ORRAMA_DATA_DIR!, "r");
    try {
      expect(privateLogFiles([fd, dirFd])).toEqual([fd]);
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(privateLogFiles([fd])).toEqual([]); // already private: nothing to do
    } finally {
      fs.closeSync(fd);
      fs.closeSync(dirFd);
    }
  });
});
