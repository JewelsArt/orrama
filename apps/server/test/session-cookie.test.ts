/**
 * The session is an HttpOnly cookie (WEB-013). It used to be a 30-day token the
 * page kept in localStorage, where any script on the page could read it and use
 * it from another machine. Here: what the cookie looks like, that a write it
 * carries must come from one of our own pages, that signing out clears it, and
 * the one-time trade of a token a browser still holds from before.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import { eq } from "drizzle-orm";
import { SESSION_COOKIE as HELPER_COOKIE } from "./helpers/session.js";

process.env.ORRAMA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-cookie-"));
process.env.ORRAMA_VAULT_DIR = path.join(process.env.ORRAMA_DATA_DIR, "vault");
process.env.ORRAMA_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.ORRAMA_SECRET_KEY = "test-secret-key-0123456789abcdef";
// The phone reaches the Mac by its tailnet name, over https.
const TAILNET = "https://mac.tail0000.ts.net";
process.env.ORRAMA_PUBLIC_ORIGINS = `http://localhost:4623,${TAILNET}`;

const { buildServer } = await import("../src/main.js");
const { tables } = await import("../src/db.js");
const { SESSION_COOKIE } = await import("../src/routes/auth.js");
const { rekeySession } = await import("../src/sessions.js");

type Built = Awaited<ReturnType<typeof buildServer>>;
let b: Built;
const EMAIL = "owner@example.test";
const PASSWORD = "a-real-password";
/** What light-my-request sends as Host, and so the address a request "was sent to". */
const OWN = "http://localhost";

beforeAll(async () => {
  b = await buildServer();
  const reg = await b.app.inject({ method: "POST", url: "/api/auth/register", payload: { email: EMAIL, username: "owner", displayName: "Owner", password: PASSWORD } });
  expect(reg.statusCode).toBe(200);
});
afterAll(async () => {
  await b.app.close();
  fs.rmSync(process.env.ORRAMA_DATA_DIR!, { recursive: true, force: true });
});

type Res = Awaited<ReturnType<Built["app"]["inject"]>>;
const setCookie = (r: Res): string => {
  const h = r.headers["set-cookie"];
  return (Array.isArray(h) ? h : [h ?? ""]).find((c) => c.startsWith(`${SESSION_COOKIE}=`)) ?? "";
};
const cookieValue = (r: Res) => r.cookies.find((c) => c.name === SESSION_COOKIE)?.value ?? "";
const login = (headers: Record<string, string> = {}) =>
  b.app.inject({ method: "POST", url: "/api/auth/login", headers, payload: { email: EMAIL, password: PASSWORD } });
const withCookie = (session: string, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, headers: Record<string, string> = {}, payload?: object) =>
  b.app.inject({ method, url, headers: { cookie: `${SESSION_COOKIE}=${session}`, ...headers }, ...(payload ? { payload } : {}) });
const bearer = (token: string, method: "GET" | "POST", url: string, payload?: object) =>
  b.app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });
const sessionRow = (id: string) => b.db.select().from(tables.sessions).all().find((s) => s.id === id);
const sidOf = (token: string) => (b.app.jwt.decode(token) as { sid: string }).sid;

describe("signing in sets the session cookie", () => {
  it("is the cookie the test helper sends (test/helpers/session.ts spells the name out)", async () => {
    expect(HELPER_COOKIE).toBe(SESSION_COOKIE);
  });

  it("HttpOnly, SameSite=Strict, the whole site, 30 days; not Secure on http://localhost", async () => {
    const r = await login({ origin: OWN });
    expect(r.statusCode).toBe(200);
    const parts = setCookie(r).split("; ");
    expect(parts).toEqual(expect.arrayContaining(["HttpOnly", "SameSite=Strict", "Path=/", `Max-Age=${30 * 86_400}`]));
    expect(parts).not.toContain("Secure");
    expect(cookieValue(r)).not.toBe("");
  });

  it("Secure when the page came over https (the tailnet name)", async () => {
    const r = await login({ host: "mac.tail0000.ts.net", origin: TAILNET });
    expect(r.statusCode).toBe(200);
    expect(setCookie(r).split("; ")).toContain("Secure");
  });

  it("the cookie is the session: /api/me answers with it alone", async () => {
    const session = cookieValue(await login());
    const r = await withCookie(session, "GET", "/api/me");
    expect(r.statusCode).toBe(200);
    expect(r.json().email).toBe(EMAIL);
  });
});

describe("a write the cookie carries must come from our own page", () => {
  const rename = (session: string, headers: Record<string, string>) => withCookie(session, "PATCH", "/api/me", headers, { displayName: "Owner" });

  it("from another site: refused", async () => {
    const session = cookieValue(await login());
    const r = await rename(session, { origin: "https://evil.example" });
    expect(r.statusCode).toBe(403);
  });

  it("with no Origin at all, or a null one: refused (a browser always sends one)", async () => {
    const session = cookieValue(await login());
    expect((await rename(session, {})).statusCode).toBe(403);
    expect((await rename(session, { origin: "null" })).statusCode).toBe(403);
  });

  it("from the address it was sent to, or a name in ORRAMA_PUBLIC_ORIGINS: allowed", async () => {
    const session = cookieValue(await login());
    expect((await rename(session, { origin: OWN })).statusCode).toBe(200);
    expect((await rename(session, { origin: "http://localhost:4623", host: "127.0.0.1:4623" })).statusCode).toBe(200);
    expect((await rename(session, { origin: TAILNET, host: "mac.tail0000.ts.net" })).statusCode).toBe(200);
  });

  it("a read needs no Origin: SameSite=Strict already keeps other sites' requests from carrying it", async () => {
    const session = cookieValue(await login());
    expect((await withCookie(session, "GET", "/api/me")).statusCode).toBe(200);
  });
});

describe("API tokens are unchanged", () => {
  it("a bslt_ token still works as Bearer, and still can't use a session-only route", async () => {
    const session = cookieValue(await login());
    const made = await withCookie(session, "POST", "/api/tokens", { origin: OWN }, { label: "script" });
    expect(made.statusCode).toBe(200);
    const token = made.json().token as string;
    expect(token.startsWith("bslt_")).toBe(true);
    expect((await bearer(token, "GET", "/api/vault/tree")).statusCode).toBe(200);
    expect((await bearer(token, "GET", "/api/auth/sessions")).statusCode).toBe(403);
  });
});

describe("signing out clears the cookie and ends the row", () => {
  it("sign-out", async () => {
    const session = cookieValue(await login());
    const out = await withCookie(session, "POST", "/api/auth/logout", { origin: OWN });
    expect(out.statusCode).toBe(200);
    expect(setCookie(out).split("; ")).toEqual(expect.arrayContaining([`${SESSION_COOKIE}=`, "Max-Age=0"]));
    expect(sessionRow(sidOf(session))?.revokedAt).not.toBeNull();
    expect((await withCookie(session, "GET", "/api/me")).statusCode).toBe(401); // the same cookie, replayed
  });

  it("sign out everywhere", async () => {
    const session = cookieValue(await login());
    const out = await withCookie(session, "POST", "/api/auth/revoke-all", { origin: OWN });
    expect(out.statusCode).toBe(200);
    expect(setCookie(out)).toContain("Max-Age=0");
    expect((await withCookie(session, "GET", "/api/me")).statusCode).toBe(401);
  });
});

describe("a token kept from before the cookie (this release only)", () => {
  /** A session as the old app held it: the token, named in no cookie. */
  const oldToken = async () => {
    const session = cookieValue(await login());
    // The old app was handed exactly this kind of token: {sub, sid}, signed with the same key.
    return session;
  };

  it("still works as Bearer, so an open window keeps working until it reloads", async () => {
    const token = await oldToken();
    expect((await bearer(token, "GET", "/api/me")).statusCode).toBe(200);
  });

  it("is traded for the cookie once: same session row, a new id, and the old token is dead after", async () => {
    const token = await oldToken();
    // Signed in ten days ago.
    const DAY = 86_400_000;
    b.db.update(tables.sessions).set({ createdAt: Date.now() - 10 * DAY }).where(eq(tables.sessions.id, sidOf(token))).run();
    const before = sessionRow(sidOf(token))!;
    const r = await b.app.inject({ method: "POST", url: "/api/auth/exchange", headers: { authorization: `Bearer ${token}`, origin: OWN } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ user: expect.objectContaining({ email: EMAIL }) });
    expect(JSON.stringify(r.json())).not.toContain(token);
    const session = cookieValue(r);
    expect(setCookie(r).split("; ")).toEqual(expect.arrayContaining(["HttpOnly", "SameSite=Strict", "Path=/"]));

    // The same session (its sign-in time and label), under a new id.
    const after = sessionRow(sidOf(session))!;
    expect(after.id).not.toBe(before.id);
    expect(after.createdAt).toBe(before.createdAt);
    expect(after.label).toBe(before.label);
    expect(sessionRow(before.id)).toBeUndefined();
    // It still ends 30 days after it began, not 30 days after the trade: 20 days left.
    const maxAge = Number(/Max-Age=(\d+)/.exec(setCookie(r))![1]);
    expect(maxAge).toBeLessThanOrEqual(20 * 86_400);
    expect(maxAge).toBeGreaterThan(20 * 86_400 - 60);
    const exp = (b.app.jwt.decode(cookieValue(r)) as { exp: number }).exp * 1000;
    expect(Math.abs(exp - (before.createdAt + 30 * DAY))).toBeLessThan(60_000);

    expect((await withCookie(session, "GET", "/api/me")).statusCode).toBe(200);
    expect((await bearer(token, "GET", "/api/me")).statusCode).toBe(401);
    const again = await b.app.inject({ method: "POST", url: "/api/auth/exchange", headers: { authorization: `Bearer ${token}` } });
    expect(again.statusCode).toBe(401);
    expect(setCookie(again)).toBe("");
  });

  it("only for a live session: a signed-out one, a forged one or an API token gets nothing", async () => {
    const token = await oldToken();
    await bearer(token, "POST", "/api/auth/logout");
    const owner = b.db.select().from(tables.users).all()[0]!;
    for (const t of [token, b.app.jwt.sign({ sub: owner.id, sid: "s-made-up" }), b.app.jwt.sign({ sub: owner.id }), "bslt_nothing", "not-a-token"]) {
      const r = await b.app.inject({ method: "POST", url: "/api/auth/exchange", headers: { authorization: `Bearer ${t}` } });
      expect(r.statusCode).toBe(401);
      expect(setCookie(r)).toBe("");
    }
  });

  it("a session revoked between the check and the trade stays revoked (rekeySession)", async () => {
    const token = await oldToken();
    const sid = sidOf(token);
    const owner = b.db.select().from(tables.users).all()[0]!;
    b.db.update(tables.sessions).set({ revokedAt: Date.now() }).where(eq(tables.sessions.id, sid)).run();
    expect(rekeySession(b.db, owner.id, sid)).toBeNull();
    expect(sessionRow(sid)?.revokedAt).not.toBeNull();
  });

  it("not for a page on another site", async () => {
    const token = await oldToken();
    const r = await b.app.inject({ method: "POST", url: "/api/auth/exchange", headers: { authorization: `Bearer ${token}`, origin: "https://evil.example" } });
    expect(r.statusCode).toBe(403);
    expect(setCookie(r)).toBe("");
    expect((await bearer(token, "GET", "/api/me")).statusCode).toBe(200); // and nothing was spent
  });

  it("an open live-sync socket follows its session to the new id, so revoking it still closes it", async () => {
    const token = await oldToken();
    const ws: WebSocket = await b.app.injectWS("/api/ws");
    const closed = new Promise<number>((resolve) => ws.on("close", (code: number) => resolve(code)));
    const ready = new Promise<void>((resolve) => ws.on("message", (m: Buffer) => JSON.parse(String(m)).type === "ready" && resolve()));
    ws.send(JSON.stringify({ type: "auth", token }));
    await ready;
    const session = cookieValue(await b.app.inject({ method: "POST", url: "/api/auth/exchange", headers: { authorization: `Bearer ${token}` } }));
    await withCookie(session, "POST", "/api/auth/logout", { origin: OWN });
    expect(await closed).toBe(4001);
  });
});
