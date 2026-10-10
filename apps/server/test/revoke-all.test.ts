/**
 * A password change, and "Sign out everywhere", end every way into the
 * account (audit SEC-007). A password change used to leave the old sessions
 * and every API token working, and revoking sessions by hand left the tokens
 * — which could unlock a fresh session through the passcode.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hash as argonHash } from "@node-rs/argon2";
import { afterAll, describe, expect, it } from "vitest";

process.env.BASALT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "basalt-revoke-all-"));
process.env.BASALT_VAULT_DIR = path.join(process.env.BASALT_DATA_DIR, "vault");
process.env.BASALT_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.BASALT_SECRET_KEY = "test-secret-key-0123456789abcdef";

const { buildServer } = await import("../src/main.js");
const { tables } = await import("../src/db.js");
const { applyAccountChange } = await import("../src/account.js");
const { eq } = await import("drizzle-orm");
const b = await buildServer();
afterAll(async () => {
  await b.app.close();
  fs.rmSync(process.env.BASALT_DATA_DIR!, { recursive: true, force: true });
});

const EMAIL = "owner@example.test";
const PASSWORD = "a-real-password";
const req = async (method: "GET" | "POST" | "DELETE", url: string, auth?: string, payload?: object) => {
  const r = await b.app.inject({ method, url, headers: auth ? { authorization: `Bearer ${auth}` } : {}, ...(payload ? { payload } : {}) });
  return { status: r.statusCode, json: () => r.json() };
};
const login = async (password = PASSWORD) => (await req("POST", "/api/auth/login", undefined, { email: EMAIL, password })).json().token as string;
const user = () => b.db.select().from(tables.users).where(eq(tables.users.email, EMAIL)).get()!;

await req("POST", "/api/auth/register", undefined, { email: EMAIL, username: "owner", displayName: "Owner", password: PASSWORD });

/** An account with one of everything: two sessions, a token, a passcode, a device, a feed link. */
const furnish = async () => {
  const mine = await login();
  const theirs = await login(); // the attacker's
  const token = (await req("POST", "/api/tokens", theirs, { label: "attacker" })).json().token as string;
  expect((await req("POST", "/api/auth/passcode", mine, { passcode: "2468" })).status).toBe(200);
  const feed = (await req("POST", "/api/me/ics-token", mine)).json().token as string;
  b.db.insert(tables.webauthnCredentials).values({ id: `wa-${feed.slice(0, 6)}`, userId: user().id, credentialId: `cred-${feed}`, publicKey: "x", counter: 0, transports: "[]", label: "attacker's Mac", createdAt: Date.now() }).run();
  return { mine, theirs, token, feed };
};

/** Nothing issued before still opens the account. */
const allDead = async (c: Awaited<ReturnType<typeof furnish>>) => {
  expect((await req("GET", "/api/me", c.mine)).status).toBe(401);
  expect((await req("GET", "/api/me", c.theirs)).status).toBe(401);
  expect((await req("GET", "/api/me", c.token)).status).toBe(401);
  expect((await req("POST", "/api/auth/unlock", undefined, { email: EMAIL, passcode: "2468" })).status).toBe(401);
  expect((await req("GET", `/ics/${c.feed}.ics`)).status).toBe(404);
  expect(b.db.select().from(tables.webauthnCredentials).where(eq(tables.webauthnCredentials.userId, user().id)).all()).toEqual([]);
};

describe("Sign out everywhere", () => {
  it("ends every session, token, device, the passcode and the feed link", async () => {
    const c = await furnish();
    const r = await req("POST", "/api/auth/revoke-all", c.mine);
    expect(r.status).toBe(200);
    expect(r.json()).toEqual({ sessions: 3, tokens: 1, devices: 1 }); // the registration's own session too
    await allDead(c);
    expect((await req("GET", "/api/me", await login())).status).toBe(200); // the password still works
  });

  it("is not something an API token can do", async () => {
    const s = await login();
    const token = (await req("POST", "/api/tokens", s, { label: "t" })).json().token as string;
    expect((await req("POST", "/api/auth/revoke-all", token)).status).toBe(403);
    expect((await req("GET", "/api/me", s)).status).toBe(200);
  });
});

describe("a password change (account.ts)", () => {
  it("ends everything issued under the old password", async () => {
    const c = await furnish();
    const u = user();
    const revoked = applyAccountChange(b.db, u.id, { email: u.email, username: u.username, displayName: u.displayName, passwordHash: await argonHash("a-new-password") });
    expect(revoked?.tokens).toBeGreaterThanOrEqual(1);
    await allDead(c);
    expect((await req("POST", "/api/auth/login", undefined, { email: EMAIL, password: PASSWORD })).status).toBe(401);
    expect((await req("POST", "/api/auth/login", undefined, { email: EMAIL, password: "a-new-password" })).status).toBe(200);
  });

  it("leaves them alone when only the name changes", async () => {
    const s = (await req("POST", "/api/auth/login", undefined, { email: EMAIL, password: "a-new-password" })).json().token as string;
    const u = user();
    expect(applyAccountChange(b.db, u.id, { email: u.email, username: u.username, displayName: "Renamed", passwordHash: null })).toBeNull();
    expect((await req("GET", "/api/me", s)).json().displayName).toBe("Renamed");
  });
});
