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
import { POSIX_MODES } from "./helpers/platform.js";
import { liveSocket, OWN_ORIGIN, refusedWith, sessionCookieName, sessionOf, signedIn, type LiveSocket } from "./helpers/session.js";

process.env.ORRAMA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-logs-"));
process.env.ORRAMA_VAULT_DIR = path.join(process.env.ORRAMA_DATA_DIR, "vault");
process.env.ORRAMA_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.ORRAMA_SECRET_KEY = "test-secret-key-0123456789abcdef";

const { buildServer } = await import("../src/main.js");
const { privateLogFiles, redactUrl } = await import("../src/logging.js");

let logged = "";
const logStream = new Writable({
  write(chunk, _enc, done) {
    logged += chunk.toString();
    done();
  },
});

let app: Awaited<ReturnType<typeof buildServer>>["app"];
let db: Awaited<ReturnType<typeof buildServer>>["db"];
let token = "";

beforeAll(async () => {
  await import("../src/seed.js");
  ({ app, db } = await buildServer({ logStream }));
  await app.ready();
  const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "jules@orrama.dev", password: "orrama-demo" } });
  token = sessionOf(r);
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
    const auth = signedIn(token);
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

describe("/api/ws signs in on the upgrade, from the session cookie (WEB-013)", () => {
  const waitFor = async (s: LiveSocket, type: string, ms = 2000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (s.got.some((m) => m.type === type)) return true;
      await new Promise((r) => setTimeout(r, 20));
    }
    return false;
  };

  it("the cookie on the handshake gets 'ready' at once, then live events", async () => {
    const s = await liveSocket(app, token);
    expect(await s.ready()).toBe(true);
    await app.inject({
      method: "PUT",
      url: "/api/vault/note",
      headers: signedIn(token),
      payload: { path: "Engineering/Live.md", content: "# live\n" },
    });
    expect(await waitFor(s, "note-changed")).toBe(true);
    s.ws.close();
  });

  it("no cookie, or a bad one: the upgrade is refused, and no socket is made", async () => {
    expect(await refusedWith(liveSocket(app, undefined))).toBe(401);
    expect(await refusedWith(liveSocket(app, "not-a-jwt"))).toBe(401);
  });

  it("a token in the URL no longer authenticates", async () => {
    const open = app.injectWS(`/api/ws?token=${token}`, { headers: { host: "localhost", origin: OWN_ORIGIN } });
    expect(await refusedWith(open)).toBe(401);
  });

  it("a live session of an account that no longer exists is refused", async () => {
    // The row outlived its account (removed while signed in elsewhere).
    const { tables } = await import("../src/db.js");
    db.insert(tables.sessions).values({ id: "s-orphan", userId: "u-deleted-long-ago", label: "Mac", createdAt: Date.now(), lastSeenAt: null, revokedAt: null }).run();
    expect(await refusedWith(liveSocket(app, app.jwt.sign({ sub: "u-deleted-long-ago", sid: "s-orphan" })))).toBe(401);
  });

  it("from another site, or with no Origin, it is refused even with a good cookie (a hijacked socket)", async () => {
    expect(await refusedWith(liveSocket(app, token, { origin: "https://evil.example" }))).toBe(403);
    const bare = app.injectWS("/api/ws", { headers: { host: "localhost", cookie: `${sessionCookieName()}=${token}` } });
    expect(await refusedWith(bare)).toBe(403);
  });

  it("an auth frame from an app open since before the cookie is ignored, and the socket stays", async () => {
    const s = await liveSocket(app, token);
    expect(await s.ready()).toBe(true);
    s.ws.send(JSON.stringify({ type: "auth", token: "not-a-jwt" }));
    s.ws.send("not json");
    await app.inject({ method: "PUT", url: "/api/vault/note", headers: signedIn(token), payload: { path: "Engineering/Still.md", content: "# still\n" } });
    expect(await waitFor(s, "note-changed")).toBe(true);
    s.ws.close();
  });
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
