/**
 * Settings → You changes the password (1A): the current one and the new one, through the same
 * Argon2 path as sign-up. A wrong current password changes nothing and is counted like a
 * sign-in (five, then a wait). A change keeps this device signed in and ends every other way
 * in, as the terminal's `account` command does (SEC-007): the other sessions, API tokens and
 * Touch ID devices, the passcode and the planning feed link. Only a session may do it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessionOf, signedIn } from "./helpers/session.js";

process.env.ORRAMA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-password-"));
process.env.ORRAMA_VAULT_DIR = path.join(process.env.ORRAMA_DATA_DIR, "vault");
process.env.ORRAMA_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.ORRAMA_SECRET_KEY = "test-secret-key-0123456789abcdef";

const { buildServer } = await import("../src/main.js");
const { tables } = await import("../src/db.js");
type Built = Awaited<ReturnType<typeof buildServer>>;
let b: Built;
const EMAIL = "alex@example.test";
const OLD = "correct horse battery";
const NEW = "a new and longer phrase";

const login = (password: string) => b.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: EMAIL, password } });
const change = (session: string, payload: unknown) => b.app.inject({ method: "POST", url: "/api/auth/password", headers: signedIn(session), payload: payload as object });
const me = (cred: string) => b.app.inject({ method: "GET", url: "/api/me", headers: signedIn(cred) });

let here = "";
let there = "";
let token = "";

beforeAll(async () => {
  b = await buildServer();
  here = sessionOf(await b.app.inject({ method: "POST", url: "/api/auth/register", payload: { email: EMAIL, username: "alex", displayName: "Alex", password: OLD } }));
  there = sessionOf(await login(OLD));
  token = (await b.app.inject({ method: "POST", url: "/api/tokens", headers: signedIn(here), payload: { label: "script" } })).json().token;
  expect((await b.app.inject({ method: "POST", url: "/api/auth/passcode", headers: signedIn(here), payload: { passcode: "1234" } })).statusCode).toBe(200);
});
afterAll(async () => {
  await b.app.close();
  fs.rmSync(process.env.ORRAMA_DATA_DIR!, { recursive: true, force: true });
});

describe("changing the password from Settings", () => {
  it("refuses a wrong current password and changes nothing", async () => {
    const r = await change(here, { current: "not it at all", next: NEW });
    expect(r.statusCode).toBe(403);
    expect((await login(OLD)).statusCode).toBe(200);
    expect((await me(there)).statusCode).toBe(200);
  });

  it("refuses a new password under eight characters", async () => {
    expect((await change(here, { current: OLD, next: "short" })).statusCode).toBe(400);
  });

  it("is a session's, never an API token's", async () => {
    expect((await change(token, { current: OLD, next: NEW })).statusCode).toBe(403);
    expect((await login(OLD)).statusCode).toBe(200);
  });

  it("changes it: this device stays in, every other way in ends", async () => {
    const r = await change(here, { current: OLD, next: NEW });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ tokens: 1 });
    expect(r.json().sessions).toBeGreaterThanOrEqual(1);
    expect((await me(here)).statusCode).toBe(200);
    expect((await me(there)).statusCode).toBe(401);
    expect((await me(token)).statusCode).toBe(401);
    const user = b.db.select().from(tables.users).all()[0]!;
    expect(user.passcodeHash).toBeNull();
    expect((await login(OLD)).statusCode).toBe(401);
    expect((await login(NEW)).statusCode).toBe(200);
  });

  it("counts wrong current passwords like sign-ins: five, then a wait", async () => {
    const fresh = sessionOf(await login(NEW));
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await change(fresh, { current: `wrong ${i}`, next: "whatever long" })).statusCode);
    expect(codes).toEqual([403, 403, 403, 403, 403, 429]);
  });
});
