/**
 * In-app email (spec: see & reply without leaving Orrama; app password, no OAuth).
 *
 * A person may connect several mail accounts (N1, schema 7: "my other addresses"), keyed on
 * user_id — the credentials are the caller's own, so every endpoint is implicitly self-scoped:
 * you can only ever read or send from your own mailboxes. The app password is AES-encrypted at
 * rest (secrets.ts); messages are fetched live over IMAP and never stored (like the ICS layer).
 *
 * One inbox across the accounts, newest first, each message saying which account it came to;
 * `?account=` narrows it to one. A reply goes from the account the mail came to, new mail from
 * the default (`isDefault`, else the first), and a draft keeps the account it was staged for.
 * An account is named by its id, its address or its label (`accountByRef`), which is how Orr
 * and the MCP tools say it.
 */
import crypto from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { projectSlugOf, type IndexedNote } from "@orrama/core";
import { mailAccountPatchSchema, mailConnectSchema, mailDraftSchema, mailNoteSchema, mailSendSchema } from "@orrama/schema";
import { tables, type Db } from "../db.js";
import { encryptSecret } from "../secrets.js";
import { HttpError, type VaultStore } from "../vaultStore.js";
import { mailNoteText, mailRef, noteFileName, noteTitle } from "../mailNote.js";
import { fieldLink } from "./contacts.js";
import { GMAIL_DEFAULTS, credsFor, getMessage, listInbox, normalizeAppPassword, sendMail, verifyConnection, type InboxItem } from "../mail.js";
import { assertPermittedHost } from "../safeFetch.js";
import { sessionOnly } from "./auth.js";

export type MailRow = typeof tables.mailAccounts.$inferSelect;

/** A person's accounts in their order (position, then the one connected first). */
export function accountsOf(db: Db, userId: string): MailRow[] {
  return db
    .select()
    .from(tables.mailAccounts)
    .where(eq(tables.mailAccounts.userId, userId))
    .all()
    .sort((a, b) => a.position - b.position || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

/** The account new mail goes from: the one marked default, else the first. */
export const defaultOf = (rows: MailRow[]): MailRow | undefined => rows.find((r) => r.isDefault) ?? rows[0];

/** What an account is called: its label, else its address. */
export const labelOf = (row: MailRow): string => row.label?.trim() || row.email;

const NONE = "no mail account connected — add one in Settings → Mail";

/**
 * The account a caller names — by id, address or label, case-insensitively — or the default
 * when they name none. A name that matches no account is refused with the names there are,
 * never answered from another account.
 */
export function accountByRef(rows: MailRow[], ref?: string | null): MailRow {
  if (rows.length === 0) throw new HttpError(400, NONE);
  const want = ref?.trim().toLowerCase();
  if (!want) return defaultOf(rows)!;
  const hit = rows.find((r) => r.id === ref) ?? rows.find((r) => r.email.toLowerCase() === want) ?? rows.find((r) => labelOf(r).toLowerCase() === want);
  if (!hit) throw new HttpError(400, `no mail account called "${ref}" — the accounts are ${rows.map((r) => (r.label ? `${r.label} (${r.email})` : r.email)).join(", ")}`);
  return hit;
}

/** One account as the client sees it — the password never, only where it reads and how it last went. */
export const accountRow = (row: MailRow, def: MailRow | undefined) => ({
  id: row.id,
  email: row.email,
  label: labelOf(row),
  isDefault: row.id === def?.id,
  imapHost: row.imapHost,
  lastCheckedAt: row.lastCheckedAt,
  lastError: row.lastError,
});

/** The default account in the shape `GET /api/mail/account` has always had (Today, a person's page). */
const accountPublic = (row: MailRow | undefined, count: number) =>
  row
    ? { connected: true, email: row.email, imapHost: row.imapHost, lastCheckedAt: row.lastCheckedAt, lastError: row.lastError, accounts: count }
    : { connected: false, email: null, imapHost: null, lastCheckedAt: null, lastError: null, accounts: 0 };

export type AccountMessage = InboxItem & { account: string };

/**
 * The inbox of the accounts asked for, merged newest first, each message marked with its
 * account. An account that can't be read is reported (`failed`) and the others still show;
 * only when every one fails does the caller get an error.
 */
export async function mergedInbox(rows: MailRow[], limit: number, mark: (id: string, error: string | null) => void) {
  const read = await Promise.all(
    rows.map(async (row) => {
      try {
        const items = await listInbox(credsFor(row), limit);
        mark(row.id, null);
        return { row, items: items.map((m): AccountMessage => ({ ...m, account: row.id })), error: null as string | null };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        mark(row.id, msg);
        return { row, items: [] as AccountMessage[], error: msg };
      }
    }),
  );
  const when = (m: AccountMessage) => (m.date ? Date.parse(m.date) || 0 : 0);
  const messages = read.flatMap((r) => r.items).sort((a, b) => when(b) - when(a));
  return { messages, failed: read.filter((r) => r.error !== null).map((r) => ({ row: r.row, error: r.error! })) };
}

/** `/mail/<uid>` for the default account's messages, `/mail/<account>.<uid>` for another's (web mail/accounts.ts). */
export const mailHref = (row: MailRow, rows: MailRow[], uid: number) => `/mail/${row.id === defaultOf(rows)?.id ? uid : `${row.id.replace(/^mail-/, "")}.${uid}`}`;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const pad = (n: number) => String(n).padStart(2, "0");
/** The day and the words for when a mail was sent, in the server's time (the Mac it runs on). */
function sentOn(iso: string | null): { day: string | null; when: string | null } {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return { day: null, when: null };
  return {
    day: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    when: `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

const addressesOf = (n: IndexedNote) => (typeof n.frontmatter["email"] === "string" ? (n.frontmatter["email"] as string) : "").toLowerCase().split(/[,;\s]+/).filter(Boolean);
const projectTags = (n: IndexedNote) => n.tags.filter((t) => t.line === 0).map((t) => projectSlugOf(t.tag)).filter((s): s is string => !!s);

export async function mailRoutes(app: FastifyInstance, db: Db, store: VaultStore) {
  const auth = { preHandler: [app.authenticate] };
  /** Where mail goes and who sends it: a signed-in human only (`authenticate` in main.ts). */
  const accountAuth = { preHandler: [app.authenticate], config: sessionOnly("connect or remove the mail account from a signed-in session, not with an API token") };

  /** Record health of the last IMAP/SMTP touch so the UI can surface a dead connection. */
  const markChecked = (id: string, error: string | null) =>
    db.update(tables.mailAccounts).set({ lastCheckedAt: Date.now(), lastError: error }).where(eq(tables.mailAccounts.id, id)).run();

  const listOf = (userId: string) => {
    const rows = accountsOf(db, userId);
    const def = defaultOf(rows);
    return rows.map((r) => accountRow(r, def));
  };

  /** The default account (the shape every older reader knows) and how many there are. */
  app.get("/api/mail/account", auth, async (req) => {
    const rows = accountsOf(db, req.userId);
    return accountPublic(defaultOf(rows), rows.length);
  });

  /** Every account, in order (Settings → Mail, Mail's filter and the composer's From). */
  app.get("/api/mail/accounts", auth, async (req) => listOf(req.userId));

  /**
   * Connect an account: a new address is added (the first becomes the default), an address
   * already connected gets its new password. Validates the creds against IMAP before saving.
   */
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
    const rows = accountsOf(db, req.userId);
    const existing = rows.find((r) => r.email.toLowerCase() === creds.email.toLowerCase());
    const label = body.label?.trim() || null;
    const row: MailRow = {
      id: existing?.id ?? `mail-${crypto.randomUUID().slice(0, 8)}`,
      userId: req.userId,
      // The address as first connected: the same one typed in another case is that account.
      email: existing?.email ?? creds.email,
      imapHost: creds.imapHost,
      imapPort: creds.imapPort,
      smtpHost: creds.smtpHost,
      smtpPort: creds.smtpPort,
      passwordEncrypted: encryptSecret(creds.password),
      createdAt: existing?.createdAt ?? Date.now(),
      lastCheckedAt: Date.now(),
      lastError: null,
      label: label ?? existing?.label ?? null,
      position: existing?.position ?? (rows.length ? Math.max(...rows.map((r) => r.position)) + 1 : 0),
      isDefault: existing ? existing.isDefault : rows.length === 0,
    };
    if (existing) db.update(tables.mailAccounts).set(row).where(eq(tables.mailAccounts.id, existing.id)).run();
    else db.insert(tables.mailAccounts).values(row).run();
    return accountRow(row, defaultOf(accountsOf(db, req.userId)));
  });

  /** Rename an account, make it the default, or move it in the list. */
  app.patch<{ Params: { id: string } }>("/api/mail/accounts/:id", accountAuth, async (req) => {
    const body = mailAccountPatchSchema.parse(req.body);
    const rows = accountsOf(db, req.userId);
    const row = rows.find((r) => r.id === req.params.id);
    if (!row) throw new HttpError(404, "mail account not found");
    db.transaction((tx) => {
      if (body.label !== undefined) {
        const label = body.label?.trim() || null;
        tx.update(tables.mailAccounts).set({ label: label === row.email ? null : label }).where(eq(tables.mailAccounts.id, row.id)).run();
      }
      if (body.default) {
        tx.update(tables.mailAccounts).set({ isDefault: false }).where(eq(tables.mailAccounts.userId, req.userId)).run();
        tx.update(tables.mailAccounts).set({ isDefault: true }).where(eq(tables.mailAccounts.id, row.id)).run();
      }
      if (body.position !== undefined) {
        const order = rows.filter((r) => r.id !== row.id);
        order.splice(Math.max(0, Math.min(body.position, order.length)), 0, row);
        order.forEach((r, i) => tx.update(tables.mailAccounts).set({ position: i }).where(eq(tables.mailAccounts.id, r.id)).run());
      }
    });
    return listOf(req.userId);
  });

  /**
   * Remove one account: its password is deleted. When it was the default, the next account in
   * the list is. Drafts staged for it stay, and go from the default when sent (the card says so).
   */
  app.delete<{ Params: { id: string } }>("/api/mail/accounts/:id", accountAuth, async (req) => {
    const rows = accountsOf(db, req.userId);
    const row = rows.find((r) => r.id === req.params.id);
    if (!row) throw new HttpError(404, "mail account not found");
    const wasDefault = defaultOf(rows)?.id === row.id;
    db.transaction((tx) => {
      tx.delete(tables.mailAccounts).where(and(eq(tables.mailAccounts.id, row.id), eq(tables.mailAccounts.userId, req.userId))).run();
      tx.update(tables.mailDrafts).set({ accountId: null }).where(and(eq(tables.mailDrafts.userId, req.userId), eq(tables.mailDrafts.accountId, row.id))).run();
      const next = rows.find((r) => r.id !== row.id);
      if (wasDefault && next) tx.update(tables.mailAccounts).set({ isDefault: true }).where(eq(tables.mailAccounts.id, next.id)).run();
    });
    return listOf(req.userId);
  });

  /** Every account at once (what Disconnect mail meant when there was one). */
  app.delete("/api/mail/account", accountAuth, async (req) => {
    db.transaction((tx) => {
      tx.delete(tables.mailAccounts).where(eq(tables.mailAccounts.userId, req.userId)).run();
      tx.update(tables.mailDrafts).set({ accountId: null }).where(eq(tables.mailDrafts.userId, req.userId)).run();
    });
    return { ok: true };
  });

  app.get<{ Querystring: { limit?: string; account?: string } }>("/api/mail/inbox", auth, async (req) => {
    const rows = accountsOf(db, req.userId);
    const one = req.query.account ? accountByRef(rows, req.query.account) : null;
    if (rows.length === 0) throw new HttpError(400, NONE);
    // 60, not 30: with Gmail's tabs on, personal mail is a small slice of the
    // inbox, and a 30-message window can hold no Primary at all.
    const limit = Math.min(Math.max(Number(req.query.limit) || 60, 1), 120);
    const from = one ? [one] : rows;
    const { messages, failed } = await mergedInbox(from, limit, markChecked);
    if (failed.length === from.length) throw new HttpError(502, `could not read inbox: ${failed[0]!.error}`);
    return {
      email: (one ?? defaultOf(rows))!.email,
      messages,
      accounts: from.map((r) => ({ id: r.id, email: r.email, label: labelOf(r), isDefault: r.id === defaultOf(rows)?.id, failed: failed.some((f) => f.row.id === r.id) })),
    };
  });

  app.get<{ Params: { uid: string }; Querystring: { account?: string } }>("/api/mail/message/:uid", auth, async (req) => {
    const row = accountByRef(accountsOf(db, req.userId), req.query.account);
    const uid = Number(req.params.uid);
    if (!Number.isInteger(uid) || uid <= 0) throw new HttpError(400, "invalid message id");
    try {
      const msg = await getMessage(credsFor(row), uid);
      markChecked(row.id, null);
      if (!msg) throw new HttpError(404, "message not found");
      return { ...msg, account: row.id };
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
   * draft instead; see stageDraft and the module doc on mail_drafts. It goes
   * from the account named (a reply: the one the mail came to), else the default.
   */
  const sendAuth = { preHandler: [app.authenticate], config: sessionOnly("API tokens cannot send mail directly — POST /api/mail/drafts and confirm it in Orrama") };
  app.post("/api/mail/send", sendAuth, async (req) => {
    const body = mailSendSchema.parse(req.body);
    const row = accountByRef(accountsOf(db, req.userId), body.account);
    try {
      const res = await sendMail(credsFor(row), body);
      markChecked(row.id, null);
      return { ok: true, messageId: res.messageId, account: row.id };
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      throw new HttpError(502, `could not send: ${m}`);
    }
  });

  /**
   * Make a note from a mail (N1): `Personal/<you>/<subject>.md`, written create-only through the
   * store (mailNote.ts says what it holds). A note already made from this message — the same
   * `message-id` — is answered instead, so a second click opens it. The projects it may belong
   * with are offered, never decided: a project tag on the sender's contact note, or on a note
   * made from an earlier mail of the same thread.
   */
  app.post("/api/mail/note", auth, async (req) => {
    const body = mailNoteSchema.parse(req.body);
    const rows = accountsOf(db, req.userId);
    const row = accountByRef(rows, body.account);
    let msg;
    try {
      msg = await getMessage(credsFor(row), body.uid);
      markChecked(row.id, null);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      markChecked(row.id, m);
      throw new HttpError(502, `could not read message: ${m}`);
    }
    if (!msg) throw new HttpError(404, "message not found");
    const user = store.aclUser(req.userId);
    const readable = store.readable(user);
    const ref = mailRef(msg, row.email);
    const contact = readable.find((n) => n.tags.some((t) => t.tag === "contact") && addressesOf(n).includes(msg.from.toLowerCase()));
    const thread = new Set((msg.references ?? "").split(/\s+/).filter(Boolean));
    const registered = new Map(
      store
        .projects(user)
        .filter((p) => p.kind === "tag")
        .map((p) => [projectSlugOf(p.key) ?? "", p.name]),
    );
    const offer = (already: string[]) => {
      const slugs = [...(contact ? projectTags(contact) : []), ...readable.filter((n) => thread.has(String(n.frontmatter["message-id"] ?? ""))).flatMap(projectTags)];
      return [...new Set(slugs)].filter((s) => registered.has(s) && !already.includes(s)).map((slug) => ({ slug, name: registered.get(slug)! }));
    };

    const made = readable.find((n) => n.frontmatter["message-id"] === ref);
    if (made) return { created: false, id: made.id, path: made.path, title: made.title, projects: offer(projectTags(made)) };

    const title = noteTitle(msg);
    const text = mailNoteText({ message: msg, title, ref, href: mailHref(row, rows, msg.uid), senderLink: contact ? fieldLink(contact) : null, ...sentOn(msg.date) });
    const name = noteFileName(title);
    for (let n = 1; n <= 50; n++) {
      const path = `Personal/${user.username}/${name}${n > 1 ? ` (${n})` : ""}.md`;
      try {
        const note = store.write(user, path, text, undefined, undefined, { create: true });
        return { created: true, id: note.id, path: note.path, title, projects: offer([]) };
      } catch (err) {
        if (err instanceof HttpError && err.statusCode === 409) continue;
        throw err;
      }
    }
    throw new HttpError(409, `fifty notes are already called ${name}: rename some first`);
  });

  // ---- Drafts awaiting human confirmation ---------------------------------

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
    const body = mailDraftSchema.parse(req.body);
    const row = accountByRef(accountsOf(db, req.userId), body.account);
    const draft = stageDraft(db, req.userId, { ...body, accountId: row.id }, req.viaToken ? "token" : "agent");
    return { ...draftPublic(draft), from: row.email };
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
  /** The account it goes from; null: the default, when it is sent. */
  account: d.accountId,
});

/** Shared with the AI tool layer so both stage drafts the same way. */
export function stageDraft(
  db: Db,
  userId: string,
  input: { to: string; subject: string; body: string; inReplyTo?: string; references?: string; accountId?: string | null },
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
    accountId: input.accountId ?? null,
  };
  db.insert(tables.mailDrafts).values(draft).run();
  return draft;
}
