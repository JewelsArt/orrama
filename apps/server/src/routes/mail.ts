/**
 * In-app email (spec: see & reply without leaving Basalt; app password, no OAuth).
 *
 * One mail account per user, keyed on user_id — the credentials are the caller's
 * own, so every endpoint is implicitly self-scoped: you can only ever read or send
 * from your own inbox. The app password is AES-encrypted at rest (secrets.ts);
 * messages are fetched live over IMAP and never stored (like the ICS layer).
 */
import crypto from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { mailConnectSchema, mailSendSchema } from "@orrama/schema";
import { tables, type Db } from "../db.js";
import { encryptSecret } from "../secrets.js";
import { HttpError } from "../vaultStore.js";
import { GMAIL_DEFAULTS, credsFor, getMessage, listInbox, normalizeAppPassword, sendMail, verifyConnection } from "../mail.js";
import { assertPermittedHost } from "../safeFetch.js";
import { sessionOnly } from "./auth.js";

type MailRow = typeof tables.mailAccounts.$inferSelect;

/** Public shape — the password is never returned, only whether an account is wired up. */
const accountPublic = (row: MailRow | undefined) =>
  row
    ? { connected: true, email: row.email, imapHost: row.imapHost, lastCheckedAt: row.lastCheckedAt, lastError: row.lastError }
    : { connected: false, email: null, imapHost: null, lastCheckedAt: null, lastError: null };

export async function mailRoutes(app: FastifyInstance, db: Db) {
  const auth = { preHandler: [app.authenticate] };
  /** Where mail goes and who sends it: a signed-in human only (`authenticate` in main.ts). */
  const accountAuth = { preHandler: [app.authenticate], config: sessionOnly("connect or remove the mail account from a signed-in session, not with an API token") };
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
  app.post("/api/mail/account", accountAuth, async (req) => {
    const body = mailConnectSchema.parse(req.body);
    const creds = {
      email: body.email,
      password: normalizeAppPassword(body.appPassword),
      imapHost: body.imapHost ?? GMAIL_DEFAULTS.imapHost,
      imapPort: body.imapPort ?? GMAIL_DEFAULTS.imapPort,
      smtpHost: body.smtpHost ?? GMAIL_DEFAULTS.smtpHost,
      smtpPort: body.smtpPort ?? GMAIL_DEFAULTS.smtpPort,
    };
    // Same rules as any other user-typed address (safeFetch.ts): a private or
    // loopback mail server must be named in ORRAMA_FETCH_ALLOW, and the reply
    // is coarse. It used to connect anywhere and hand back the socket error
    // ("connect ECONNREFUSED 10.0.0.5:993"), a port scanner for the server's
    // network (audit SEC-014). The detail goes to the log only.
    try {
      for (const host of new Set([creds.imapHost, creds.smtpHost])) await assertPermittedHost(host);
    } catch (err) {
      req.log.warn({ err: err instanceof Error ? err.message : String(err) }, "mail account: server address refused");
      throw new HttpError(400, "that mail server address is not allowed — a private one must be listed in ORRAMA_FETCH_ALLOW");
    }
    try {
      await verifyConnection(creds);
    } catch (err) {
      req.log.warn({ err: err instanceof Error ? err.message : String(err) }, "mail account: sign-in check failed");
      throw new HttpError(400, "could not sign in to the mail server — check the address, the app password, and that IMAP is on");
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

  app.delete("/api/mail/account", accountAuth, async (req) => {
    db.delete(tables.mailAccounts).where(eq(tables.mailAccounts.userId, req.userId)).run();
    return { ok: true };
  });

  app.get<{ Querystring: { limit?: string } }>("/api/mail/inbox", auth, async (req) => {
    const row = requireAccount(req.userId);
    // 60, not 30: with Gmail's tabs on, personal mail is a small slice of the
    // inbox, and a 30-message window can hold no Primary at all.
    const limit = Math.min(Math.max(Number(req.query.limit) || 60, 1), 120);
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

  /**
   * Send immediately — only from a signed-in session, i.e. a human at the
   * keyboard. API tokens (MCP clients, scripts) and the in-app agent stage a
   * draft instead; see stageDraft and the module doc on mail_drafts.
   */
  const sendAuth = { preHandler: [app.authenticate], config: sessionOnly("API tokens cannot send mail directly — POST /api/mail/drafts and confirm it in Basalt") };
  app.post("/api/mail/send", sendAuth, async (req) => {
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

  // ---- Drafts awaiting human confirmation ---------------------------------

  const draftPublic = (d: typeof tables.mailDrafts.$inferSelect) => ({
    id: d.id,
    to: d.to,
    subject: d.subject,
    body: d.body,
    // Carried through so the composer can still thread an agent-drafted reply.
    inReplyTo: d.inReplyTo,
    references: d.references,
    createdBy: d.createdBy,
    createdAt: d.createdAt,
  });

  app.get("/api/mail/drafts", auth, async (req) =>
    db
      .select()
      .from(tables.mailDrafts)
      .where(eq(tables.mailDrafts.userId, req.userId))
      .all()
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(draftPublic),
  );

  /** Stage a message for the caller to approve. Open to API tokens by design. */
  app.post("/api/mail/drafts", auth, async (req) => {
    requireAccount(req.userId);
    const body = mailSendSchema.parse(req.body);
    const draft = stageDraft(db, req.userId, body, req.viaToken ? "token" : "agent");
    return draftPublic(draft);
  });

  /**
   * Discard — also how a confirmed draft is cleared: the UI opens it in the
   * composer, so the bytes that go out are the ones the user just looked at
   * (and possibly edited), sent through /api/mail/send like any other message.
   * There is deliberately no "send this stored draft" endpoint; one send path
   * means one place where a session is required.
   */
  app.delete<{ Params: { id: string } }>("/api/mail/drafts/:id", auth, async (req) => {
    db.delete(tables.mailDrafts)
      .where(and(eq(tables.mailDrafts.id, req.params.id), eq(tables.mailDrafts.userId, req.userId)))
      .run();
    return { ok: true };
  });
}

/** Shared with the AI tool layer so both stage drafts the same way. */
export function stageDraft(
  db: Db,
  userId: string,
  input: { to: string; subject: string; body: string; inReplyTo?: string; references?: string },
  createdBy: "agent" | "token",
) {
  const draft = {
    id: `draft-${crypto.randomUUID().slice(0, 8)}`,
    userId,
    to: input.to,
    subject: input.subject,
    body: input.body,
    inReplyTo: input.inReplyTo ?? null,
    references: input.references ?? null,
    createdBy,
    createdAt: Date.now(),
  };
  db.insert(tables.mailDrafts).values(draft).run();
  return draft;
}
