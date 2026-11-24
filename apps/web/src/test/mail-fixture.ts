/**
 * A mailbox for Mail's DOM tests: `fetch` answers the mail endpoints from fixtures and records
 * every request, so a test can say what was sent and what was deleted. No real mailbox, ever.
 * The people are the mockups' fictional ones.
 */
import { vi } from "vitest";
import type { InboxItem, MailAccountRow, MailMessage, PendingDraft } from "@orrama/schema/responses";

export interface Sent {
  method: string;
  url: string;
  body: unknown;
}

export const INBOX: InboxItem[] = [
  {
    uid: 101,
    from: "i.vermaat@westerdok.example",
    fromName: "Ines Vermaat",
    subject: "Re: Research plan — section 3",
    date: "2026-10-08T08:01:00.000Z",
    seen: true,
    messageId: "<rp-3@westerdok.example>",
    category: "primary",
    account: "mail-1",
  },
  {
    uid: 102,
    from: "camille@tulp.example",
    fromName: "Camille Dubois",
    subject: "October report: one question about BE reach",
    date: "2026-10-08T05:43:00.000Z",
    seen: false,
    messageId: "<oct@tulp.example>",
    category: "primary",
    account: "mail-1",
  },
  {
    uid: 103,
    from: "news@oostrunners.example",
    fromName: "Oost Runners",
    subject: "Taper week: this Wednesday's session",
    date: "2026-10-06T07:00:00.000Z",
    seen: true,
    messageId: "<taper@oostrunners.example>",
    category: "updates",
    account: "mail-1",
  },
];

export const MESSAGES: Record<number, MailMessage> = {
  101: {
    uid: 101,
    from: "i.vermaat@westerdok.example",
    fromName: "Ines Vermaat",
    to: "jules@orrama.dev",
    subject: "Re: Research plan — section 3",
    date: "2026-10-08T08:01:00.000Z",
    text: "Thanks for the draft. Section 3 reads much better now.",
    html: null,
    messageId: "<rp-3@westerdok.example>",
    references: "<rp-1@westerdok.example>",
    attachments: [],
    account: "mail-1",
  },
  102: {
    uid: 102,
    from: "camille@tulp.example",
    fromName: "Camille Dubois",
    to: "jules@orrama.dev",
    subject: "October report: one question about BE reach",
    date: "2026-10-08T05:43:00.000Z",
    text: "One question about BE reach before Friday.",
    html: null,
    messageId: "<oct@tulp.example>",
    references: null,
    attachments: [],
    account: "mail-1",
  },
  103: {
    uid: 103,
    from: "news@oostrunners.example",
    fromName: "Oost Runners",
    to: "jules@orrama.dev",
    subject: "Taper week: this Wednesday's session",
    date: "2026-10-06T07:00:00.000Z",
    text: "",
    html: "<p>Easy <b>6 km</b> on Wednesday.</p>",
    messageId: "<taper@oostrunners.example>",
    references: null,
    attachments: [],
    account: "mail-1",
  },
};

/** Two drafts Orr staged: A is a new mail to Thijs, B a reply to Ines (threaded). */
export const DRAFTS: PendingDraft[] = [
  {
    id: "d-a",
    to: "thijs@westerdok.example",
    subject: "Agenda for Friday's review",
    body: "Draft A: the agenda, three points.",
    inReplyTo: null,
    references: null,
    createdBy: "agent",
    createdAt: Date.parse("2026-10-08T07:50:00.000Z"),
    account: null,
  },
  {
    id: "d-b",
    to: "i.vermaat@westerdok.example",
    subject: "Re: Research plan — section 3",
    body: "Draft B: thank you, Ines. Both are in section 3 now.",
    inReplyTo: "<rp-3@westerdok.example>",
    references: "<rp-1@westerdok.example> <rp-3@westerdok.example>",
    createdBy: "agent",
    createdAt: Date.parse("2026-10-08T08:12:00.000Z"),
    account: null,
  },
];

export const ACCOUNTS: MailAccountRow[] = [
  { id: "mail-1", email: "jules@orrama.dev", label: "jules@orrama.dev", isDefault: true, imapHost: "imap.gmail.com", lastCheckedAt: null, lastError: null },
  { id: "mail-2", email: "jules@kade.example", label: "Work", isDefault: false, imapHost: "imap.gmail.com", lastCheckedAt: null, lastError: null },
];

/** The second account's inbox: its uid 101 is another message than the first account's 101. */
export const WORK_INBOX: InboxItem[] = [
  {
    uid: 101,
    from: "thijs@kade.example",
    fromName: "Thijs Bakker",
    subject: "Quay drawings, rev C",
    date: "2026-10-08T09:30:00.000Z",
    seen: false,
    messageId: "<revc@kade.example>",
    category: "primary",
    account: "mail-2",
  },
];
export const WORK_MESSAGES: Record<number, MailMessage> = {
  101: {
    uid: 101,
    from: "thijs@kade.example",
    fromName: "Thijs Bakker",
    to: "jules@kade.example",
    subject: "Quay drawings, rev C",
    date: "2026-10-08T09:30:00.000Z",
    text: "Rev C is in the shared folder.",
    html: null,
    messageId: "<revc@kade.example>",
    references: null,
    attachments: [{ filename: "Quay rev C.pdf", contentType: "application/pdf", size: 48213 }],
    account: "mail-2",
  },
};

export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * Stub `fetch` with a connected Gmail account holding INBOX and DRAFTS (copies: a test may
 * change them). Returns the request log. `overrides` answers a path first (exact match on
 * method and path, query left off), for errors and empty states. `two` adds the Work account
 * (WORK_INBOX), merged into the inbox newest first as the server does.
 */
export function stubMailbox(overrides: Record<string, () => Response> = {}, { two = false }: { two?: boolean } = {}) {
  const accounts = two ? ACCOUNTS : ACCOUNTS.slice(0, 1);
  const sent: Sent[] = [];
  let drafts = DRAFTS.map((d) => ({ ...d }));
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    sent.push({ method, url, body });
    const path = url.replace(/\?.*$/, "");
    const own = overrides[`${method} ${path}`];
    if (own) return own();
    if (method === "GET" && path === "/api/mail/account")
      return json({ connected: true, email: "jules@orrama.dev", imapHost: "imap.gmail.com", lastCheckedAt: null, lastError: null, accounts: accounts.length });
    if (method === "GET" && path === "/api/mail/accounts") return json(accounts);
    if (method === "GET" && path === "/api/mail/inbox") {
      const messages = [...INBOX, ...(two ? WORK_INBOX : [])].map((m) => ({ ...m })).sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
      return json({ email: "jules@orrama.dev", messages, accounts: accounts.map((a) => ({ id: a.id, email: a.email, label: a.label, isDefault: a.isDefault, failed: false })) });
    }
    if (method === "GET" && path === "/api/mail/drafts") return json(drafts);
    const msg = /^\/api\/mail\/message\/(\d+)$/.exec(path);
    if (method === "GET" && msg) {
      const account = new URL(url, "http://x").searchParams.get("account") ?? "mail-1";
      const m = (account === "mail-2" ? WORK_MESSAGES : MESSAGES)[Number(msg[1])];
      return m ? json(m) : json({ error: "message not found" }, 404);
    }
    if (method === "POST" && path === "/api/mail/send") return json({ ok: true, messageId: "<sent@orrama.dev>" });
    const del = /^\/api\/mail\/drafts\/(.+)$/.exec(path);
    if (method === "DELETE" && del) {
      drafts = drafts.filter((d) => d.id !== del[1]);
      return json({ ok: true });
    }
    if (method === "GET" && (path === "/api/contacts" || path === "/api/companies" || path === "/api/projects")) return json([]);
    return json({ error: `no fixture for ${method} ${path}` }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { sent, fetchMock };
}
