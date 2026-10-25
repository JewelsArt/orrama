/**
 * A key is checked before it is saved (2C: first run's Use a key, Settings → Orr & AI): one
 * read of the model at the provider, the key in a header, the answer in words. Against a fake
 * Anthropic and a fake Google on this machine.
 */
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessionOf, signedIn } from "./helpers/session.js";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-key-check-"));
process.env.ORRAMA_DATA_DIR = dataDir;
process.env.ORRAMA_VAULT_DIR = path.join(dataDir, "vault");
process.env.ORRAMA_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.ORRAMA_SECRET_KEY = "test-secret-key-0123456789abcdef";

const { buildServer } = await import("../src/main.js");
const { setKeyCheckHostsForTests } = await import("../src/aiKeyCheck.js");
const { tables } = await import("../src/db.js");

const GOOD = "sk-good-0123456789";
const seen: { url: string; headers: http.IncomingHttpHeaders }[] = [];
const fake = http.createServer((req, res) => {
  seen.push({ url: req.url ?? "", headers: req.headers });
  const key = req.headers["x-api-key"] ?? req.headers["x-goog-api-key"];
  const google = req.url!.startsWith("/v1beta/");
  if (key === "sk-busy-0123456789") return res.writeHead(429).end();
  if (key !== GOOD) {
    // Anthropic says 401; Google says 400 with API_KEY_INVALID.
    if (google) return res.writeHead(400, { "content-type": "application/json" }).end('{"error":{"status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID"}]}}');
    return res.writeHead(401).end();
  }
  const known = ["/v1/models/claude-test-5", "/v1beta/models/gemini-test-flash"];
  if (!known.includes(req.url!)) return res.writeHead(404).end();
  res.writeHead(200, { "content-type": "application/json" }).end("{}");
});

type Built = Awaited<ReturnType<typeof buildServer>>;
let b: Built;
let session = "";
const check = (payload: object) => b.app.inject({ method: "POST", url: "/api/admin/ai/check", headers: signedIn(session), payload });

beforeAll(async () => {
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  const at = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  setKeyCheckHostsForTests({ anthropic: at, google: at });
  b = await buildServer();
  session = sessionOf(await b.app.inject({ method: "POST", url: "/api/auth/register", payload: { email: "sam@example.test", username: "sam", displayName: "Sam", password: "correct horse battery" } }));
});
afterAll(async () => {
  setKeyCheckHostsForTests(null);
  await b.app.close();
  await new Promise((r) => fake.close(r));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("checking a key before it is saved", () => {
  it("a good key and model: ok, the key sent as a header and never in the address", async () => {
    seen.length = 0;
    const r = await check({ provider: "anthropic", model: "claude-test-5", apiKey: GOOD });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });
    expect(seen[0]).toMatchObject({ url: "/v1/models/claude-test-5", headers: { "x-api-key": GOOD, "anthropic-version": "2023-06-01" } });
    expect((await check({ provider: "google", model: "models/gemini-test-flash", apiKey: GOOD })).statusCode).toBe(200);
    expect(seen.every((s) => !s.url.includes(GOOD))).toBe(true);
  });

  it("says what is wrong, in words", async () => {
    const said = async (payload: object) => {
      const r = await check(payload);
      expect(r.statusCode).toBe(400);
      return r.json().error as string;
    };
    expect(await said({ provider: "anthropic", model: "claude-test-5", apiKey: "sk-wrong-0123456789" })).toBe("Anthropic didn't accept that key. Check that you copied all of it.");
    expect(await said({ provider: "google", model: "gemini-test-flash", apiKey: "g-wrong-0123456789" })).toBe("Google didn't accept that key. Check that you copied all of it.");
    expect(await said({ provider: "anthropic", model: "claude-nope", apiKey: GOOD })).toBe("Anthropic has no model called claude-nope for this key. Check the model's name.");
    expect(await said({ provider: "anthropic", model: "claude-test-5", apiKey: "sk-busy-0123456789" })).toBe("Anthropic is turning requests away for now. Try again in a minute.");
  });

  it("an unreachable provider is said as that, not as a bad key", async () => {
    setKeyCheckHostsForTests({ anthropic: "http://127.0.0.1:9" });
    try {
      const r = await check({ provider: "anthropic", model: "claude-test-5", apiKey: GOOD });
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toBe("Orrama couldn't reach Anthropic to check the key. Check the connection and try again.");
    } finally {
      const at = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
      setKeyCheckHostsForTests({ anthropic: at, google: at });
    }
  });

  it("stores nothing", async () => {
    await check({ provider: "anthropic", model: "claude-test-5", apiKey: GOOD });
    expect(b.db.select().from(tables.workspace).all()[0]).toMatchObject({ aiProvider: null, aiKeyEncrypted: null });
  });
});
