/**
 * The login throttle and the security headers.
 *
 * The throttle counts failed sign-ins per client address; the headers put a
 * Content-Security-Policy on everything that is not the JSON API, so a
 * revalidated (304) shell carries it too.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.ORRAMA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-hardening-"));
process.env.ORRAMA_VAULT_DIR = path.join(process.env.ORRAMA_DATA_DIR, "vault");
process.env.ORRAMA_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.ORRAMA_SECRET_KEY = "test-secret-key-0123456789abcdef";

const { LoginLimiter, MAX_FAILS, WINDOW_MS } = await import("../src/loginLimit.js");
const { buildServer } = await import("../src/main.js");
let app: Awaited<ReturnType<typeof buildServer>>["app"];

const login = (password: string, remoteAddress = "10.0.0.1") =>
  app.inject({ method: "POST", url: "/api/auth/login", remoteAddress, payload: { email: "erin@orrama.dev", password } });

beforeAll(async () => {
  fs.mkdirSync(process.env.ORRAMA_VAULT_DIR!, { recursive: true });
  await import("../src/seed.js");
  app = (await buildServer()).app;
});

afterAll(async () => {
  await app.close();
  fs.rmSync(process.env.ORRAMA_DATA_DIR!, { recursive: true, force: true });
});

describe("LoginLimiter", () => {
  it("locks after MAX_FAILS inside the window, until the oldest ages out", () => {
    let now = 1_000_000;
    const l = new LoginLimiter(() => now);
    for (let i = 0; i < MAX_FAILS - 1; i++) l.fail("a");
    expect(l.retryAfter("a")).toBe(0);
    now += 60_000;
    l.fail("a");
    expect(l.retryAfter("a")).toBe(WINDOW_MS - 60_000); // the first failure is a minute old
    expect(l.retryAfter("b")).toBe(0); // another address is untouched
    now += WINDOW_MS - 60_000 + 1;
    expect(l.retryAfter("a")).toBe(0);
  });

  it("forgets an address on a successful sign-in", () => {
    const l = new LoginLimiter(() => 0);
    for (let i = 0; i < MAX_FAILS - 1; i++) l.fail("a");
    l.succeed("a");
    l.fail("a");
    expect(l.retryAfter("a")).toBe(0);
  });
});

describe("POST /api/auth/login", () => {
  it("answers 429 after five wrong passwords — even to the right one", async () => {
    for (let i = 0; i < MAX_FAILS; i++) expect((await login("wrong")).statusCode).toBe(401);
    const locked = await login("orrama-demo");
    expect(locked.statusCode).toBe(429);
    expect(Number(locked.headers["retry-after"])).toBeGreaterThan(0);
    // Another address is not locked out by this one.
    expect((await login("orrama-demo", "10.0.0.2")).statusCode).toBe(200);
  });

  it("does not count failures a successful sign-in came after", async () => {
    for (let i = 0; i < MAX_FAILS - 1; i++) await login("wrong", "10.0.0.3");
    expect((await login("orrama-demo", "10.0.0.3")).statusCode).toBe(200);
    for (let i = 0; i < MAX_FAILS - 1; i++) await login("wrong", "10.0.0.3");
    expect((await login("orrama-demo", "10.0.0.3")).statusCode).toBe(200);
  });
});

describe("security headers", () => {
  it("puts the CSP on every non-API response, whatever its type", async () => {
    // Not HTML, and not an API route: a 304 of the shell is just as bare.
    const res = await app.inject({ method: "GET", url: "/ics/nope.ics" });
    const csp = String(res.headers["content-security-policy"] ?? "");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe/);
    // Not 'none': the document reader shows PDFs as blob: frames, which INHERIT
    // this policy, and with 'none' WebKit refused to let Orrama frame its own
    // PDFs — every PDF and payslip in the desktop app went blank (25-28 Sep).
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).toContain("frame-src 'self' blob:");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("leaves the JSON API without one, but still nosniff", async () => {
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.headers["content-security-policy"]).toBeUndefined();
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });
});
