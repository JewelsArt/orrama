/**
 * Personal email without OAuth (spec: self-hosted, credential-first). The user
 * pastes a Gmail *app password* (2FA required) once; we read the inbox over IMAP
 * (imapflow) and send/reply over SMTP (nodemailer). Everything runs on the user's
 * own Basalt server, so mail credentials and message bodies never leave the machine.
 *
 * Messages are never persisted — IMAP is the source of truth, fetched on demand,
 * exactly like the ICS feed layer. The only thing at rest is the app password,
 * AES-GCM encrypted (see secrets.ts).
 */
import { ImapFlow, type FetchMessageObject } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import { decryptSecret } from "./secrets.js";
import type { tables } from "./db.js";

export const GMAIL_DEFAULTS = { imapHost: "imap.gmail.com", imapPort: 993, smtpHost: "smtp.gmail.com", smtpPort: 465 };

type MailRow = typeof tables.mailAccounts.$inferSelect;

/** The connection config, with the password decrypted — never leaves the server. */
export interface MailCreds {
  email: string;
  password: string;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
}

export function credsFor(row: MailRow): MailCreds {
  return {
    email: row.email,
    password: decryptSecret(row.passwordEncrypted),
    imapHost: row.imapHost,
    imapPort: row.imapPort,
    smtpHost: row.smtpHost,
    smtpPort: row.smtpPort,
  };
}

/** Gmail shows app passwords grouped in fours ("abcd efgh ijkl mnop"); the spaces aren't part of it. */
export function normalizeAppPassword(pw: string): string {
  return pw.replace(/\s+/g, "");
}

function imapClient(c: MailCreds): ImapFlow {
  return new ImapFlow({
    host: c.imapHost,
    port: c.imapPort,
    secure: true,
    auth: { user: c.email, pass: c.password },
    logger: false,
    // A connect/login that hangs shouldn't hang the request.
    socketTimeout: 20_000,
  });
}

/** Open a connection and log out — throws with the provider's message if the creds are wrong. */
export async function verifyConnection(c: MailCreds): Promise<void> {
  const client = imapClient(c);
  try {
    await client.connect();
  } finally {
    await client.logout().catch(() => {});
  }
}

export interface InboxItem {
  uid: number;
  from: string;
  fromName: string;
  subject: string;
  date: string | null;
  seen: boolean;
  messageId: string | null;
  /** Gmail's own tab for this message, when the server tells us. */
  category: MailCategory;
}

export const MAIL_CATEGORIES = ["primary", "social", "promotions", "updates", "forums"] as const;
export type MailCategory = (typeof MAIL_CATEGORIES)[number];

/**
 * Which Gmail tab each uid sits in.
 *
 * Gmail classifies server-side and exposes it to IMAP through the `X-GM-RAW`
 * search extension, so this asks Gmail the same question its own UI answers.
 *
 * The catch that matters: **a message can hold several category labels at once**
 * — Revolut's newsletter comes back for both `category:primary` and
 * `category:updates` — and Gmail shows anything carrying `primary` in Primary.
 * So primary is searched too, and it wins; the other categories only decide
 * where a message goes when Gmail did not put it in Primary at all. Searching
 * only the non-primary categories (the obvious shortcut) files half your actual
 * inbox under Updates.
 */
async function gmailCategories(client: ImapFlow, uids: number[]): Promise<Map<number, MailCategory>> {
  const out = new Map<number, MailCategory>();
  const caps = client.capabilities;
  if (!caps?.has("X-GM-EXT-1") || uids.length === 0) return out;
  const lo = Math.min(...uids);
  const primary = new Set<number>();

  for (const category of MAIL_CATEGORIES) {
    try {
      // uid:lo:* keeps each search to the window we actually fetched.
      const hits = await client.search({ uid: `${lo}:*`, gmraw: `category:${category}` }, { uid: true });
      for (const uid of Array.isArray(hits) ? hits : []) {
        if (category === "primary") primary.add(uid);
        else out.set(uid, category);
      }
    } catch {
      // A server that lies about the capability, or a transient failure: the
      // affected messages stay Primary rather than the whole list failing.
    }
  }
  for (const uid of primary) out.set(uid, "primary");
  return out;
}

/** Most-recent `limit` messages from INBOX (envelopes only — cheap, one round trip). */
export async function listInbox(c: MailCreds, limit = 30): Promise<InboxItem[]> {
  const client = imapClient(c);
  const out: InboxItem[] = [];
  await client.connect();
  const lock = await client.getMailboxLock("INBOX");
  try {
    const total = client.mailbox && typeof client.mailbox !== "boolean" ? client.mailbox.exists : 0;
    if (total > 0) {
      const from = Math.max(1, total - limit + 1);
      const raw: { msg: FetchMessageObject; uid: number }[] = [];
      for await (const msg of client.fetch(`${from}:*`, { envelope: true, flags: true, uid: true })) raw.push({ msg, uid: msg.uid });
      const categories = await gmailCategories(client, raw.map((r) => r.uid));
      for (const { msg } of raw) {
        const env = msg.envelope;
        const sender = env?.from?.[0];
        out.push({
          uid: msg.uid,
          from: sender?.address ?? "",
          fromName: sender?.name || sender?.address || "",
          subject: env?.subject ?? "(no subject)",
          date: env?.date ? env.date.toISOString() : null,
          seen: msg.flags?.has("\\Seen") ?? false,
          messageId: env?.messageId ?? null,
          category: categories.get(msg.uid) ?? "primary",
        });
      }
    }
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }
  // IMAP returns oldest→newest; the inbox reads newest first.
  return out.reverse();
}

export interface MailMessage {
  uid: number;
  from: string;
  fromName: string;
  to: string;
  subject: string;
  date: string | null;
  text: string;
  html: string | null;
  messageId: string | null;
  references: string | null;
}

/** Full message body for one uid, parsed from the raw source. Marks it read. */
export async function getMessage(c: MailCreds, uid: number): Promise<MailMessage | null> {
  const client = imapClient(c);
  await client.connect();
  const lock = await client.getMailboxLock("INBOX");
  try {
    const msg = await client.fetchOne(String(uid), { source: true, envelope: true, uid: true }, { uid: true });
    if (!msg || !msg.source) return null;
    const parsed = await simpleParser(msg.source);
    const sender = msg.envelope?.from?.[0];
    // Opening a message marks it read, matching every mail client.
    await client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true }).catch(() => {});
    const refs = Array.isArray(parsed.references) ? parsed.references.join(" ") : (parsed.references ?? null);
    return {
      uid,
      from: sender?.address ?? "",
      fromName: sender?.name || sender?.address || "",
      to: Array.isArray(parsed.to) ? parsed.to.map((a) => a.text).join(", ") : (parsed.to?.text ?? ""),
      subject: parsed.subject ?? msg.envelope?.subject ?? "(no subject)",
      date: parsed.date ? parsed.date.toISOString() : (msg.envelope?.date?.toISOString() ?? null),
      text: parsed.text ?? "",
      html: typeof parsed.html === "string" ? parsed.html : null,
      messageId: parsed.messageId ?? msg.envelope?.messageId ?? null,
      references: refs,
    };
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }
}

export interface SendInput {
  to: string;
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
}

/** Send (or reply, when inReplyTo/references are set). Gmail auto-files SMTP sends in Sent. */
export async function sendMail(c: MailCreds, input: SendInput): Promise<{ messageId: string }> {
  const transporter = nodemailer.createTransport({
    host: c.smtpHost,
    port: c.smtpPort,
    secure: c.smtpPort === 465,
    // Any other port starts in plain text and upgrades with STARTTLS — but only
    // if the server offers it, and nodemailer's default was to carry on without
    // it. A network that strips STARTTLS from the greeting then received AUTH
    // with the mailbox password in base64. Require the upgrade; no TLS, no login.
    requireTLS: c.smtpPort !== 465,
    tls: { minVersion: "TLSv1.2" },
    auth: { user: c.email, pass: c.password },
  });
  const info = await transporter.sendMail({
    from: c.email,
    to: input.to,
    subject: input.subject,
    text: input.body,
    inReplyTo: input.inReplyTo,
    references: input.references,
  });
  return { messageId: info.messageId };
}
