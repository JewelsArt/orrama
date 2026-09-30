/**
 * An account that no longer exists must not break note saves. Webhook and
 * live-sync listeners run INSIDE store.write (EventEmitter rethrows into the
 * emitter), and both called aclUser, which throws for an unknown user: a
 * hook left by a removed account, or a socket still open when its account was
 * deleted, turned every save into a 500 after the file was written.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { WebSocket } from "ws";
import { afterAll, describe, expect, it } from "vitest";

process.env.BASALT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "basalt-gone-"));
process.env.BASALT_VAULT_DIR = path.join(process.env.BASALT_DATA_DIR, "vault");
process.env.BASALT_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.BASALT_SECRET_KEY = "test-secret-key-0123456789abcdef";

await import("../src/seed.js");
const { buildServer } = await import("../src/main.js");
const { tables } = await import("../src/db.js");
const { app, db } = await buildServer();
afterAll(async () => {
  await app.close();
  fs.rmSync(process.env.BASALT_DATA_DIR!, { recursive: true, force: true });
});

const login = async (who: string) => (await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: `${who}@basalt.dev`, password: "basalt-demo" } })).json().token as string;
const save = async (token: string, n: number) =>
  (await app.inject({ method: "PUT", url: "/api/vault/note", headers: { authorization: `Bearer ${token}` }, payload: { path: `Shared/Gone ${n}.md`, content: `# ${n}\n` } })).statusCode;

describe("a deleted account", () => {
  it("with a webhook left behind, does not break saves", async () => {
    const jules = await login("jules");
    db.insert(tables.webhooks).values({ id: "wh-orphan", ownerId: "u-deleted", url: "https://example.invalid/hook", secret: "whsec_x", events: JSON.stringify(["note.changed"]), active: true, createdAt: Date.now() }).run();
    expect(await save(jules, 1)).toBe(200);
  });

  it("with a socket still open, does not break saves — the socket is closed instead", async () => {
    const jules = await login("jules");
    const erin = await login("erin");
    const ws: WebSocket = await app.injectWS("/api/ws");
    const closed = new Promise<number>((r) => ws.on("close", (code: number) => r(code)));
    const ready = new Promise<void>((r) => ws.on("message", (d: Buffer) => JSON.parse(d.toString()).type === "ready" && r()));
    ws.send(JSON.stringify({ type: "auth", token: erin }));
    await ready;
    db.delete(tables.users).where(eq(tables.users.username, "erin")).run();
    expect(await save(jules, 2)).toBe(200);
    expect(await Promise.race([closed, new Promise((r) => setTimeout(() => r("still open"), 2000))])).toBe(4001);
  });
});
