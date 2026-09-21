/**
 * In-app mail: the account holds the user's own IMAP/SMTP credentials, so every
 * endpoint is self-scoped — one user can never see or use another's mailbox, and
 * the stored app password is never returned over the wire. (Live IMAP/SMTP round
 * trips need a real Gmail app password, so those paths are exercised manually.)
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.BASALT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "basalt-mail-"));
// Pin the vault INSIDE this test's temp data dir. Without this line vaultDir()
// falls through to BASALT_VAULT_DIR from the surrounding shell - which INSTALL.md
// tells people to export - and the suite writes its demo notes into the real
// Obsidian vault, then id-stamps every note it finds there. Same location the
// default computes; stated explicitly so the environment cannot redirect it.
process.env.BASALT_VAULT_DIR = path.join(process.env.BASALT_DATA_DIR, "vault");
process.env.BASALT_JWT_SECRET = "test-secret";
// The startup guard refuses placeholder secrets everywhere now, not just
// under NODE_ENV=production, so the suite has to carry a real-shaped one too.
process.env.BASALT_SECRET_KEY = "test-secret-key-0123456789abcdef";

const { buildServer } = await import("../src/main.js");
const { tables } = await import("../src/db.js");
const { encryptSecret } = await import("../src/secrets.js");

let app: Awaited<ReturnType<typeof buildServer>>["app"];
let db: Awaited<ReturnType<typeof buildServer>>["db"];
const tokens: Record<string, string> = {};
const ids: Record<string, string> = {};

const api = async (method: string, url: string, auth?: string, body?: unknown) => {
  const res = await app.inject({
    method: method as "GET",
    url,
    headers: auth ? { authorization: `Bearer ${auth}` } : {},
    ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
  });
  return { status: res.statusCode, json: res.json.bind(res), body: res.body };
};

beforeAll(async () => {
  await import("../src/seed.js");
  const built = await buildServer();
  app = built.app;
  db = built.db;
  for (const email of ["jules@basalt.dev", "erin@basalt.dev"]) {
    const r = await api("POST", "/api/auth/login", undefined, { email, password: "basalt-demo" });
    const who = email.split("@")[0]!;
    tokens[who] = r.json().token;
    ids[who] = (await api("GET", "/api/me", tokens[who])).json().id;
  }
});

afterAll(async () => {
  await app.close();
  fs.rmSync(process.env.BASALT_DATA_DIR!, { recursive: true, force: true });
});

describe("mail account", () => {
  it("requires authentication", async () => {
    expect((await api("GET", "/api/mail/account")).status).toBe(401);
    expect((await api("GET", "/api/mail/inbox")).status).toBe(401);
  });

  it("reports no account before one is connected", async () => {
    const r = await api("GET", "/api/mail/account", tokens["jules"]);
    expect(r.status).toBe(200);
    expect(r.json().connected).toBe(false);
    expect(r.json().email).toBe(null);
  });

  it("refuses inbox/send/read without a connected account", async () => {
    expect((await api("GET", "/api/mail/inbox", tokens["jules"])).status).toBe(400);
    expect((await api("GET", "/api/mail/message/1", tokens["jules"])).status).toBe(400);
    expect((await api("POST", "/api/mail/send", tokens["jules"], { to: "x@y.com", subject: "hi", body: "yo" })).status).toBe(400);
  });

  it("keeps the account self-scoped and never leaks the password", async () => {
    // Simulate a connected account for jules (bypasses the live IMAP check).
    db.insert(tables.mailAccounts)
      .values({
        id: `mail-${crypto.randomUUID().slice(0, 8)}`,
        userId: ids["jules"]!,
        email: "you@gmail.com",
        imapHost: "imap.gmail.com",
        imapPort: 993,
        smtpHost: "smtp.gmail.com",
        smtpPort: 465,
        passwordEncrypted: encryptSecret("app-password-secret"),
        createdAt: Date.now(),
        lastCheckedAt: null,
        lastError: null,
      })
      .run();

    const jules = await api("GET", "/api/mail/account", tokens["jules"]);
    expect(jules.json().connected).toBe(true);
    expect(jules.json().email).toBe("you@gmail.com");
    // The stored credential must never travel to the client.
    expect(jules.body).not.toContain("app-password-secret");
    expect(jules.body).not.toContain("passwordEncrypted");

    // Erin has her own (empty) mailbox — jules's connection is invisible to her.
    const erin = await api("GET", "/api/mail/account", tokens["erin"]);
    expect(erin.json().connected).toBe(false);
  });

  it("validates the uid before hitting the mailbox", async () => {
    expect((await api("GET", "/api/mail/message/0", tokens["jules"])).status).toBe(400);
    expect((await api("GET", "/api/mail/message/abc", tokens["jules"])).status).toBe(400);
  });

  it("disconnects only the caller's account", async () => {
    expect((await api("DELETE", "/api/mail/account", tokens["jules"])).status).toBe(200);
    expect((await api("GET", "/api/mail/account", tokens["jules"])).json().connected).toBe(false);
  });
});

/**
 * Nothing automated sends mail. The agent reads untrusted text — inbox messages,
 * notes any teammate can write — while holding the vault's contents and a live
 * SMTP session, so text arriving through those channels must not be able to
 * address a message out. Staging a draft is the most an automated caller can do;
 * the send itself needs a signed-in human.
 */
describe("mail send gate", () => {
  let apiToken: string;
  let draftId: string;

  beforeAll(async () => {
    // Reconnect an account (the disconnect test above removed it).
    db.insert(tables.mailAccounts)
      .values({
        id: `mail-${crypto.randomUUID().slice(0, 8)}`,
        userId: ids["jules"]!,
        email: "you@gmail.com",
        imapHost: "imap.gmail.com", imapPort: 993,
        smtpHost: "smtp.gmail.com", smtpPort: 465,
        passwordEncrypted: encryptSecret("app-password-secret"),
        createdAt: Date.now(), lastCheckedAt: null, lastError: null,
      })
      .run();
    const r = await api("POST", "/api/tokens", tokens["jules"], { label: "test-automation" });
    apiToken = r.json().token;
  });

  it("refuses a direct send from an API token", async () => {
    const r = await api("POST", "/api/mail/send", apiToken, { to: "x@y.com", subject: "hi", body: "yo" });
    expect(r.status).toBe(403);
    expect(r.json().error).toMatch(/cannot send mail directly/);
  });

  it("lets an automated caller stage a draft, attributed to its surface", async () => {
    const r = await api("POST", "/api/mail/drafts", apiToken, { to: "x@y.com", subject: "staged", body: "review me" });
    expect(r.status).toBe(200);
    expect(r.json().createdBy).toBe("token");
    draftId = r.json().id;

    const list = await api("GET", "/api/mail/drafts", tokens["jules"]);
    expect(list.json().map((d: { id: string }) => d.id)).toContain(draftId);
  });

  it("keeps drafts private to their owner", async () => {
    expect((await api("GET", "/api/mail/drafts", tokens["erin"])).json()).toEqual([]);
    // Erin cannot clear a draft she cannot see.
    await api("DELETE", `/api/mail/drafts/${draftId}`, tokens["erin"]);
    expect((await api("GET", "/api/mail/drafts", tokens["jules"])).json()).toHaveLength(1);
  });

  it("lets the owner discard a staged draft", async () => {
    expect((await api("DELETE", `/api/mail/drafts/${draftId}`, tokens["jules"])).status).toBe(200);
    expect((await api("GET", "/api/mail/drafts", tokens["jules"])).json()).toEqual([]);
  });
});
