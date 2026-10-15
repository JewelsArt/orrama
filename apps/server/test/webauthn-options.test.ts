/**
 * The unauthenticated sign-in helpers say nothing about who has an account
 * (audit SEC-008), and cannot be used to grow the database (SEC-009).
 *
 * Touch ID login/options used to 404 an address with no passkey and list the
 * stored credential ids of one with a passkey; the password login answered an
 * unknown address without running Argon2, so its speed told the same story;
 * and every options call left a challenge row nothing ever deleted.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const argon = vi.hoisted(() => ({ verify: 0 }));
vi.mock("@node-rs/argon2", async (importOriginal) => {
  const real = await importOriginal<typeof import("@node-rs/argon2")>();
  return { ...real, verify: (...a: Parameters<typeof real.verify>) => (argon.verify++, real.verify(...a)) };
});

process.env.ORRAMA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "basalt-webauthn-options-"));
process.env.ORRAMA_VAULT_DIR = path.join(process.env.ORRAMA_DATA_DIR, "vault");
process.env.ORRAMA_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.ORRAMA_SECRET_KEY = "test-secret-key-0123456789abcdef";

const { buildServer } = await import("../src/main.js");
const { tables } = await import("../src/db.js");
const { MAX_LIVE_CHALLENGES } = await import("../src/routes/auth.js");
const b = await buildServer();
afterAll(async () => {
  await b.app.close();
  fs.rmSync(process.env.ORRAMA_DATA_DIR!, { recursive: true, force: true });
});

const post = (url: string, payload: object, remoteAddress = "127.0.0.1") =>
  b.app.inject({ method: "POST", url, payload, remoteAddress, headers: { origin: "http://localhost:4623", host: "localhost:4623" } });

const WITH_PASSKEY = "owner@example.test";
const NO_PASSKEY = "second@example.test";
const reg = await post("/api/auth/register", { email: WITH_PASSKEY, username: "owner", displayName: "O", password: "a-real-password" });
const ownerId = reg.json().user.id as string;
b.db.insert(tables.webauthnCredentials).values({ id: "wa-1", userId: ownerId, credentialId: "cred-AAAA-stored-id", publicKey: "x", counter: 0, transports: '["internal"]', label: "Mac", createdAt: Date.now() }).run();
b.db.insert(tables.invites).values({ token: "inv", teamIds: "[]", createdBy: ownerId, expiresAt: Date.now() + 60_000 }).run();
await post("/api/auth/register", { email: NO_PASSKEY, username: "second", displayName: "S", password: "a-real-password", inviteToken: "inv" });

const challenges = () => b.db.select().from(tables.webauthnChallenges).all();

describe("Touch ID login options", () => {
  it("answers a passkey account, a passkey-less account and a stranger alike, with no stored ids", async () => {
    const shape = (r: Awaited<ReturnType<typeof post>>) => {
      const j = r.json();
      return { status: r.statusCode, keys: Object.keys(j).sort(), optionKeys: Object.keys(j.options).sort(), allow: j.options.allowCredentials ?? [] };
    };
    const answers = await Promise.all([WITH_PASSKEY, NO_PASSKEY, "nobody@example.test"].map((email) => post("/api/auth/webauthn/login/options", { email })));
    const [a, ...rest] = answers.map(shape);
    expect(a!.status).toBe(200);
    expect(a!.allow).toEqual([]);
    for (const other of rest) expect(other).toEqual(a);
    for (const r of answers) expect(r.body).not.toContain("cred-AAAA");
  });

  it("still lets only the account's own device spend a challenge", async () => {
    const stranger = (await post("/api/auth/webauthn/login/options", { email: "nobody@example.test" })).json();
    expect((await post("/api/auth/webauthn/login/verify", { challengeId: stranger.challengeId, response: { id: "cred-AAAA-stored-id" } })).statusCode).toBe(401);
  });
});

describe("challenge rows", () => {
  it("are purged once expired", async () => {
    b.db.insert(tables.webauthnChallenges).values({ id: "wc-old", userId: null, challenge: "c", expiresAt: Date.now() - 1 }).run();
    await post("/api/auth/webauthn/login/options", { email: "nobody@example.test" });
    expect(challenges().find((c) => c.id === "wc-old")).toBeUndefined();
  });

  it("stay bounded however many unauthenticated calls arrive", async () => {
    for (let i = 0; i < MAX_LIVE_CHALLENGES + 150; i++) await post("/api/auth/webauthn/login/options", { email: `x${i}@example.test` });
    expect(challenges().length).toBeLessThanOrEqual(MAX_LIVE_CHALLENGES);
    // The oldest go, not the newest: a real sign-in started now survives the
    // flood's next call.
    const fresh = (await post("/api/auth/webauthn/login/options", { email: WITH_PASSKEY })).json();
    await post("/api/auth/webauthn/login/options", { email: "x-next@example.test" });
    expect(challenges().length).toBeLessThanOrEqual(MAX_LIVE_CHALLENGES);
    expect(challenges().some((c) => c.id === fresh.challengeId)).toBe(true);
  });
});

describe("password sign-in", () => {
  beforeEach(() => (argon.verify = 0));

  it("runs Argon2 for an address with no account, as for a wrong password", async () => {
    expect((await post("/api/auth/login", { email: "nobody@example.test", password: "guess-guess" }, "10.9.0.1")).statusCode).toBe(401);
    expect(argon.verify).toBe(1);
    expect((await post("/api/auth/login", { email: WITH_PASSKEY, password: "guess-guess" }, "10.9.0.2")).statusCode).toBe(401);
    expect(argon.verify).toBe(2);
  });
});
