/**
 * DNS rebinding (audit SEC-005). A page on evil.example that re-points its own
 * name at 127.0.0.1 is same-origin with this server, so CORS never applies;
 * what it cannot change is the Host its browser sends. So every request,
 * unauthenticated auth routes and the live-sync socket included, must be
 * addressed to loopback or a host named in ORRAMA_PUBLIC_ORIGINS.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

process.env.ORRAMA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "basalt-host-"));
process.env.ORRAMA_VAULT_DIR = path.join(process.env.ORRAMA_DATA_DIR, "vault");
process.env.ORRAMA_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.ORRAMA_SECRET_KEY = "test-secret-key-0123456789abcdef";
process.env.ORRAMA_PUBLIC_ORIGINS = "http://localhost:4623,https://mac.tailnet-name.ts.net";

const { buildServer, allowedHost } = await import("../src/main.js");
const { tables } = await import("../src/db.js");
const b = await buildServer();
afterAll(async () => {
  await b.app.close();
  delete process.env.ORRAMA_PUBLIC_ORIGINS;
  fs.rmSync(process.env.ORRAMA_DATA_DIR!, { recursive: true, force: true });
});

const as = (host: string, method: "GET" | "POST", url: string, payload?: object) =>
  b.app.inject({ method, url, headers: { host }, ...(payload ? { payload } : {}) });
const owner = { email: "o@example.test", username: "owner", displayName: "O", password: "a-real-password" };

describe("Host allowlist", () => {
  it("refuses a foreign Host before any route runs — status, register, unlock", async () => {
    const status = await as("rebind.attacker.example:4623", "GET", "/api/auth/status");
    expect(status.statusCode).toBe(421);
    expect(status.body).not.toContain("needsSetup");
    expect((await as("rebind.attacker.example:4623", "POST", "/api/auth/register", owner)).statusCode).toBe(421);
    expect(b.db.select().from(tables.users).all()).toHaveLength(0); // nobody founded the workspace
    expect((await as("evil.example", "POST", "/api/auth/unlock", { email: owner.email, passcode: "1234" })).statusCode).toBe(421);
    expect((await as("evil.example", "GET", "/")).statusCode).toBe(421);
  });

  it("answers loopback on any port, and the hosts in ORRAMA_PUBLIC_ORIGINS", async () => {
    for (const host of ["localhost", "localhost:4625", "127.0.0.1:4623", "[::1]:4623", "LOCALHOST:4623", "mac.tailnet-name.ts.net", "mac.tailnet-name.ts.net:443"]) {
      expect((await as(host, "GET", "/api/auth/status")).statusCode, host).toBe(200);
    }
    expect((await as("localhost:4623", "POST", "/api/auth/register", owner)).statusCode).toBe(200);
  });

  it("refuses the live-sync socket from a foreign Host", async () => {
    await expect(b.app.injectWS("/api/ws", { headers: { host: "evil.example:4623" } })).rejects.toThrow();
    const ok = await b.app.injectWS("/api/ws", { headers: { host: "localhost:4623" } });
    ok.terminate();
  });

  it("does not let a URL-shaped Host smuggle in an allowed name", () => {
    const origins = ["https://mac.tailnet-name.ts.net"];
    for (const host of ["localhost/evil", "localhost@evil.example", "evil.example#localhost", "localhost:4623 evil", ""]) {
      expect(allowedHost(host, origins), host).toBe(false);
    }
    expect(allowedHost(undefined, origins)).toBe(true); // no browser omits Host; a client that does could write any name
    expect(allowedHost("mac.tailnet-name.ts.net.evil.example", origins)).toBe(false);
    expect(allowedHost("127.0.0.1", [])).toBe(true);
  });
});
