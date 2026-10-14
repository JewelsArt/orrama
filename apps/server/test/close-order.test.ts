/**
 * The database closes last (audit OPS-003). Fastify runs onClose hooks
 * last-registered first, so the hook main.ts registered "last" ran first: the
 * database closed while the vault watcher and its debounced timers were still
 * live. On Windows a watcher timer then fired into the closed database —
 * 26 "The database connection is not open" errors in server.test's run.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, it } from "vitest";

process.env.BASALT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "basalt-close-order-"));
process.env.BASALT_VAULT_DIR = path.join(process.env.BASALT_DATA_DIR, "vault");
process.env.BASALT_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.BASALT_SECRET_KEY = "test-secret-key-0123456789abcdef";
fs.mkdirSync(path.join(process.env.BASALT_VAULT_DIR, "Notes"), { recursive: true });
fs.writeFileSync(path.join(process.env.BASALT_VAULT_DIR, "Notes", "a.md"), "# A\n");

const { buildServer } = await import("../src/main.js");
afterAll(() => fs.rmSync(process.env.BASALT_DATA_DIR!, { recursive: true, force: true }));

it("the vault store stops while the database is still open", async () => {
  const { app, db, store } = await buildServer();
  const client = (db as unknown as { $client: { open: boolean } }).$client;
  let openWhenStoreClosed: boolean | undefined;
  store.events.on("closed", () => (openWhenStoreClosed = client.open));
  await app.close();
  expect(openWhenStoreClosed).toBe(true);
  expect(client.open).toBe(false);
});
