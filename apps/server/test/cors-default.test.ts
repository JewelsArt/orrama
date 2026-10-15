/**
 * CORS is off unless ORRAMA_CORS_ORIGIN names an origin (prior audit B3, REG-015).
 *
 * The default used to be `true`, which tells @fastify/cors to reflect whatever Origin asks, so
 * any web page could read the vault through a signed-in browser. One line holds it in env.ts;
 * this test holds the line. The second case is the control: with an origin configured the
 * header does appear, so the first case is not passing by never looking.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

process.env.ORRAMA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "basalt-cors-"));
process.env.ORRAMA_VAULT_DIR = path.join(process.env.ORRAMA_DATA_DIR, "vault");
process.env.ORRAMA_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.ORRAMA_SECRET_KEY = "test-secret-key-0123456789abcdef";
delete process.env.ORRAMA_CORS_ORIGIN;

// The instance itself: awaited, the app Fastify returns unwraps to this type anyway.
type App = FastifyInstance;
const apps: App[] = [];
const boot = async (corsOrigin?: string): Promise<App> => {
  vi.resetModules();
  if (corsOrigin) process.env.ORRAMA_CORS_ORIGIN = corsOrigin;
  else delete process.env.ORRAMA_CORS_ORIGIN;
  const { buildServer } = await import("../src/main.js");
  const app = (await buildServer()).app;
  apps.push(app);
  return app;
};
const preflight = (app: App, origin: string) =>
  app.inject({
    method: "OPTIONS",
    url: "/api/vault/tree",
    headers: { origin, "access-control-request-method": "GET", "access-control-request-headers": "authorization" },
  });

beforeAll(async () => {
  fs.mkdirSync(process.env.ORRAMA_VAULT_DIR!, { recursive: true });
  await import("../src/seed.js");
});
afterAll(async () => {
  for (const app of apps) await app.close();
  delete process.env.ORRAMA_CORS_ORIGIN;
  fs.rmSync(process.env.ORRAMA_DATA_DIR!, { recursive: true, force: true });
});

describe("CORS", () => {
  it("by default answers no other origin, preflight or plain request", async () => {
    const app = await boot();
    const pre = await preflight(app, "https://evil.example");
    expect(pre.headers["access-control-allow-origin"]).toBeUndefined();
    const get = await app.inject({ method: "GET", url: "/api/health", headers: { origin: "https://evil.example" } });
    expect(get.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("answers exactly the origin ORRAMA_CORS_ORIGIN names, when it names one", async () => {
    const app = await boot("https://app.example");
    const pre = await preflight(app, "https://app.example");
    expect(pre.headers["access-control-allow-origin"]).toBe("https://app.example");
  });
});
