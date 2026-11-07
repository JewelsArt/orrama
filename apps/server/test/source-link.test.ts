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
const root = path.resolve(import.meta.dirname, "../../..");
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

  // The public repository (2G, D1): the one the updater's feed and the friends' downloads live
  // on (tauri.conf.json's endpoint), never the private Basalt-backup a stranger can't open.
  it("defaults to the public GitHub repository, the one the updater reads", () => {
    expect(DEFAULT_SOURCE_URL).toBe("https://github.com/JewelsArt/orrama");
    const conf = JSON.parse(fs.readFileSync(path.join(root, "apps/desktop/src-tauri/tauri.conf.json"), "utf8"));
    expect(conf.plugins.updater.endpoints[0].startsWith(`${DEFAULT_SOURCE_URL}/releases/`)).toBe(true);
  });
});
