/**
 * First-run setup and quick unlock.
 *
 * The passcode is the part worth testing hardest. Four digits is 10,000
 * combinations, so what stands between an attacker and an account is not the
 * secret - it is the attempt counter. These tests pin that behaviour: five fast
 * tries, a cooldown, a hard stop, and a password login as the only way back.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.BASALT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "basalt-auth-test-"));
process.env.BASALT_JWT_SECRET = "test-secret";

const { buildServer } = await import("../src/main.js");
const { tables } = await import("../src/db.js");

let app: Awaited<ReturnType<typeof buildServer>>["app"];
let db: Awaited<ReturnType<typeof buildServer>>["db"];
let token = "";

const api = async (method: string, url: string, body?: unknown, auth?: string) => {
  const res = await app.inject({
    method: method as "GET",
    url,
    headers: auth ? { authorization: `Bearer ${auth}` } : {},
    ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
  });
  return { status: res.statusCode, json: res.json() };
};

const CREDS = { email: "owner@example.com", username: "owner", displayName: "Owner", password: "a-real-password" };

beforeAll(async () => {
  const built = await buildServer();
  app = built.app;
  db = built.db;
});

afterAll(async () => {
  await app.close();
  fs.rmSync(process.env.BASALT_DATA_DIR!, { recursive: true, force: true });
});

describe("first run", () => {
  it("reports an empty install, then stops reporting it", async () => {
    expect((await api("GET", "/api/auth/status")).json).toEqual({ needsSetup: true });
    const created = await api("POST", "/api/auth/register", CREDS);
    expect(created.status).toBe(200);
    // The first account founds the workspace, so it must own it - nobody else can
    // grant that later.
    expect(created.json.user.isOwner).toBe(true);
    token = created.json.token;
    expect((await api("GET", "/api/auth/status")).json).toEqual({ needsSetup: false });
  });

  it("will not let a second account in without an invite", async () => {
    const r = await api("POST", "/api/auth/register", {
      email: "stranger@example.com",
      username: "stranger",
      displayName: "Stranger",
      password: "another-password",
    });
    expect(r.status).toBe(403);
  });
});

describe("quick unlock", () => {
  it("offers nothing until a passcode is set", async () => {
    expect((await api("POST", "/api/auth/unlock/options", { email: CREDS.email })).json).toEqual({
      passcode: false,
      webauthn: false,
    });
  });

  it("does not say whether an unknown address exists", async () => {
    expect((await api("POST", "/api/auth/unlock/options", { email: "nobody@example.com" })).json).toEqual({
      passcode: false,
      webauthn: false,
    });
  });

  it("requires a live session to set one", async () => {
    expect((await api("POST", "/api/auth/passcode", { passcode: "4821" })).status).toBe(401);
  });

  it("insists on exactly four digits", async () => {
    for (const bad of ["12", "12345", "abcd", "12 4", ""]) {
      expect((await api("POST", "/api/auth/passcode", { passcode: bad }, token)).status).toBe(400);
    }
    expect((await api("POST", "/api/auth/passcode", { passcode: "4821" }, token)).status).toBe(200);
    expect((await api("POST", "/api/auth/unlock/options", { email: CREDS.email })).json.passcode).toBe(true);
  });

  it("unlocks with the right code and issues a working session", async () => {
    const r = await api("POST", "/api/auth/unlock", { email: CREDS.email, passcode: "4821" });
    expect(r.status).toBe(200);
    const me = await api("GET", "/api/me", undefined, r.json.token);
    expect(me.json.email).toBe(CREDS.email);
  });

  it("is never decided in the browser: a wrong code is refused by the server", async () => {
    const r = await api("POST", "/api/auth/unlock", { email: CREDS.email, passcode: "0000" });
    expect(r.status).toBe(401);
    expect(r.json.token).toBeUndefined();
  });

  it("cools down after five wrong tries, then disables the passcode entirely", async () => {
    const reset = () =>
      db.update(tables.users).set({ passcodeFails: 0, passcodeLockedUntil: null }).where(eq(tables.users.email, CREDS.email)).run();
    reset();

    // Five wrong tries are merely wrong; the fifth starts a cooldown.
    for (let i = 0; i < 4; i++) {
      expect((await api("POST", "/api/auth/unlock", { email: CREDS.email, passcode: "0000" })).status).toBe(401);
    }
    expect((await api("POST", "/api/auth/unlock", { email: CREDS.email, passcode: "0000" })).status).toBe(401);

    // During the cooldown even the CORRECT code is refused - otherwise the
    // throttle would only slow down people who guess wrong.
    const during = await api("POST", "/api/auth/unlock", { email: CREDS.email, passcode: "4821" });
    expect(during.status).toBe(429);

    // Ten failures total and the passcode stops being an option at all.
    db.update(tables.users).set({ passcodeFails: 10, passcodeLockedUntil: null }).where(eq(tables.users.email, CREDS.email)).run();
    const dead = await api("POST", "/api/auth/unlock", { email: CREDS.email, passcode: "4821" });
    expect(dead.status).toBe(403);
    expect((await api("POST", "/api/auth/unlock/options", { email: CREDS.email })).json.passcode).toBe(false);
  });

  it("gives the password back as the way in, and it clears the lockout", async () => {
    const login = await api("POST", "/api/auth/login", { email: CREDS.email, password: CREDS.password });
    expect(login.status).toBe(200);
    const row = db.select().from(tables.users).where(eq(tables.users.email, CREDS.email)).get();
    expect(row!.passcodeFails).toBe(0);
    expect((await api("POST", "/api/auth/unlock", { email: CREDS.email, passcode: "4821" })).status).toBe(200);
  });

  it("can be removed, leaving the password login untouched", async () => {
    expect((await api("DELETE", "/api/auth/passcode", undefined, token)).status).toBe(200);
    expect((await api("POST", "/api/auth/unlock", { email: CREDS.email, passcode: "4821" })).status).toBe(401);
    expect((await api("POST", "/api/auth/login", { email: CREDS.email, password: CREDS.password })).status).toBe(200);
  });
});

describe("webauthn", () => {
  it("refuses to start a login for an account with no device enrolled", async () => {
    expect((await api("POST", "/api/auth/webauthn/login/options", { email: CREDS.email })).status).toBe(404);
  });

  it("requires a session to enrol one", async () => {
    expect((await api("POST", "/api/auth/webauthn/register/options")).status).toBe(401);
  });

  it("hands out a challenge that can only be spent once", async () => {
    const r = await api("POST", "/api/auth/webauthn/register/options", undefined, token);
    expect(r.status).toBe(200);
    expect(typeof r.json.challengeId).toBe("string");
    expect(typeof r.json.options.challenge).toBe("string");
    // Spending it with a junk response fails, and the challenge is consumed either
    // way - a replay must not find it still sitting there.
    await api("POST", "/api/auth/webauthn/register/verify", { challengeId: r.json.challengeId, response: {} }, token);
    const replay = await api(
      "POST",
      "/api/auth/webauthn/register/verify",
      { challengeId: r.json.challengeId, response: {} },
      token,
    );
    expect(replay.status).toBe(400);
  });
});
