/**
 * What the composer holds, and where it lives. Writing is a screen of its own on the phone
 * (list → message → reply, structure.md §2.8), so the composer has an address: the page it
 * opened from plus `?write=new|reply|forward`, or `?draft=<id>` for a draft Orr staged. Back
 * closes it; a reload keeps the page and drops the composer, as before.
 */
import type { MailMessage, PendingDraft } from "@orrama/schema/responses";
import { dateTimeLabel } from "../ui/dates.js";

export interface Draft {
  to: string;
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
  /** Set when this came from a staged draft, so sending clears the stored row. */
  id?: string;
  createdBy?: "agent" | "token";
  /** What the composer's head says. */
  title: "New message" | "Reply" | "Forward" | "Orr's draft" | "Staged draft";
}

export type Compose = { kind: "new" } | { kind: "reply" } | { kind: "forward" } | { kind: "draft"; id: string };

/** The composer an address asks for, if any. */
export function composeOf(search: string): Compose | null {
  const q = new URLSearchParams(search);
  const draft = q.get("draft");
  if (draft) return { kind: "draft", id: draft };
  const w = q.get("write");
  return w === "new" || w === "reply" || w === "forward" ? { kind: w } : null;
}

/** The address of a composer opened from `path` (a /mail address). */
export function composeHref(path: string, c: Compose): string {
  return c.kind === "draft" ? `${path}?draft=${encodeURIComponent(c.id)}` : `${path}?write=${c.kind}`;
}

export const emptyDraft = (): Draft => ({ to: "", subject: "", body: "", title: "New message" });

/** A reply, threaded under the message (In-Reply-To and References). */
export function replyDraft(m: MailMessage): Draft {
  return {
    to: m.from,
    subject: /^re:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`,
    body: "",
    inReplyTo: m.messageId ?? undefined,
    references: [m.references, m.messageId].filter(Boolean).join(" ") || undefined,
    title: "Reply",
  };
}

/** The text of an HTML message, for quoting it (the page's own parser; nothing runs). */
export function htmlText(html: string): string {
  if (typeof DOMParser === "undefined") return html.replace(/<[^>]+>/g, " ");
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const el of doc.querySelectorAll("style, script, head")) el.remove();
  for (const el of doc.querySelectorAll("br")) el.replaceWith("\n");
  for (const el of doc.querySelectorAll("p, div, tr, li, h1, h2, h3, h4, h5, h6")) el.append("\n");
  return (doc.body.textContent ?? "").replace(/[ \t ]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** A forward: the message's text below a short header, as mail clients write it. */
export function forwardDraft(m: MailMessage, now: Date = new Date()): Draft {
  const text = m.text.trim() || (m.html ? htmlText(m.html) : "");
  const from = m.fromName ? `${m.fromName} <${m.from}>` : m.from;
  const head = ["---------- Forwarded message ----------", `From: ${from}`, m.date ? `Date: ${dateTimeLabel(m.date, now)}` : "", `Subject: ${m.subject}`, `To: ${m.to}`]
    .filter(Boolean)
    .join("\n");
  return {
    to: "",
    subject: /^fwd?:/i.test(m.subject) ? m.subject : `Fwd: ${m.subject}`,
    body: `\n\n${head}\n\n${text}`,
    title: "Forward",
  };
}

/** A draft Orr (or an API-token client) staged: loaded as it is, so what goes out is what you read. */
export function stagedDraft(p: PendingDraft): Draft {
  return {
    to: p.to,
    subject: p.subject,
    body: p.body,
    inReplyTo: p.inReplyTo ?? undefined,
    references: p.references ?? undefined,
    id: p.id,
    createdBy: p.createdBy,
    title: p.createdBy === "agent" ? "Orr's draft" : "Staged draft",
  };
}
