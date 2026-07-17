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
import { ImapFlow } from "imapflow";
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
      for await (const msg of client.fetch(`${from}:*`, { envelope: true, flags: true, uid: true })) {
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
