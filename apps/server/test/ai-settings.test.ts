/**
 * Settings → AI reads the agent's configuration from GET /api/admin/ai. It
 * used to come only from the Admin screen's overview, a page the rail no
 * longer showed, so nothing in the app could change the key, the model or the
 * instructions. The key itself never comes back — only whether one is stored.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.ORRAMA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "basalt-ai-settings-"));
process.env.ORRAMA_VAULT_DIR = path.join(process.env.ORRAMA_DATA_DIR, "vault");
process.env.ORRAMA_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.ORRAMA_SECRET_KEY = "test-secret-key-0123456789abcdef";

await import("../src/seed.js");
const { buildServer } = await import("../src/main.js");

type Built = Awaited<ReturnType<typeof buildServer>>;
let built: Built;
const tokens: Record<string, string> = {};
const call = async (who: string, method: "GET" | "POST", url: string, payload?: object) => {
  const r = await built.app.inject({ method, url, headers: { authorization: `Bearer ${tokens[who]}` }, ...(payload ? { payload } : {}) });
  return { status: r.statusCode, body: r.body, json: (() => { try { return r.json(); } catch { return null; } })() };
};

beforeAll(async () => {
  built = await buildServer();
  for (const who of ["jules", "erin"]) {
    tokens[who] = (await built.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: `${who}@basalt.dev`, password: "basalt-demo" } })).json().token;
  }
});
afterAll(async () => {
  await built.app.close();
  fs.rmSync(process.env.ORRAMA_DATA_DIR!, { recursive: true, force: true });
});

describe("GET /api/admin/ai", () => {
  it("starts unconfigured", async () => {
    const r = await call("jules", "GET", "/api/admin/ai");
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ provider: null, model: null, configured: false, instructions: "", baseUrl: "", chatgpt: { connected: false, email: null, manageUsage: "https://chatgpt.com/#settings" } });
  });

  it("shows what was saved, and never the key", async () => {
    const KEY = "g-secret-key-0123456789";
    expect((await call("jules", "POST", "/api/admin/ai", { provider: "google", model: "gemini-2.5-flash", apiKey: KEY })).status).toBe(200);
    expect((await call("jules", "POST", "/api/admin/ai/instructions", { instructions: "Push me on deadlines." })).status).toBe(200);
    const r = await call("jules", "GET", "/api/admin/ai");
    expect(r.json).toMatchObject({ provider: "google", model: "gemini-2.5-flash", configured: true, instructions: "Push me on deadlines.", baseUrl: "" });
    expect(r.body).not.toContain(KEY);
    // Exactly these fields: no key, encrypted or not.
    expect(Object.keys(r.json).sort()).toEqual(["baseUrl", "chatgpt", "configured", "instructions", "model", "provider"]);
  });

  it("is for the workspace owner only", async () => {
    expect((await call("erin", "GET", "/api/admin/ai")).status).toBe(403);
  });
});
