/**
 * A request Fastify itself rejects — bad JSON, an empty JSON body, a content
 * type nothing parses, a body over the limit — is the client's mistake. It
 * used to fall through the error handler as `500 internal error` and land in
 * the log as a server error.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.ORRAMA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-client-errors-"));
process.env.ORRAMA_VAULT_DIR = path.join(process.env.ORRAMA_DATA_DIR, "vault");
process.env.ORRAMA_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.ORRAMA_SECRET_KEY = "test-secret-key-0123456789abcdef";

const { buildServer } = await import("../src/main.js");
let app: Awaited<ReturnType<typeof buildServer>>["app"];

beforeAll(async () => {
  fs.mkdirSync(process.env.ORRAMA_VAULT_DIR!, { recursive: true });
  await import("../src/seed.js");
  app = (await buildServer()).app;
  // A library error that happens to carry a statusCode, for the last test.
  app.get("/api/__throws", async () => {
    throw Object.assign(new Error("upstream said: secret detail"), { statusCode: 404 });
  });
});

afterAll(async () => {
  await app.close();
  fs.rmSync(process.env.ORRAMA_DATA_DIR!, { recursive: true, force: true });
});

const post = (contentType: string, payload: string) =>
  app.inject({ method: "POST", url: "/api/auth/login", headers: { "content-type": contentType }, payload });

describe("requests Fastify rejects keep their 4xx", () => {
  it("malformed JSON is 400", async () => {
    const res = await post("application/json", "{not json");
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/json/i);
  });

  it("an empty JSON body is 400", async () => {
    const res = await post("application/json", "");
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/empty/i);
  });

  it("an unsupported content type is 415", async () => {
    const res = await post("text/xml", "<x/>");
    expect(res.statusCode).toBe(415);
  });

  it("a body over the limit is 413", async () => {
    const res = await post("application/json", JSON.stringify({ email: "x".repeat(2_000_000), password: "p" }));
    expect(res.statusCode).toBe(413);
  });

  it("a real failure is still a bare 500", async () => {
    const res = await app.inject({ method: "GET", url: "/api/__throws" });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "internal error" });
  });
});
