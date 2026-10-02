import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, isAbort, latestOnly, type Me } from "./api.js";
import { IconMail, IconReply, IconSend, IconX } from "./icons.js";

/** Inbox envelope (list row) — mirrors the server's InboxItem. */
interface InboxItem {
  uid: number;
  from: string;
  fromName: string;
  subject: string;
  date: string | null;
  seen: boolean;
  messageId: string | null;
  category: MailCategory;
}

type MailCategory = "primary" | "social" | "promotions" | "updates" | "forums";
type MailTab = MailCategory | "all";

/** Gmail's tab glyphs: a tray, a price tag, two people, an info dot. */
const IconTray = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 13h4l1.5 2.5h5L16 13h4" />
    <path d="M4 13 6 5h12l2 8v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z" />
  </svg>
);
const IconTag = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20.6 13.4 12 4.8H5v7l8.6 8.6a1.7 1.7 0 0 0 2.4 0l4.6-4.6a1.7 1.7 0 0 0 0-2.4z" />
    <circle cx="8.5" cy="8.5" r="1.2" />
  </svg>
);
const IconPeople = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="9" cy="8" r="3.2" />
    <path d="M2.8 19.5a6.2 6.2 0 0 1 12.4 0" />
    <path d="M16.5 5.5a3 3 0 0 1 0 5.6M17.6 14.4a5.4 5.4 0 0 1 3.6 5.1" />
  </svg>
);
const IconInfo = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5M12 8h.01" />
  </svg>
);
const IconForum = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 12a7 7 0 0 1-9.6 6.5L5 20l1.5-4.4A7 7 0 1 1 20 12z" />
  </svg>
);
const IconStack = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 7h16M4 12h16M4 17h16" />
  </svg>
);

/**
 * Gmail's tabs in Gmail's order, plus an "All" that Gmail does not have —
 * because Gmail's tabs *hide* mail, and this inbox was one flat list before.
 * Primary is always shown even when empty: it is the one tab you look for, and
 * its absence reads as breakage rather than as "no personal mail today".
 */
const CATEGORIES: { id: MailTab; label: string; icon: () => React.ReactNode }[] = [
  { id: "primary", label: "Primary", icon: IconTray },
  { id: "promotions", label: "Promotions", icon: IconTag },
  { id: "social", label: "Social", icon: IconPeople },
  { id: "updates", label: "Updates", icon: IconInfo },
  { id: "forums", label: "Forums", icon: IconForum },
  { id: "all", label: "All", icon: IconStack },
];

interface MailMessage {
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

interface Account {
  connected: boolean;
  email: string | null;
  lastError: string | null;
}

interface Draft {
  to: string;
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
  /** Set when this came from a staged draft, so sending clears the stored row. */
  id?: string;
  createdBy?: "agent" | "token";
}

/** A message the agent (or an MCP client) prepared; it does not leave until you send it. */
interface PendingDraft {
  id: string;
  to: string;
  subject: string;
  body: string;
  inReplyTo: string | null;
  references: string | null;
  createdBy: "agent" | "token";
  createdAt: number;
}

const fmtDate = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

export function Mail({ me }: { me: Me }) {
  const [account, setAccount] = useState<Account | null | undefined>(undefined);
  const [messages, setMessages] = useState<InboxItem[] | null>(null);
  const [tab, setTab] = useState<MailTab>(() => (localStorage.getItem("basalt-mail-tab") as MailTab | null) ?? "all");
  const pickTab = (t: MailTab) => {
    localStorage.setItem("basalt-mail-tab", t);
    setTab(t);
  };

  // Only offer a tab once mail has actually landed in it — an empty Forums tab
  // is noise, and a server without Gmail's categories files everything as Primary.
  const tabs = CATEGORIES.filter(
    (c) => c.id === "all" || c.id === "primary" || (messages ?? []).some((m) => m.category === c.id),
  );
  const shown = (messages ?? []).filter((m) => tab === "all" || m.category === tab);
  const [listError, setListError] = useState<string | null>(null);
  const [loadingList, setLoadingList] = useState(false);

  const [selected, setSelected] = useState<number | null>(null);
  const [message, setMessage] = useState<MailMessage | null>(null);
  const [loadingMsg, setLoadingMsg] = useState(false);
  // Click one message, then another: the first one's body must not land last.
  const [nextMessage] = useState(latestOnly);

  const [draft, setDraft] = useState<Draft | null>(null);
  const [pending, setPending] = useState<PendingDraft[]>([]);

  const loadDrafts = useCallback(async () => {
    setPending(await api<PendingDraft[]>("GET", "/api/mail/drafts").catch(() => []));
  }, []);

  const discardDraft = useCallback(
    async (id: string) => {
      await api("DELETE", `/api/mail/drafts/${id}`).catch(() => {});
      void loadDrafts();
    },
    [loadDrafts],
  );

  const loadInbox = useCallback(async () => {
    setLoadingList(true);
    setListError(null);
    try {
      const r = await api<{ email: string; messages: InboxItem[] }>("GET", "/api/mail/inbox?limit=80");
      setMessages(r.messages);
    } catch (e) {
      setListError(e instanceof Error ? e.message : String(e));
      setMessages([]);
    } finally {
      setLoadingList(false);
    }
  }, []);

  useEffect(() => {
    void api<Account>("GET", "/api/mail/account").then((a) => {
      setAccount(a);
      if (a.connected) {
        void loadInbox();
        void loadDrafts();
      }
    });
  }, [loadInbox, loadDrafts]);

  const open = useCallback(async (uid: number) => {
    setSelected(uid);
    setMessage(null);
    setDraft(null);
    setLoadingMsg(true);
    const signal = nextMessage();
    try {
      const m = await api<MailMessage>("GET", `/api/mail/message/${uid}`, undefined, { signal });
      setMessage(m);
      // Reflect the read state in the list without a full refetch.
      setMessages((prev) => prev?.map((x) => (x.uid === uid ? { ...x, seen: true } : x)) ?? prev);
    } catch (e) {
      if (isAbort(e)) return;
      setMessage(null);
      setListError(e instanceof Error ? e.message : String(e));
    } finally {
      // A newer message is loading: its spinner is not ours to stop.
      if (!signal.aborted) setLoadingMsg(false);
    }
  }, [nextMessage]);

  const replyTo = (m: MailMessage) =>
    setDraft({
      to: m.from,
      subject: /^re:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`,
      body: "",
      inReplyTo: m.messageId ?? undefined,
      references: [m.references, m.messageId].filter(Boolean).join(" ") || undefined,
    });

  if (account === undefined) return <div className="mail-empty">Loading…</div>;

  if (!account?.connected) {
    return (
      <div className="mail">
        <div className="mail-empty">
          <IconMail />
          <h2>Mail isn’t connected yet</h2>
          <p>
            Open <strong>Settings → Mail</strong> and connect your Gmail with an app password. Your inbox and messages stay on this machine —
            nothing is sent anywhere but Google.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mail">
      <div className="mail-list">
        <header className="mail-list-head">
          <span className="mail-addr">{account.email}</span>
          <div className="mail-head-actions">
            <button className="ghost" title="Compose" onClick={() => { setSelected(null); setMessage(null); setDraft({ to: "", subject: "", body: "" }); }}>
              <IconSend />
            </button>
            <button className="ghost" title="Refresh" disabled={loadingList} onClick={() => void loadInbox()}>
              ↻
            </button>
          </div>
        </header>
        {listError && <p className="mail-list-error">{listError}</p>}
        {pending.length > 0 && (
          <div className="mail-pending">
            <p className="mail-pending-head">
              Waiting for you · {pending.length}
              <span className="mail-pending-sub">Prepared for you — nothing is sent until you review and press Send.</span>
            </p>
            {pending.map((p) => (
              <div key={p.id} className="mail-pending-row">
                <button
                  className="mail-pending-open"
                  onClick={() => {
                    setSelected(null);
                    setMessage(null);
                    setDraft({
                      to: p.to,
                      subject: p.subject,
                      body: p.body,
                      inReplyTo: p.inReplyTo ?? undefined,
                      references: p.references ?? undefined,
                      id: p.id,
                      createdBy: p.createdBy,
                    });
                  }}
                >
                  <span className="mail-pending-to">To {p.to}</span>
                  <span className="mail-pending-subject">{p.subject || "(no subject)"}</span>
                  <span className="mail-pending-src">{p.createdBy === "agent" ? "drafted by the agent" : "drafted via API token"}</span>
                </button>
                <button className="ghost mail-pending-x" onClick={() => void discardDraft(p.id)} aria-label="Discard draft">
                  <IconX />
                </button>
              </div>
            ))}
          </div>
        )}
        {tabs.length > 1 && (
          <div className="mail-tabs" role="tablist" aria-label="Categories">
            {tabs.map((c) => {
              const unread = (messages ?? []).filter((m) => (c.id === "all" || m.category === c.id) && !m.seen).length;
              return (
                <button
                  key={c.id}
                  role="tab"
                  aria-selected={tab === c.id}
                  className={`mail-tab ${tab === c.id ? "active" : ""}`}
                  onClick={() => pickTab(c.id)}
                >
                  <c.icon />
                  {c.label}
                  {unread > 0 && <i>{unread}</i>}
                </button>
              );
            })}
          </div>
        )}
        <div className="mail-rows">
          {loadingList && !messages?.length ? (
            <p className="mail-hint">Fetching inbox…</p>
          ) : messages && messages.length === 0 && !listError ? (
            <p className="mail-hint">Inbox is empty.</p>
          ) : shown.length === 0 ? (
            <p className="mail-hint">
              {tab === "primary"
                ? `No personal mail in the last ${messages?.length ?? 0} — everything recent is filed under the other tabs.`
                : `Nothing in ${CATEGORIES.find((c) => c.id === tab)?.label}.`}
            </p>
          ) : (
            shown.map((m, i) => (
              <button
                key={m.uid}
                className={`mail-row ${selected === m.uid ? "active" : ""} ${m.seen ? "" : "unread"} ${i === 0 ? "firstvis" : ""}`}
                onClick={() => void open(m.uid)}
              >
                <span className="mail-row-dot" aria-hidden />
                <span className="mail-row-main">
                  <span className="mail-row-top">
                    <span className="mail-row-from">{m.fromName || m.from || "(unknown)"}</span>
                    <span className="mail-row-date">{fmtDate(m.date)}</span>
                  </span>
                  <span className="mail-row-subject">{m.subject}</span>
                </span>
              </button>
            ))
          )}
        </div>
      </div>

      <div className="mail-pane">
        {draft ? (
          <Composer
            draft={draft}
            from={account.email!}
            onClose={() => setDraft(null)}
            onSent={() => { setDraft(null); void loadInbox(); void loadDrafts(); }}
          />
        ) : loadingMsg ? (
          <div className="mail-empty">Opening…</div>
        ) : message ? (
          <article className="mail-message">
            <header className="mail-msg-head">
              <h1>{message.subject}</h1>
              <div className="mail-msg-meta">
                <span className="mail-msg-from">
                  <strong>{message.fromName || message.from}</strong>
                  {message.fromName && <span className="mail-msg-addr">&lt;{message.from}&gt;</span>}
                </span>
                <span className="mail-msg-date">{message.date ? new Date(message.date).toLocaleString() : ""}</span>
              </div>
              <div className="mail-msg-to">to {message.to}</div>
              <button className="primary mail-reply-btn" onClick={() => replyTo(message)}>
                <IconReply /> Reply
              </button>
            </header>
            <MessageBody message={message} />
          </article>
        ) : (
          <div className="mail-empty">
            <IconMail />
            <p>Select a message to read it.</p>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Read a message the way it was written.
 *
 * HTML wins when the message has it: the plain-text alternative of a marketing
 * email is a wall of bracketed tracking URLs, which is what this pane used to
 * show. The HTML goes into an iframe that cannot run scripts and whose CSP
 * blocks everything except images, styles and fonts; links open in the real
 * browser.
 *
 * `allow-same-origin` is there so we can *measure* the rendered document and
 * size the frame to it — one scrollbar for the whole message, like a mail
 * client, instead of a fixed box with dead space. It is safe here precisely
 * because `allow-scripts` is absent: nothing inside can execute, so nothing can
 * use that origin.
 */
function MessageBody({ message }: { message: MailMessage }) {
  // Images load by default (what every mail client does); the choice is
  // remembered, so blocking trackers stays one click away and stays chosen.
  const [images, setImages] = useState(() => localStorage.getItem("basalt-mail-images") !== "off");
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(320);

  const setImagesPref = (on: boolean) => {
    localStorage.setItem("basalt-mail-images", on ? "on" : "off");
    setImages(on);
  };

  /** Grow the frame to its content, and again as images arrive. */
  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    let stop = false;
    const measure = () => {
      const doc = el.contentDocument;
      if (!doc?.body || stop) return;
      const next = Math.max(doc.documentElement.scrollHeight, doc.body.scrollHeight);
      if (next > 0) setHeight(next + 8);
    };
    const onLoad = () => {
      measure();
      const doc = el.contentDocument;
      for (const img of doc?.images ?? []) img.addEventListener("load", measure, { once: true });
      // Late reflows (web fonts, slow images) — a few cheap re-measures.
      for (const t of [150, 500, 1200, 2500]) setTimeout(measure, t);
    };
    el.addEventListener("load", onLoad);
    return () => {
      stop = true;
      el.removeEventListener("load", onLoad);
    };
  }, [message.uid, images]);

  if (message.html) {
    const csp = images
      ? "default-src 'none'; img-src data: https: http:; style-src 'unsafe-inline'; font-src data: https:"
      : "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:";
    return (
      <div className="mail-body-wrap">
        <div className="mail-images-bar">
          {images ? (
            <>
              <span>Images are loading from the sender.</span>
              <button className="ct-btn" onClick={() => setImagesPref(false)}>
                Block images
              </button>
            </>
          ) : (
            <>
              <span>Remote images are blocked — they can tell the sender you opened this.</span>
              <button className="ct-btn" onClick={() => setImagesPref(true)}>
                Show images
              </button>
            </>
          )}
        </div>
        <iframe
          key={`${message.uid}-${images}`}
          ref={frame}
          className="mail-body-html"
          style={{ height }}
          sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
          referrerPolicy="no-referrer"
          title="Message content"
          srcDoc={`<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><base target="_blank"><style>html,body{background:#fff;color:#111;overflow-x:hidden;} body{font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;padding:4px 2px;} img{max-width:100%;height:auto;} a{color:#2f6fdd;} table{max-width:100%;}</style>${message.html}`}
        />
      </div>
    );
  }
  if (message.text.trim()) return <div className="mail-body">{formatPlain(message.text)}</div>;
  return <div className="mail-body mail-hint">(no content)</div>;
}

const URL_RE = /https?:\/\/[^\s<>()\[\]]+/g;
const IMAGE_URL = /\.(png|jpe?g|gif|webp|svg)(\?|$)/i;

/**
 * Make a plain-text mail readable: drop the lines that are nothing but an image
 * URL, and show every other link as its host rather than 300 characters of
 * tracking parameters. The href keeps the full URL — only the label is short.
 */
function formatPlain(text: string): React.ReactNode[] {
  const host = (url: string) => {
    try {
      return new URL(url).host.replace(/^www\./, "");
    } catch {
      return url;
    }
  };

  return text
    .split("\n")
    .filter((line) => {
      const bare = line.trim().replace(/^\[|\]$/g, "");
      return !(URL_RE.test(bare) && IMAGE_URL.test(bare) && bare.replace(URL_RE, "").trim() === "");
    })
    .map((line, i) => {
      const parts: React.ReactNode[] = [];
      let last = 0;
      for (const m of line.matchAll(URL_RE)) {
        const start = m.index ?? 0;
        const before = line.slice(last, start).replace(/\[$/, "");
        if (before) parts.push(before);
        parts.push(
          <a key={`${i}-${start}`} href={m[0]} target="_blank" rel="noreferrer noopener" title={m[0]}>
            {host(m[0])}
          </a>,
        );
        last = start + m[0].length;
        if (line[last] === "]") last++;
      }
      const rest = line.slice(last);
      if (rest) parts.push(rest);
      return (
        <p key={i} className={line.trim() === "" ? "mail-gap" : undefined}>
          {parts.length ? parts : "\u00a0"}
        </p>
      );
    });
}

function Composer({ draft, from, onClose, onSent }: { draft: Draft; from: string; onClose: () => void; onSent: () => void }) {
  const [to, setTo] = useState(draft.to);
  const [subject, setSubject] = useState(draft.subject);
  const [body, setBody] = useState(draft.body);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bodyRef.current?.focus();
  }, []);

  const send = async () => {
    setSending(true);
    setError(null);
    try {
      await api("POST", "/api/mail/send", { to, subject, body, inReplyTo: draft.inReplyTo, references: draft.references });
      // The staged row has served its purpose once the real message is away.
      if (draft.id) await api("DELETE", `/api/mail/drafts/${draft.id}`).catch(() => {});
      setSent(true);
      setTimeout(onSent, 700);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      setSending(false);
    }
  };

  return (
    <form
      className="mail-composer"
      onSubmit={(e) => {
        e.preventDefault();
        if (to.trim() && !sending && !sent) void send();
      }}
    >
      <header className="mail-composer-head">
        <span>{draft.inReplyTo ? "Reply" : "New message"}</span>
        <button type="button" className="ghost" onClick={onClose} aria-label={draft.id ? "Close" : "Discard"}>
          <IconX />
        </button>
      </header>
      {draft.id && (
        <p className="mail-composer-flag">
          {draft.createdBy === "agent" ? "The agent wrote this draft." : "An API-token client wrote this draft."} Check the
          recipient and wording — sending is yours.
        </p>
      )}
      <label className="mail-field">
        <span>From</span>
        <input value={from} disabled />
      </label>
      <label className="mail-field">
        <span>To</span>
        <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="name@example.com" autoComplete="off" />
      </label>
      <label className="mail-field">
        <span>Subject</span>
        <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" />
      </label>
      <textarea ref={bodyRef} className="mail-composer-body" value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write your message…" />
      {error && <p className="mail-list-error">{error}</p>}
      <div className="mail-composer-actions">
        <button className="primary" disabled={sending || sent || !to.trim()}>
          <IconSend /> {sent ? "Sent" : sending ? "Sending…" : "Send"}
        </button>
        {/* A staged draft outlives this composer — closing leaves it in "Waiting
            for you", so don't call that discarding. It's dropped from the list. */}
        <button type="button" className="ghost" onClick={onClose}>
          {draft.id ? "Close" : "Discard"}
        </button>
      </div>
    </form>
  );
}
