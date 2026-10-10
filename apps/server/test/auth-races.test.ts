/**
 * The attempt counters hold under concurrency (audit SEC-001, SEC-003, SEC-011).
 *
 * Each of these used to read a count, await Argon2, then write the count back,
 * so a burst of requests sent at once all saw the same stale value: 300
 * passcode guesses were all checked and the counter ended at 0, forty wrong
 * passwords were all verified and none got a 429, and a sign-up without an
 * invite paid for a full hash before being refused. Argon2 is wrapped in a
 * counter here, so "no hash ran" is measured rather than inferred from timing.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const argon = vi.hoisted(() => ({ hash: 0, verify: 0 }));
vi.mock("@node-rs/argon2", async (importOriginal) => {
  const real = await importOriginal<typeof import("@node-rs/argon2")>();
  return {
    ...real,
    hash: (...a: Parameters<typeof real.hash>) => (argon.hash++, real.hash(...a)),
    verify: (...a: Parameters<typeof real.verify>) => (argon.verify++, real.verify(...a)),
  };
});

process.env.BASALT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "basalt-races-"));
process.env.BASALT_VAULT_DIR = path.join(process.env.BASALT_DATA_DIR, "vault");
process.env.BASALT_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.BASALT_SECRET_KEY = "test-secret-key-0123456789abcdef";

const { buildServer } = await import("../src/main.js");
const { tables } = await import("../src/db.js");
const { MAX_FAILS } = await import("../src/loginLimit.js");
const { eq } = await import("drizzle-orm");
const b = await buildServer();
afterAll(async () => {
  await b.app.close();
  fs.rmSync(process.env.BASALT_DATA_DIR!, { recursive: true, force: true });
});

const EMAIL = "owner@example.test";
const PASSWORD = "a-real-password";
const PASSCODE = "7391";
const post = (url: string, payload: object, remoteAddress = "127.0.0.1", token?: string) =>
  b.app.inject({ method: "POST", url, payload, remoteAddress, headers: token ? { authorization: `Bearer ${token}` } : {} });
const statuses = (rs: { statusCode: number }[]) =>
  rs.reduce<Record<number, number>>((acc, r) => ((acc[r.statusCode] = (acc[r.statusCode] ?? 0) + 1), acc), {});
const owner = () => b.db.select().from(tables.users).where(eq(tables.users.email, EMAIL)).get()!;

const reg = await post("/api/auth/register", { email: EMAIL, username: "owner", displayName: "Owner", password: PASSWORD });
const session = reg.json().token as string;
expect((await post("/api/auth/passcode", { passcode: PASSCODE }, "127.0.0.1", session)).statusCode).toBe(200);

beforeEach(() => {
  argon.hash = 0;
  argon.verify = 0;
});

describe("quick unlock under a concurrent burst", () => {
  const wrong = (n: number) => Array.from({ length: n }, (_, i) => String(1000 + i));
  const burst = (codes: string[]) => Promise.all(codes.map((passcode) => post("/api/auth/unlock", { email: EMAIL, passcode }, "10.1.0.1")));

  it("checks five guesses, then the cooldown; ten in all, then only the password", async () => {
    const first = await burst(wrong(50));
    expect(statuses(first)).toEqual({ 401: 5, 429: 45 });
    expect(argon.verify).toBe(5); // one verify per counted attempt, none for the refused
    expect(owner().passcodeFails).toBe(5);

    // The cooldown runs out (not waited for: a minute is a long test).
    b.db.update(tables.users).set({ passcodeLockedUntil: Date.now() - 1 }).where(eq(tables.users.email, EMAIL)).run();
    const second = await burst([...wrong(49), PASSCODE]);
    expect(statuses(second)[401]).toBe(5);
    expect(second.every((r) => r.statusCode !== 200)).toBe(true);
    expect(argon.verify).toBe(10);
    expect(owner().passcodeFails).toBe(10); // equals the verifies actually performed

    // Ten spent: the right code is refused until a password sign-in.
    b.db.update(tables.users).set({ passcodeLockedUntil: null }).where(eq(tables.users.email, EMAIL)).run();
    const right = await post("/api/auth/unlock", { email: EMAIL, passcode: PASSCODE }, "10.1.0.1");
    expect(right.statusCode).toBe(403);
    expect(argon.verify).toBe(10);
    expect((await post("/api/auth/login", { email: EMAIL, password: PASSWORD }, "10.1.0.2")).statusCode).toBe(200);
    expect((await post("/api/auth/unlock", { email: EMAIL, passcode: PASSCODE }, "10.1.0.1")).statusCode).toBe(200);
    expect(owner().passcodeFails).toBe(0);
  });
});

describe("password sign-in under a concurrent burst", () => {
  it("verifies at most MAX_FAILS passwords from one address and refuses the rest before hashing", async () => {
    const rs = await Promise.all(Array.from({ length: 20 }, () => post("/api/auth/login", { email: EMAIL, password: "wrong-password" }, "10.2.0.1")));
    expect(statuses(rs)).toEqual({ 401: MAX_FAILS, 429: 20 - MAX_FAILS });
    expect(argon.verify).toBe(MAX_FAILS);
    // Locked: even the right password is refused, still without a hash.
    expect((await post("/api/auth/login", { email: EMAIL, password: PASSWORD }, "10.2.0.1")).statusCode).toBe(429);
    expect(argon.verify).toBe(MAX_FAILS);
  });
});

describe("sign-up on an established install", () => {
  const signUp = (n: number, inviteToken: string | undefined, remoteAddress: string) =>
    post("/api/auth/register", { email: `u${n}@example.test`, username: `user${n}`, displayName: `U ${n}`, password: "correct horse battery", ...(inviteToken ? { inviteToken } : {}) }, remoteAddress);

  it("refuses a missing or bad invite without hashing the password", async () => {
    expect((await signUp(1, undefined, "10.3.0.1")).statusCode).toBe(403);
    expect((await signUp(2, "no-such-invite", "10.3.0.2")).statusCode).toBe(403);
    b.db.insert(tables.invites).values({ token: "inv-old", teamIds: "[]", createdBy: "x", expiresAt: Date.now() - 1 }).run();
    expect((await signUp(3, "inv-old", "10.3.0.3")).statusCode).toBe(403);
    expect(argon.hash).toBe(0);
    // A good invite still works, and that one is hashed.
    b.db.insert(tables.invites).values({ token: "inv-good", teamIds: "[]", createdBy: "x", expiresAt: Date.now() + 60_000 }).run();
    expect((await signUp(4, "inv-good", "10.3.0.4")).statusCode).toBe(200);
    expect(argon.hash).toBe(1);
  });

  it("is rate-limited per address", async () => {
    const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => signUp(10 + i, "nope", "10.3.1.1")));
    expect(statuses(rs)).toEqual({ 403: MAX_FAILS, 429: 12 - MAX_FAILS });
    expect((await signUp(30, "nope", "10.3.1.2")).statusCode).toBe(403); // another address is not
  });
});
