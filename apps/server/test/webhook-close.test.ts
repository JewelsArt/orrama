/**
 * A webhook waiting out its debounce when the app closes must not fire into a
 * closed database. It did: the timer outlived app.close(), the delivery looked
 * up the author in SQLite, and threw "The database connection is not open"
 * from a timer — an uncaught exception during shutdown, and in the test suite
 * an unhandled error that failed an otherwise green run.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, it } from "vitest";
import { sessionOf, signedIn } from "./helpers/session.js";

process.env.ORRAMA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-hook-close-"));
process.env.ORRAMA_VAULT_DIR = path.join(process.env.ORRAMA_DATA_DIR, "vault");
process.env.ORRAMA_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.ORRAMA_SECRET_KEY = "test-secret-key-0123456789abcdef";
process.env.ORRAMA_FETCH_ALLOW = "127.0.0.1";
process.env.ORRAMA_WEBHOOK_DEBOUNCE_MS = "150";

await import("../src/seed.js");
const { buildServer } = await import("../src/main.js");

afterAll(() => fs.rmSync(process.env.ORRAMA_DATA_DIR!, { recursive: true, force: true }));

it("a pending note.changed delivery is dropped when the app closes", async () => {
  const { app } = await buildServer();
  const token = sessionOf(await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "jules@orrama.dev", password: "orrama-demo" } }));
  const auth = signedIn(token);
  const hook = await app.inject({ method: "POST", url: "/api/webhooks", headers: auth, payload: { url: "http://127.0.0.1:9/hook", events: ["note.changed"] } });
  expect(hook.statusCode).toBe(200);
  const saved = await app.inject({ method: "PUT", url: "/api/vault/note", headers: auth, payload: { path: "Engineering/Hooked.md", content: "# hooked\n" } });
  expect(saved.statusCode).toBe(200);

  const thrown: unknown[] = [];
  const onError = (err: unknown) => thrown.push(err);
  process.on("uncaughtException", onError);
  try {
    await app.close(); // inside the 150 ms debounce
    await new Promise((r) => setTimeout(r, 400));
  } finally {
    process.off("uncaughtException", onError);
  }
  expect(thrown.map(String)).toEqual([]);
});
