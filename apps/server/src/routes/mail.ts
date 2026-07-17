/**
 * In-app email (spec: see & reply without leaving Basalt; app password, no OAuth).
 *
 * One mail account per user, keyed on user_id — the credentials are the caller's
 * own, so every endpoint is implicitly self-scoped: you can only ever read or send
 * from your own inbox. The app password is AES-encrypted at rest (secrets.ts);
 * messages are fetched live over IMAP and never stored (like the ICS layer).
 */
import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { mailConnectSchema, mailSendSchema } from "@basalt/schema";
import { tables, type Db } from "../db.js";
import { encryptSecret } from "../secrets.js";
import { HttpError } from "../vaultStore.js";
import { GMAIL_DEFAULTS, credsFor, getMessage, listInbox, normalizeAppPassword, sendMail, verifyConnection } from "../mail.js";

type MailRow = typeof tables.mailAccounts.$inferSelect;

/** Public shape — the password is never returned, only whether an account is wired up. */
const accountPublic = (row: MailRow | undefined) =>
  row
    ? { connected: true, email: row.email, imapHost: row.imapHost, lastCheckedAt: row.lastCheckedAt, lastError: row.lastError }
    : { connected: false, email: null, imapHost: null, lastCheckedAt: null, lastError: null };

export async function mailRoutes(app: FastifyInstance, db: Db) {
  const auth = { preHandler: [app.authenticate] };
  const accountOf = (userId: string) => db.select().from(tables.mailAccounts).where(eq(tables.mailAccounts.userId, userId)).get();

  const requireAccount = (userId: string): MailRow => {
    const row = accountOf(userId);
    if (!row) throw new HttpError(400, "no mail account connected — add one in Settings → Mail");
    return row;
  };

  /** Record health of the last IMAP/SMTP touch so the UI can surface a dead connection. */
  const markChecked = (id: string, error: string | null) =>
    db.update(tables.mailAccounts).set({ lastCheckedAt: Date.now(), lastError: error }).where(eq(tables.mailAccounts.id, id)).run();

  app.get("/api/mail/account", auth, async (req) => accountPublic(accountOf(req.userId)));

  /** Connect (or replace) the account. Validates the creds against IMAP before saving. */
  app.post("/api/mail/account", auth, async (req) => {
    const body = mailConnectSchema.parse(req.body);
    const creds = {
      email: body.email,
      password: normalizeAppPassword(body.appPassword),
      imapHost: body.imapHost ?? GMAIL_DEFAULTS.imapHost,
      imapPort: body.imapPort ?? GMAIL_DEFAULTS.imapPort,
      smtpHost: body.smtpHost ?? GMAIL_DEFAULTS.smtpHost,
      smtpPort: body.smtpPort ?? GMAIL_DEFAULTS.smtpPort,
    };
    try {
      await verifyConnection(creds);
    } catch (err) {
      throw new HttpError(400, `could not sign in: ${err instanceof Error ? err.message : String(err)}`);
    }
    const existing = accountOf(req.userId);
    const row: MailRow = {
      id: existing?.id ?? `mail-${crypto.randomUUID().slice(0, 8)}`,
      userId: req.userId,
      email: creds.email,
      imapHost: creds.imapHost,
      imapPort: creds.imapPort,
      smtpHost: creds.smtpHost,
      smtpPort: creds.smtpPort,
      passwordEncrypted: encryptSecret(creds.password),
      createdAt: existing?.createdAt ?? Date.now(),
      lastCheckedAt: Date.now(),
      lastError: null,
    };
    if (existing) db.update(tables.mailAccounts).set(row).where(eq(tables.mailAccounts.id, existing.id)).run();
    else db.insert(tables.mailAccounts).values(row).run();
    return accountPublic(row);
  });

  app.delete("/api/mail/account", auth, async (req) => {
    db.delete(tables.mailAccounts).where(eq(tables.mailAccounts.userId, req.userId)).run();
    return { ok: true };
  });

  app.get<{ Querystring: { limit?: string } }>("/api/mail/inbox", auth, async (req) => {
    const row = requireAccount(req.userId);
    const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
    try {
      const items = await listInbox(credsFor(row), limit);
      markChecked(row.id, null);
      return { email: row.email, messages: items };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      markChecked(row.id, msg);
      throw new HttpError(502, `could not read inbox: ${msg}`);
    }
  });

  app.get<{ Params: { uid: string } }>("/api/mail/message/:uid", auth, async (req) => {
    const row = requireAccount(req.userId);
    const uid = Number(req.params.uid);
    if (!Number.isInteger(uid) || uid <= 0) throw new HttpError(400, "invalid message id");
    try {
      const msg = await getMessage(credsFor(row), uid);
      markChecked(row.id, null);
      if (!msg) throw new HttpError(404, "message not found");
      return msg;
    } catch (err) {
      if (err instanceof HttpError) throw err;
      const m = err instanceof Error ? err.message : String(err);
      markChecked(row.id, m);
      throw new HttpError(502, `could not read message: ${m}`);
    }
  });

  app.post("/api/mail/send", auth, async (req) => {
    const row = requireAccount(req.userId);
    const body = mailSendSchema.parse(req.body);
    try {
      const res = await sendMail(credsFor(row), body);
      markChecked(row.id, null);
      return { ok: true, messageId: res.messageId };
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      throw new HttpError(502, `could not send: ${m}`);
    }
  });
}
