/**
 * An API token is the weaker credential, and stays that way (audit SEC-013,
 * SEC-004, SEC-014). It may read and write the vault and stage mail — what the
 * MCP server does — but it may never create, change or reveal a credential,
 * or decide where one is sent. The refusal is one rule in `authenticate`
 * (main.ts) that a route opts into with `sessionOnly(reason)`; this file pins
 * the whole set, so a route that drops it shows up here.
 */
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

process.env.BASALT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "basalt-token-gate-"));
process.env.BASALT_VAULT_DIR = path.join(process.env.BASALT_DATA_DIR, "vault");
process.env.BASALT_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.BASALT_SECRET_KEY = "test-secret-key-0123456789abcdef";
delete process.env.BASALT_FETCH_ALLOW;

const { buildServer } = await import("../src/main.js");
const { tables } = await import("../src/db.js");
const { aiConfig, completeText } = await import("../src/aiProvider.js");
const b = await buildServer();
afterAll(async () => {
  await b.app.close();
  fs.rmSync(process.env.BASALT_DATA_DIR!, { recursive: true, force: true });
});

type Method = "GET" | "POST" | "DELETE";
const call = async (method: Method, url: string, auth: string, payload?: object) => {
  const r = await b.app.inject({ method, url, headers: { authorization: `Bearer ${auth}` }, ...(payload ? { payload } : {}) });
  return { status: r.statusCode, body: r.body, json: () => r.json() };
};

const EMAIL = "owner@example.test";
const reg = await b.app.inject({ method: "POST", url: "/api/auth/register", payload: { email: EMAIL, username: "owner", displayName: "Owner", password: "a-real-password" } });
const session = reg.json().token as string;
const token = (await call("POST", "/api/tokens", session, { label: "mcp" })).json().token as string;
expect(token).toMatch(/^bslt_/);

/** Everything that creates, changes or reveals a credential, or aims one. */
const SESSION_ONLY: [Method, string, object?][] = [
  ["POST", "/api/auth/passcode", { passcode: "1234" }],
  ["DELETE", "/api/auth/passcode"],
  ["POST", "/api/auth/webauthn/register/options"],
  ["POST", "/api/auth/webauthn/register/verify", { challengeId: "x", response: {} }],
  ["GET", "/api/auth/webauthn/credentials"],
  ["DELETE", "/api/auth/webauthn/credentials/wa-x"],
  ["POST", "/api/auth/logout"],
  ["GET", "/api/auth/sessions"],
  ["DELETE", "/api/auth/sessions/s-x"],
  ["GET", "/api/tokens"],
  ["POST", "/api/tokens", { label: "sibling" }],
  ["DELETE", "/api/tokens/tok-x"],
  ["GET", "/api/webhooks"],
  ["POST", "/api/webhooks", { url: "https://example.com/h", events: ["note.changed"] }],
  ["DELETE", "/api/webhooks/wh-x"],
  ["POST", "/api/webhooks/wh-x/test"],
  ["POST", "/api/mail/send", { to: "x@example.com", subject: "s", body: "b" }],
  ["POST", "/api/mail/account", { email: "me@example.com", appPassword: "abcdabcdabcdabcd" }],
  ["DELETE", "/api/mail/account"],
  ["GET", "/api/me/ics-token"],
  ["POST", "/api/me/ics-token"],
  ["DELETE", "/api/me/ics-token"],
  ["GET", "/api/admin/overview"],
  ["GET", "/api/admin/ai"],
  ["POST", "/api/admin/ai", { provider: "openai-compatible", model: "m", apiKey: "", baseUrl: "https://attacker.example/v1" }],
  ["POST", "/api/admin/ai/instructions", { instructions: "x" }],
  ["POST", "/api/admin/ai/chatgpt/start"],
  ["GET", "/api/admin/ai/chatgpt/models"],
  ["POST", "/api/admin/ai/chatgpt/disconnect"],
  ["POST", "/api/admin/invites", { teamIds: [], expiresInHours: 1 }],
  ["POST", "/api/admin/teams", { slug: "t", name: "T", color: "#000000" }],
  ["POST", "/api/admin/teams/t-x/members", { userId: "u-x" }],
  ["GET", "/api/admin/grants"],
  ["POST", "/api/admin/grants", { teamId: "t-x", folder: "", role: "edit" }],
  ["DELETE", "/api/admin/grants/g-x"],
  ["POST", "/api/admin/projects", { kind: "tag", key: "project/x", name: "X" }],
  ["DELETE", "/api/admin/projects/p-x"],
];

describe("the session-only set", () => {
  it.each(SESSION_ONLY)("%s %s refuses an API token, and does nothing", async (method, url, payload) => {
    const before = { users: b.db.select().from(tables.users).all(), tokens: b.db.select().from(tables.apiTokens).all().length, ws: b.db.select().from(tables.workspace).all() };
    const r = await call(method, url, token, payload);
    expect(r.status).toBe(403);
    expect(r.json().error).toMatch(/signed-in session|cannot send mail directly/);
    expect(b.db.select().from(tables.users).all()).toEqual(before.users);
    expect(b.db.select().from(tables.apiTokens).all()).toHaveLength(before.tokens);
    expect(b.db.select().from(tables.workspace).all()).toEqual(before.ws);
  });

  it("still lets a token do what the MCP server does", async () => {
    expect((await call("GET", "/api/me", token)).status).toBe(200);
    expect((await call("GET", "/api/vault/tree", token)).status).toBe(200);
    expect((await call("GET", "/api/projects", token)).status).toBe(200);
    expect((await call("GET", "/api/mail/drafts", token)).status).toBe(200);
  });
});

describe("a token cannot become a session (SEC-013)", () => {
  it("cannot set a passcode, so cannot unlock with one", async () => {
    expect((await call("POST", "/api/auth/passcode", token, { passcode: "4321" })).status).toBe(403);
    const unlock = await b.app.inject({ method: "POST", url: "/api/auth/unlock", payload: { email: EMAIL, passcode: "4321" } });
    expect(unlock.statusCode).toBe(401);
    expect(unlock.body).not.toContain("token");
  });
});

describe("the AI key goes only where it was entered for (SEC-004)", () => {
  /** A server that records the Authorization header of anything sent to it. */
  const capture = async () => {
    const seen: string[] = [];
    const srv = http.createServer((req, res) => {
      seen.push(String(req.headers.authorization ?? ""));
      res.writeHead(500).end();
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    return { seen, url: `http://127.0.0.1:${(srv.address() as net.AddressInfo).port}/v1`, close: () => srv.close() };
  };

  it("refuses a new base URL without the key, and the key never reaches it", async () => {
    const mine = await capture();
    const attacker = await capture();
    try {
      const KEY = "sk-test-0123456789-secret";
      expect((await call("POST", "/api/admin/ai", session, { provider: "openai-compatible", model: "m", apiKey: KEY, baseUrl: mine.url })).status).toBe(200);
      // Through a session, with the key left blank: refused, nothing changed.
      const moved = await call("POST", "/api/admin/ai", session, { provider: "openai-compatible", model: "m", apiKey: "", baseUrl: attacker.url });
      expect(moved.status).toBe(400);
      expect(b.db.select().from(tables.workspace).all()[0]!.aiBaseUrl).toBe(mine.url);
      // Same address, blank key: kept (changing only the model must not need the key).
      expect((await call("POST", "/api/admin/ai", session, { provider: "openai-compatible", model: "m2", apiKey: "", baseUrl: mine.url })).status).toBe(200);
      // Through a token: refused before the route runs.
      expect((await call("POST", "/api/admin/ai", token, { provider: "openai-compatible", model: "m", apiKey: "", baseUrl: attacker.url })).status).toBe(403);

      await completeText(aiConfig(b.db)!, { prompt: "hi", maxRetries: 0 }).catch(() => {});
      expect(mine.seen).toEqual([`Bearer ${KEY}`]);
      expect(attacker.seen).toEqual([]);

      // A new address WITH the key typed again is the legitimate move.
      expect((await call("POST", "/api/admin/ai", session, { provider: "openai-compatible", model: "m", apiKey: KEY, baseUrl: attacker.url })).status).toBe(200);
    } finally {
      mine.close();
      attacker.close();
    }
  });

  it("still keeps the key when switching between providers with fixed hosts", async () => {
    expect((await call("POST", "/api/admin/ai", session, { provider: "google", model: "gemini-x", apiKey: "" })).status).toBe(200);
    expect((await call("POST", "/api/admin/ai", session, { provider: "anthropic", model: "claude-x", apiKey: "" })).status).toBe(200);
  });
});

describe("the mail account (SEC-014)", () => {
  /** A TCP server that counts connections and hangs up on each. */
  const listener = async () => {
    let connections = 0;
    const srv = net.createServer((s) => (connections++, s.destroy()));
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    return { port: (srv.address() as net.AddressInfo).port, count: () => connections, close: () => srv.close() };
  };
  const connect = (auth: string, port: number) =>
    call("POST", "/api/mail/account", auth, { email: "me@example.com", appPassword: "abcd efgh ijkl mnop", imapHost: "127.0.0.1", imapPort: port, smtpHost: "127.0.0.1", smtpPort: port });

  it("refuses a private mail server unless it is allow-listed, without connecting", async () => {
    const l = await listener();
    try {
      const r = await connect(session, l.port);
      expect(r.status).toBe(400);
      expect(r.json().error).toMatch(/BASALT_FETCH_ALLOW/);
      expect(l.count()).toBe(0);
    } finally {
      l.close();
    }
  });

  it("says only that sign-in failed, never what the far end said", async () => {
    const l = await listener();
    process.env.BASALT_FETCH_ALLOW = "127.0.0.1";
    try {
      const r = await connect(session, l.port);
      expect(r.status).toBe(400);
      expect(l.count()).toBeGreaterThan(0); // it did try, this time
      expect(r.json().error).toBe("could not sign in to the mail server — check the address, the app password, and that IMAP is on");
      const closed = await connect(session, 1); // nothing listens on port 1
      expect(closed.json().error).toBe(r.json().error);
      expect(closed.body).not.toMatch(/ECONN|127\.0\.0\.1|:1\b/);
    } finally {
      delete process.env.BASALT_FETCH_ALLOW;
      l.close();
    }
  });
});
