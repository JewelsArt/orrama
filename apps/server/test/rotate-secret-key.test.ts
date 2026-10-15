/**
 * rotate-secret-key re-encrypts every stored credential, the ChatGPT sign-in
 * included (audit SEC-006). It was missing from the list: after a rotation the
 * plan connection silently stopped decrypting, and its long-lived refresh
 * token still decrypted under the OLD key — the one a rotation retires.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const OLD = "old-secret-key-0123456789abcdef!!";
const NEW = "new-secret-key-0123456789abcdef!!";
process.env.ORRAMA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-rotate-"));
process.env.ORRAMA_VAULT_DIR = path.join(process.env.ORRAMA_DATA_DIR, "vault");
process.env.ORRAMA_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.ORRAMA_SECRET_KEY = OLD;

const { createDb, tables } = await import("../src/db.js");
const { env } = await import("../src/env.js");
const { encryptSecret, decryptSecret } = await import("../src/secrets.js");
const { chatgptCredentials, hostId } = await import("../src/chatgpt.js");
const { rotateSecrets } = await import("../src/rotate-secret-key.js");
const { eq } = await import("drizzle-orm");
const db = createDb();
const raw = (db as unknown as { $client: import("better-sqlite3").Database }).$client;
afterAll(() => {
  raw.close();
  fs.rmSync(process.env.ORRAMA_DATA_DIR!, { recursive: true, force: true });
});

const creds = { clientId: "c", refreshToken: "rt-LONG-LIVED", accessToken: "at", expiresAt: 1, idToken: "id", email: "me@example.test", sub: "s" };
db.insert(tables.workspace).values({ id: "w-1", name: "W", aiKeyEncrypted: encryptSecret("sk-ai-key") }).run();
db.insert(tables.meta).values({ key: "chatgpt_credentials", value: encryptSecret(JSON.stringify(creds)) }).run();
hostId(db); // a plain meta row beside it, which must be left alone
const meta = (key: string) => db.select().from(tables.meta).where(eq(tables.meta.key, key)).get()!.value;

describe("rotate-secret-key", () => {
  it("lists the ChatGPT credentials in a dry run, and changes nothing", () => {
    const before = meta("chatgpt_credentials");
    expect(rotateSecrets(raw, OLD, NEW, false)).toEqual(["workspace.ai_key_encrypted  (w-1)", "meta.value  (chatgpt_credentials)"]);
    expect(meta("chatgpt_credentials")).toBe(before);
  });

  it("re-encrypts them with the AI key, so they read under the new key and not the old", () => {
    const host = meta("chatgpt_host_id");
    const oldCipher = meta("chatgpt_credentials");
    rotateSecrets(raw, OLD, NEW, true);
    env.secretKey = NEW;
    try {
      expect(chatgptCredentials(db)?.refreshToken).toBe("rt-LONG-LIVED");
      expect(decryptSecret(db.select().from(tables.workspace).all()[0]!.aiKeyEncrypted!)).toBe("sk-ai-key");
      env.secretKey = OLD;
      expect(meta("chatgpt_credentials")).not.toBe(oldCipher);
      expect(() => decryptSecret(meta("chatgpt_credentials"))).toThrow();
      expect(meta("chatgpt_host_id")).toBe(host);
    } finally {
      env.secretKey = OLD;
    }
  });
});
