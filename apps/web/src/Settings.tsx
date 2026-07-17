import { useEffect, useState } from "react";
import { api, type Me } from "./api.js";
import { CHARACTERS, CharacterAvatar } from "./avatars.js";
import { IconMoon, IconPlus, IconSignOut, IconSun, IconX } from "./icons.js";

export function Settings({
  me,
  theme,
  onTheme,
  onUpdate,
  onClose,
  onSignOut,
}: {
  me: Me;
  theme: string;
  onTheme: (t: string) => void;
  onUpdate: (me: Me) => void;
  onClose: () => void;
  onSignOut: () => void;
}) {
  const [name, setName] = useState(me.displayName);
  const [saving, setSaving] = useState(false);

  const patch = async (body: { avatar?: string; displayName?: string }) => {
    setSaving(true);
    try {
      onUpdate(await api<Me>("PATCH", "/api/me", body));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="settings" role="dialog" aria-label="Settings" onClick={(e) => e.stopPropagation()}>
        <header className="settings-head">
          <span>Settings</span>
          <button className="ghost" onClick={onClose} aria-label="Close">
            <IconX />
          </button>
        </header>

        <section>
          <h3>Character</h3>
          <div className="char-grid">
            {CHARACTERS.map((c) => (
              <button
                key={c.id}
                className={`char-pick ${me.avatar === c.id ? "active" : ""}`}
                title={c.name}
                disabled={saving}
                onClick={() => patch({ avatar: c.id })}
              >
                <CharacterAvatar id={c.id} size={40} />
                <span>{c.name}</span>
              </button>
            ))}
          </div>
        </section>

        <section>
          <h3>Profile</h3>
          <form
            className="settings-row"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim() && name !== me.displayName) void patch({ displayName: name });
            }}
          >
            <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Display name" />
            <button className="primary" disabled={saving || name.trim() === me.displayName}>
              Save
            </button>
          </form>
          <p className="settings-meta">
            @{me.username} · {me.email}
            {me.teams.length > 0 && <> · {me.teams.map((t) => t.name).join(", ")}</>}
            {me.isOwner && <> · workspace owner</>}
          </p>
        </section>

        <section>
          <h3>Theme</h3>
          <div className="settings-row">
            <button className={`theme-pick ${theme === "command" ? "active" : ""}`} onClick={() => onTheme("command")}>
              <IconMoon /> Graphite (dark)
            </button>
            <button className={`theme-pick ${theme === "light" || theme === "paper" ? "active" : ""}`} onClick={() => onTheme("light")}>
              <IconSun /> Frost (light)
            </button>
          </div>
        </section>

        <CalendarSection />
        <MailSection />
        <TokensSection />
        <WebhooksSection />

        <button className="settings-signout ghost" onClick={onSignOut}>
          <IconSignOut /> Sign out
        </button>
      </div>
    </div>
  );
}

/* ---------- integrations: calendar feeds (ICS in + out, no Google API) ---------- */

interface Feed {
  id: string;
  label: string;
  host: string | null;
  lastSyncedAt: number | null;
  lastError: string | null;
  eventCount?: number;
}

function CalendarSection() {
  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [icsToken, setIcsToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void api<Feed[]>("GET", "/api/calendar/feeds").then(setFeeds);
    void api<{ token: string | null }>("GET", "/api/me/ics-token").then((r) => setIcsToken(r.token));
  }, []);

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      const feed = await api<Feed>("POST", "/api/calendar/feeds", { label, url });
      setFeeds([...feeds, feed]);
      setLabel("");
      setUrl("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const feedUrl = icsToken ? `${location.origin}/ics/${icsToken}.ics` : null;

  return (
    <section>
      <h3>Calendar</h3>
      <p className="integr-hint">
        Subscribe to any calendar by its ICS address — in Google Calendar: Settings → your calendar →{" "}
        <em>Secret address in iCal format</em>. Events show in Planning as a read-only layer only you can see.
      </p>
      {feeds.map((f) => (
        <div key={f.id} className="integr-row">
          <span className="integr-main">
            {f.label}
            <span className="integr-sub">{f.lastError ? `error: ${f.lastError}` : (f.host ?? "")}</span>
          </span>
          {f.lastError && <span className="integr-bad">!</span>}
          <button
            className="ghost"
            title="Refresh now"
            onClick={async () => {
              const updated = await api<Feed>("POST", `/api/calendar/feeds/${f.id}/refresh`);
              setFeeds(feeds.map((x) => (x.id === f.id ? { ...x, ...updated } : x)));
            }}
          >
            ↻
          </button>
          <button
            className="ghost danger"
            title="Remove feed"
            onClick={async () => {
              await api("DELETE", `/api/calendar/feeds/${f.id}`);
              setFeeds(feeds.filter((x) => x.id !== f.id));
            }}
          >
            <IconX />
          </button>
        </div>
      ))}
      <form
        className="settings-row"
        onSubmit={(e) => {
          e.preventDefault();
          if (label.trim() && url.trim() && !busy) void add();
        }}
      >
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label (Uni, Scooperz…)" aria-label="Feed label" style={{ flex: "0 1 140px" }} />
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…/basic.ics" aria-label="Feed URL" />
        <button className="primary" disabled={busy || !label.trim() || !url.trim()}>
          <IconPlus />
        </button>
      </form>
      {error && <p className="integr-error">{error}</p>}

      <h3 style={{ marginTop: 14 }}>Publish my planning</h3>
      {feedUrl ? (
        <>
          <div className="integr-row">
            <span className="integr-main integr-url" title={feedUrl}>
              {feedUrl}
            </span>
            <button
              className="ghost"
              onClick={async () => {
                await navigator.clipboard.writeText(feedUrl);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? "copied" : "copy"}
            </button>
            <button
              className="ghost"
              title="Rotate URL (old one stops working)"
              onClick={async () => setIcsToken((await api<{ token: string }>("POST", "/api/me/ics-token")).token)}
            >
              ↻
            </button>
            <button
              className="ghost danger"
              title="Disable feed"
              onClick={async () => {
                await api("DELETE", "/api/me/ics-token");
                setIcsToken(null);
              }}
            >
              <IconX />
            </button>
          </div>
          <p className="integr-hint">Add this URL in Google Calendar (Other calendars → From URL) or Apple Calendar — your blocks and events, everywhere.</p>
        </>
      ) : (
        <div className="settings-row">
          <button className="theme-pick" onClick={async () => setIcsToken((await api<{ token: string }>("POST", "/api/me/ics-token")).token)}>
            Create private feed URL
          </button>
        </div>
      )}
    </section>
  );
}

/* ---------- integrations: personal mail account (IMAP/SMTP, app password) ---------- */

interface MailAccount {
  connected: boolean;
  email: string | null;
  lastError: string | null;
}

function MailSection() {
  const [acct, setAcct] = useState<MailAccount | null>(null);
  const [email, setEmail] = useState("");
  const [appPassword, setAppPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api<MailAccount>("GET", "/api/mail/account").then(setAcct);
  }, []);

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await api<MailAccount>("POST", "/api/mail/account", { email, appPassword });
      setAcct(next);
      setEmail("");
      setAppPassword("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h3>Mail</h3>
      {acct?.connected ? (
        <>
          <div className="integr-row">
            <span className="integr-main">
              {acct.email}
              <span className="integr-sub">{acct.lastError ? `error: ${acct.lastError}` : "connected · read & reply in the Mail tab"}</span>
            </span>
            {acct.lastError && <span className="integr-bad">!</span>}
            <button
              className="ghost danger"
              title="Disconnect mail"
              onClick={async () => {
                await api("DELETE", "/api/mail/account");
                setAcct({ connected: false, email: null, lastError: null });
              }}
            >
              <IconX />
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="integr-hint">
            Connect Gmail with an <em>app password</em> (not your normal password): enable 2-Step Verification, then Google Account → Security →{" "}
            <em>App passwords</em> → generate one for “Mail”. It stays encrypted on this machine — mail never leaves your server.
          </p>
          <form
            className="settings-col"
            onSubmit={(e) => {
              e.preventDefault();
              if (email.trim() && appPassword.trim() && !busy) void connect();
            }}
          >
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@gmail.com" aria-label="Email address" />
            <div className="settings-row">
              <input
                type="password"
                value={appPassword}
                onChange={(e) => setAppPassword(e.target.value)}
                placeholder="app password (16 chars)"
                aria-label="App password"
                autoComplete="off"
              />
              <button className="primary" disabled={busy || !email.trim() || !appPassword.trim()}>
                {busy ? "Connecting…" : "Connect"}
              </button>
            </div>
          </form>
          {error && <p className="integr-error">{error}</p>}
        </>
      )}
    </section>
  );
}

/* ---------- integrations: personal API tokens ---------- */

interface ApiToken {
  id: string;
  label: string;
  prefix: string;
  lastUsedAt: number | null;
  token?: string;
}

function TokensSection() {
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [label, setLabel] = useState("");
  const [fresh, setFresh] = useState<ApiToken | null>(null);

  useEffect(() => {
    void api<ApiToken[]>("GET", "/api/tokens").then(setTokens);
  }, []);

  return (
    <section>
      <h3>API tokens</h3>
      <p className="integr-hint">
        Scripts and shortcuts call the API as you: <code>Authorization: Bearer bslt_…</code>
      </p>
      {tokens.map((t) => (
        <div key={t.id} className="integr-row">
          <span className="integr-main">
            {t.label}
            <span className="integr-sub">
              {t.prefix}… · {t.lastUsedAt ? `used ${new Date(t.lastUsedAt).toLocaleDateString()}` : "never used"}
            </span>
          </span>
          <button
            className="ghost danger"
            title="Revoke token"
            onClick={async () => {
              await api("DELETE", `/api/tokens/${t.id}`);
              setTokens(tokens.filter((x) => x.id !== t.id));
              if (fresh?.id === t.id) setFresh(null);
            }}
          >
            <IconX />
          </button>
        </div>
      ))}
      {fresh?.token && (
        <div className="integr-reveal">
          <span className="integr-url">{fresh.token}</span>
          <button className="ghost" onClick={() => void navigator.clipboard.writeText(fresh.token!)}>
            copy
          </button>
          <span className="integr-sub">shown once — store it now</span>
        </div>
      )}
      <form
        className="settings-row"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!label.trim()) return;
          const t = await api<ApiToken>("POST", "/api/tokens", { label });
          setTokens([...tokens, t]);
          setFresh(t);
          setLabel("");
        }}
      >
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label (Shortcut, n8n…)" aria-label="Token label" />
        <button className="primary" disabled={!label.trim()}>
          <IconPlus />
        </button>
      </form>
    </section>
  );
}

/* ---------- integrations: outgoing webhooks ---------- */

interface Webhook {
  id: string;
  url: string;
  events: string[];
  lastStatus: number | null;
  lastFiredAt: number | null;
  secret?: string;
}

const HOOK_EVENTS = ["note.changed", "task.completed"];

function WebhooksSection() {
  const [hooks, setHooks] = useState<Webhook[]>([]);
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<Set<string>>(new Set(["task.completed"]));
  const [fresh, setFresh] = useState<Webhook | null>(null);
  const [testStatus, setTestStatus] = useState<Record<string, string>>({});

  useEffect(() => {
    void api<Webhook[]>("GET", "/api/webhooks").then(setHooks);
  }, []);

  return (
    <section>
      <h3>Webhooks</h3>
      <p className="integr-hint">POST to your URL when something you can read changes. Signed with the secret (HMAC-SHA256).</p>
      {hooks.map((h) => (
        <div key={h.id} className="integr-row">
          <span className="integr-main integr-url" title={h.url}>
            {h.url}
            <span className="integr-sub">
              {h.events.join(", ")}
              {h.lastStatus !== null && ` · last ${h.lastStatus}`}
              {testStatus[h.id] && ` · test: ${testStatus[h.id]}`}
            </span>
          </span>
          <button
            className="ghost"
            title="Send test ping"
            onClick={async () => {
              const r = await api<{ status: number | null }>("POST", `/api/webhooks/${h.id}/test`);
              setTestStatus({ ...testStatus, [h.id]: r.status === null ? "unreachable" : String(r.status) });
            }}
          >
            test
          </button>
          <button
            className="ghost danger"
            title="Delete webhook"
            onClick={async () => {
              await api("DELETE", `/api/webhooks/${h.id}`);
              setHooks(hooks.filter((x) => x.id !== h.id));
              if (fresh?.id === h.id) setFresh(null);
            }}
          >
            <IconX />
          </button>
        </div>
      ))}
      {fresh?.secret && (
        <div className="integr-reveal">
          <span className="integr-url">{fresh.secret}</span>
          <button className="ghost" onClick={() => void navigator.clipboard.writeText(fresh.secret!)}>
            copy
          </button>
          <span className="integr-sub">signing secret — shown once</span>
        </div>
      )}
      <form
        className="settings-row"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!url.trim() || events.size === 0) return;
          const h = await api<Webhook>("POST", "/api/webhooks", { url, events: [...events] });
          setHooks([...hooks, h]);
          setFresh(h);
          setUrl("");
        }}
      >
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://hooks.example.com/…" aria-label="Webhook URL" />
        <button className="primary" disabled={!url.trim() || events.size === 0}>
          <IconPlus />
        </button>
      </form>
      <div className="integr-checks">
        {HOOK_EVENTS.map((ev) => (
          <label key={ev}>
            <input
              type="checkbox"
              checked={events.has(ev)}
              onChange={() => {
                const next = new Set(events);
                if (next.has(ev)) next.delete(ev);
                else next.add(ev);
                setEvents(next);
              }}
            />
            {ev}
          </label>
        ))}
      </div>
    </section>
  );
}
