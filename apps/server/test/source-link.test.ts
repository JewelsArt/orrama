/**
 * AGPL §13: whoever uses Orrama over a network is offered its source. The
 * server says where it is in /api/health (`source`, from ORRAMA_SOURCE_URL, the
 * GitHub repository by default) and Settings links to it, for every account.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.ORRAMA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-source-"));
process.env.ORRAMA_VAULT_DIR = path.join(process.env.ORRAMA_DATA_DIR, "vault");
process.env.ORRAMA_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.ORRAMA_SECRET_KEY = "test-secret-key-0123456789abcdef";
process.env.ORRAMA_SOURCE_URL = "https://git.example.com/a-friend/orrama";

const { buildServer } = await import("../src/main.js");
const { DEFAULT_SOURCE_URL } = await import("../src/env.js");
let app: Awaited<ReturnType<typeof buildServer>>["app"];

beforeAll(async () => {
  fs.mkdirSync(process.env.ORRAMA_VAULT_DIR!, { recursive: true });
  app = (await buildServer()).app;
});

afterAll(async () => {
  await app.close();
  delete process.env.ORRAMA_SOURCE_URL;
  fs.rmSync(process.env.ORRAMA_DATA_DIR!, { recursive: true, force: true });
});

describe("the source link (AGPL §13)", () => {
  it("/api/health says where the source is, without signing in", async () => {
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, source: "https://git.example.com/a-friend/orrama" });
  });

  it("defaults to the GitHub repository", () => {
    expect(DEFAULT_SOURCE_URL).toMatch(/^https:\/\/github\.com\/JewelsArt\/[\w.-]+$/);
  });
});
