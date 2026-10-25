/**
 * "Forgot your password?" in the desktop app (2C, Jules 25 Oct 2026: "Reset it on this
 * computer"). Only the app's shell holds ORRAMA_SHELL_TOKEN, new each launch and never said
 * back; with it the shell asks for a one-time ticket, and the reset form spends the ticket. A
 * reset keeps the notes and stored credentials and ends every way in that existed before.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sessionOf, signedIn } from "./helpers/session.js";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-reset-"));
const SHELL = crypto.randomBytes(32).toString("hex");
process.env.ORRAMA_DATA_DIR = dataDir;
process.env.ORRAMA_VAULT_DIR = path.join(dataDir, "vault");
process.env.ORRAMA_SHELL_TOKEN = SHELL;
process.env.ORRAMA_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.ORRAMA_SECRET_KEY = "test-secret-key-0123456789abcdef";

const { buildServer } = await import("../src/main.js");
const { env, envProblems } = await import("../src/env.js");

type Built = Awaited<ReturnType<typeof buildServer>>;
let b: Built;
const EMAIL = "sam@example.test";
const OLD = "correct horse battery";
const NEW = "a new long password";

const post = (url: string, payload: object, headers: Record<string, string> = {}) => b.app.inject({ method: "POST", url, payload, headers });
const ticket = async (token: string | null = SHELL) => post("/api/auth/reset/ticket", {}, token === null ? {} : { "x-orrama-shell-token": token });
const me = async (session: string) => (await b.app.inject({ method: "GET", url: "/api/me", headers: signedIn(session) })).statusCode;
const login = async (password: string) => post("/api/auth/login", { email: EMAIL, password });

let first = "";
beforeAll(async () => {
  b = await buildServer();
  first = sessionOf(await post("/api/auth/register", { email: EMAIL, username: "sam", displayName: "Sam", password: OLD }));
});
afterAll(async () => {
  await b.app.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("only the app's shell can start a reset", () => {
  it("never says the token: not in health, not in the status the sign-in reads", async () => {
    const health = await b.app.inject({ method: "GET", url: "/api/health" });
    expect(health.body).not.toContain(SHELL);
    const status = await b.app.inject({ method: "GET", url: "/api/auth/status" });
    expect(status.json()).toEqual({ needsSetup: false, chooseNotes: true, resetHere: true });
    expect(status.body).not.toContain(SHELL);
  });

  it("refuses a ticket without the token, or with another one", async () => {
    expect((await ticket(null)).statusCode).toBe(403);
    expect((await ticket(crypto.randomBytes(32).toString("hex"))).statusCode).toBe(403);
    expect((await ticket("")).statusCode).toBe(403);
  });

  it("refuses a reset with no ticket from the shell", async () => {
    const r = await post("/api/auth/reset", { ticket: "made-up", email: EMAIL, password: NEW });
    expect(r.statusCode).toBe(403);
    expect((await login(OLD)).statusCode).toBe(200);
  });

  it("a server the app didn't start offers no reset at all", async () => {
    env.shellToken = null;
    try {
      expect((await ticket()).statusCode).toBe(404);
      expect((await b.app.inject({ method: "GET", url: "/api/auth/status" })).json()).toMatchObject({ resetHere: false });
    } finally {
      env.shellToken = SHELL;
    }
  });

  it("the shell's token is 64 hex characters, or the server doesn't start", () => {
    expect(envProblems({ ORRAMA_SHELL_TOKEN: "abc" })).toEqual(["ORRAMA_SHELL_TOKEN must be 64 hexadecimal characters"]);
    expect(envProblems({ ORRAMA_SHELL_TOKEN: SHELL })).toEqual([]);
  });
});

describe("a ticket", () => {
  it("is good for 10 minutes only", async () => {
    const t = (await ticket()).json().ticket as string;
    const now = Date.now();
    const later = vi.spyOn(Date, "now").mockReturnValue(now + 10 * 60_000 + 1);
    try {
      expect((await post("/api/auth/reset", { ticket: t, email: EMAIL, password: NEW })).statusCode).toBe(403);
    } finally {
      later.mockRestore();
    }
    expect((await login(OLD)).statusCode).toBe(200);
  });

  it("only the newest one counts", async () => {
    const older = (await ticket()).json().ticket as string;
    await ticket();
    expect((await post("/api/auth/reset", { ticket: older, email: EMAIL, password: NEW })).statusCode).toBe(403);
  });

  it("survives a mistyped email, then resets: signed in here, every other way in ended, used once", async () => {
    const token = (await b.app.inject({ method: "POST", url: "/api/tokens", headers: signedIn(first), payload: { label: "mcp" } })).json().token as string;
    expect((await b.app.inject({ method: "GET", url: "/api/me", headers: signedIn(token) })).statusCode).toBe(200);
    const second = sessionOf(await login(OLD));
    expect(await me(second)).toBe(200);

    const t = (await ticket()).json().ticket as string;
    const typo = await post("/api/auth/reset", { ticket: t, email: "sma@example.test", password: NEW });
    expect(typo.statusCode).toBe(400);
    expect(typo.json().error).toBe("There's no account with that email on this computer.");

    const r = await post("/api/auth/reset", { ticket: t, email: EMAIL.toUpperCase(), password: NEW });
    expect(r.statusCode).toBe(200);
    expect(r.json().user).toMatchObject({ email: EMAIL });
    const here = sessionOf(r);
    expect(await me(here)).toBe(200);
    // Every session from before, and the API token, are gone.
    expect(await me(first)).toBe(401);
    expect(await me(second)).toBe(401);
    expect((await b.app.inject({ method: "GET", url: "/api/me", headers: signedIn(token) })).statusCode).toBe(401);
    // The new password is the one.
    expect((await login(OLD)).statusCode).toBe(401);
    expect((await login(NEW)).statusCode).toBe(200);
    // And the ticket is spent.
    const again = await post("/api/auth/reset", { ticket: t, email: EMAIL, password: "yet another password" });
    expect(again.statusCode).toBe(403);
    expect((await login(NEW)).statusCode).toBe(200);
  });
});
