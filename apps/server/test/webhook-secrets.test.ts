/**
 * Webhook signing secrets are encrypted at rest, like every other stored
 * credential (audit SEC-015). They were the one written in the clear, so a
 * copy of basalt.db could forge signed deliveries to every receiver.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const OLD = "test-secret-key-0123456789abcdef";
const NEW = "new-secret-key-0123456789abcdef!!";
process.env.BASALT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "basalt-webhook-secrets-"));
process.env.BASALT_VAULT_DIR = path.join(process.env.BASALT_DATA_DIR, "vault");
process.env.BASALT_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.BASALT_SECRET_KEY = OLD;
process.env.BASALT_FETCH_ALLOW = "127.0.0.1"; // the local receiver below

const { createDb, tables } = await import("../src/db.js");
const { env } = await import("../src/env.js");
const { decryptSecret } = await import("../src/secrets.js");
const { sealPlainWebhookSecrets } = await import("../src/webhooks.js");
const { rotateSecrets } = await import("../src/rotate-secret-key.js");
const { eq } = await import("drizzle-orm");

// A row an older build wrote, in the clear, before this one first boots.
const LEGACY = "whsec_legacy0123456789";
{
  const pre = createDb();
  pre.insert(tables.webhooks).values({ id: "wh-legacy", ownerId: "u-x", url: "https://example.com/h", secret: LEGACY, events: '["note.changed"]', active: true, createdAt: 1 }).run();
  (pre as unknown as { $client: { close(): void } }).$client.close();
}

const { buildServer } = await import("../src/main.js");
const b = await buildServer();
const raw = (b.db as unknown as { $client: import("better-sqlite3").Database }).$client;

const received: { signature: string; body: string }[] = [];
const receiver = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    received.push({ signature: String(req.headers["x-basalt-signature"]), body });
    res.writeHead(200).end();
  });
});
await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", r));
afterAll(async () => {
  receiver.close();
  await b.app.close();
  delete process.env.BASALT_FETCH_ALLOW;
  fs.rmSync(process.env.BASALT_DATA_DIR!, { recursive: true, force: true });
});

const reg = await b.app.inject({ method: "POST", url: "/api/auth/register", payload: { email: "o@example.test", username: "owner", displayName: "O", password: "a-real-password" } });
const session = reg.json().token as string;
const call = (method: "POST" | "GET", url: string, payload?: object) =>
  b.app.inject({ method, url, headers: { authorization: `Bearer ${session}` }, ...(payload ? { payload } : {}) });
const stored = (id: string) => b.db.select().from(tables.webhooks).where(eq(tables.webhooks.id, id)).get()!.secret;
const signs = (secret: string, body: string) => `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;

describe("webhook signing secrets", () => {
  it("are stored encrypted, and shown in the clear only once", async () => {
    const r = (await call("POST", "/api/webhooks", { url: `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/h`, events: ["note.changed"] })).json();
    expect(r.secret).toMatch(/^whsec_/);
    const all = raw.prepare("select secret from webhooks").all() as { secret: string }[];
    expect(all.every((row) => !row.secret.startsWith("whsec_"))).toBe(true);
    expect(decryptSecret(stored(r.id))).toBe(r.secret);
    expect((await call("GET", "/api/webhooks")).body).not.toContain(r.secret);
  });

  it("written in the clear by an older build are sealed at boot, once", () => {
    expect(stored("wh-legacy")).not.toBe(LEGACY);
    expect(decryptSecret(stored("wh-legacy"))).toBe(LEGACY);
    expect(sealPlainWebhookSecrets(b.db)).toBe(0); // nothing left to do
  });

  it("still sign verifiably after a key rotation", async () => {
    const hook = (await call("POST", "/api/webhooks", { url: `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/h`, events: ["note.changed"] })).json();
    // A row still in the clear is skipped by the rotation, not a reason to refuse it.
    b.db.insert(tables.webhooks).values({ id: "wh-plain", ownerId: "u-x", url: "https://example.com/h", secret: "whsec_plain", events: "[]", active: true, createdAt: 1 }).run();
    expect(rotateSecrets(raw, OLD, NEW, true)).toContain(`webhooks.secret  (${hook.id})`);
    expect(stored("wh-plain")).toBe("whsec_plain");
    env.secretKey = NEW;
    try {
      received.length = 0;
      expect((await call("POST", `/api/webhooks/${hook.id}/test`)).json().status).toBe(200);
      expect(received).toHaveLength(1);
      expect(received[0]!.signature).toBe(signs(hook.secret, received[0]!.body));
    } finally {
      env.secretKey = OLD;
    }
  });
});
