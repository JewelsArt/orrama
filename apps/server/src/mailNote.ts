/**
 * A note made from a mail in one click (N1, Jules 10 Nov: "make a note from an email in one
 * click"). Pure: what the note is called, where it goes, what it says. The route
 * (`POST /api/mail/note`, routes/mail.ts) reads the message, finds the note already made from it,
 * and writes through `VaultStore.write`, create-only.
 *
 * - Its title is the subject without its `Re:` / `Fwd:` (and their cousins), its file name the
 *   title as a name every disk holds, in `Personal/<you>/` (Jules, 24 Nov), where quick capture
 *   already keeps loose notes. A name taken is `<title> (2)`, and so on.
 * - Its front matter follows the vault's conventions (`title`, `tags`, `domain`; the store adds
 *   `id`), plus `from`, `date`, `message-id` (the stable reference: making it again opens this
 *   note) and `mail` (the message's address in Orrama).
 * - Its body: who it is from (their page, when a `#contact` note has their address), when, the
 *   text as Mail's reader shows it, made safe so nothing in it becomes a task, a tag or a link
 *   (core `mailMarkdown`), and the attachments by name. No heading: the title is the note's
 *   name, and Notes shows it. No link to the message in the body either: `/mail/…` is an address
 *   in Orrama, and a relative link in Obsidian opens (or makes) a note of that name. The
 *   front matter's `mail` holds it.
 */
import { mailMarkdown, mailSafe } from "@orrama/core";
import type { MailMessage } from "./mail.js";

/** `Re: Fwd: AW: [External] Quay drawings` → `Quay drawings`. */
export function cleanSubject(subject: string): string {
  let s = subject.trim();
  for (let i = 0; i < 10; i++) {
    const next = s.replace(/^(?:(?:re|fwd?|aw|wg|sv|vs|antw|tr|rif|r)\s*(?:\[\d+\])?\s*[:：]|\[[^\]]{1,30}\])\s*/i, "").trim();
    if (next === s) break;
    s = next;
  }
  return s;
}

/** The note's title: the cleaned subject, else who it is from. */
export function noteTitle(m: Pick<MailMessage, "subject" | "fromName" | "from">): string {
  const s = cleanSubject(m.subject === "(no subject)" ? "" : m.subject).replace(/\s+/g, " ");
  return (s || `Mail from ${m.fromName || m.from || "someone"}`).slice(0, 120).trim();
}

/** The title as a file name every disk holds (portableName.ts' rules), without `/` or `\`. */
export function noteFileName(title: string): string {
  let name = title
    .replace(/["*:<>?|/\\#^[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "")
    .slice(0, 100)
    .trim()
    .replace(/[. ]+$/, "");
  if (/^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i.test(name)) name = `${name} mail`;
  return name || "Mail";
}

/** The stable reference to a message: its Message-ID, else its place in its mailbox. */
export const mailRef = (m: Pick<MailMessage, "messageId" | "uid">, accountEmail: string): string => m.messageId?.trim() || `uid:${m.uid}@${accountEmail}`;

const q = (s: string) => JSON.stringify(s);

export interface MailNoteInput {
  message: MailMessage;
  title: string;
  ref: string;
  /** The message's address in Orrama, `/mail/…`. */
  href: string;
  /** The sender's page as a link, when a `#contact` note has their address. */
  senderLink: string | null;
  /** The day it was sent, YYYY-MM-DD, in the server's time; null when the mail has no date. */
  day: string | null;
  /** When it was sent, said in words ("Thu 8 Oct 2026, 10:01"). */
  when: string | null;
}

export function mailNoteText({ message: m, title, ref, href, senderLink, day, when }: MailNoteInput): string {
  const from = m.fromName && m.fromName !== m.from ? `${m.fromName} <${m.from}>` : m.from;
  const fm = ["---", `title: ${q(title)}`, "tags: [mail]", "domain: personal", `from: ${q(from)}`, ...(day ? [`date: ${day}`] : []), `message-id: ${q(ref)}`, `mail: ${q(href)}`, "---"];
  const who = senderLink ? `${senderLink} (${m.from})` : mailSafe(from);
  const head = [`From ${who}`, when].filter(Boolean).join(" · ");
  const body = mailMarkdown(m.text || "");
  // `- [ ] x.pdf` would be a step: a name's own `[` is written as text.
  const files = m.attachments.length ? ["", "## Attachments", "", ...m.attachments.map((a) => `- ${mailSafe(a.filename).replace(/^\[/, "\\[")}`)] : [];
  return [...fm, head, "", body || "_This mail has no text._", ...files, ""].join("\n");
}
