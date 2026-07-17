import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, type Me } from "./api.js";
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
}

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
  const [listError, setListError] = useState<string | null>(null);
  const [loadingList, setLoadingList] = useState(false);

  const [selected, setSelected] = useState<number | null>(null);
  const [message, setMessage] = useState<MailMessage | null>(null);
  const [loadingMsg, setLoadingMsg] = useState(false);

  const [draft, setDraft] = useState<Draft | null>(null);

  const loadInbox = useCallback(async () => {
    setLoadingList(true);
    setListError(null);
    try {
      const r = await api<{ email: string; messages: InboxItem[] }>("GET", "/api/mail/inbox?limit=40");
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
      if (a.connected) void loadInbox();
    });
  }, [loadInbox]);

  const open = useCallback(async (uid: number) => {
    setSelected(uid);
    setMessage(null);
    setDraft(null);
    setLoadingMsg(true);
    try {
      const m = await api<MailMessage>("GET", `/api/mail/message/${uid}`);
      setMessage(m);
      // Reflect the read state in the list without a full refetch.
      setMessages((prev) => prev?.map((x) => (x.uid === uid ? { ...x, seen: true } : x)) ?? prev);
    } catch (e) {
      setMessage(null);
      setListError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingMsg(false);
    }
  }, []);

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
        <div className="mail-rows">
          {loadingList && !messages?.length ? (
            <p className="mail-hint">Fetching inbox…</p>
          ) : messages && messages.length === 0 && !listError ? (
            <p className="mail-hint">Inbox is empty.</p>
          ) : (
            messages?.map((m, i) => (
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
            onSent={() => { setDraft(null); void loadInbox(); }}
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

/** Prefer plain text; fall back to a sandboxed iframe for HTML-only mail (no script, no style bleed). */
function MessageBody({ message }: { message: MailMessage }) {
  if (message.text.trim()) return <div className="mail-body">{message.text}</div>;
  if (message.html) {
    return (
      <iframe
        className="mail-body-html"
        sandbox=""
        title="Message content"
        srcDoc={`<!doctype html><meta charset="utf-8"><base target="_blank"><style>body{font-family:system-ui,sans-serif;color:#111;margin:12px;}</style>${message.html}`}
      />
    );
  }
  return <div className="mail-body mail-hint">(no content)</div>;
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
        <button type="button" className="ghost" onClick={onClose} aria-label="Discard">
          <IconX />
        </button>
      </header>
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
        <button type="button" className="ghost" onClick={onClose}>
          Discard
        </button>
      </div>
    </form>
  );
}
