/**
 * Settings → Connections (structure.md §3.1 #5): calendars you follow (ICS feeds in), your mail
 * (Gmail with an app password), and Publish my planning (your blocks and events as a private
 * ICS link). Everything that cannot be undone asks first (WEB-017): removing a feed, the mail
 * account (Google shows an app password once), and turning off or changing the published link
 * (every calendar subscribed to it stops updating).
 */
import { useEffect, useState } from "react";
import type { Feed, MailAccount } from "@basalt/schema/responses";
import { api } from "../api.js";
import { Confirm, type ConfirmRequest } from "../Confirm.js";
import { Button } from "../ui/controls.js";
import { Field, Input } from "../ui/fields.js";
import { RowList } from "../ui/layout.js";
import { toast } from "../ui/overlays.js";
import { Notice } from "../ui/states.js";
import { dateTimeLabel } from "../ui/dates.js";
import { SectionHead, StateLine, SubHead, said, type SectionMeta } from "./parts.js";

export function ConnectionsSection({ meta }: { meta: SectionMeta }) {
  const [ask, setAsk] = useState<ConfirmRequest | null>(null);
  return (
    <section className="set-sec" aria-label={meta.label}>
      <SectionHead meta={meta} />
      <Calendars ask={setAsk} />
      <MailAccountPart ask={setAsk} />
      <Publish ask={setAsk} />
      <Confirm request={ask} onClose={() => setAsk(null)} />
    </section>
  );
}

type Ask = (r: ConfirmRequest) => void;

function Calendars({ ask }: { ask: Ask }) {
  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [how, setHow] = useState(false);

  useEffect(() => {
    api<Feed[]>("GET", "/api/calendar/feeds")
      .then(setFeeds)
      .catch(() => setFeeds([]));
  }, []);

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      const feed = await api<Feed>("POST", "/api/calendar/feeds", { label: label.trim(), url: url.trim() });
      setFeeds((f) => [...f, feed]);
      setLabel("");
      setUrl("");
    } catch (e) {
      setError(said(e, "That calendar couldn't be added."));
    } finally {
      setBusy(false);
    }
  };
  const refresh = async (f: Feed) => {
    try {
      const updated = await api<Feed>("POST", `/api/calendar/feeds/${f.id}/refresh`);
      setFeeds((all) => all.map((x) => (x.id === f.id ? { ...x, ...updated } : x)));
      toast(updated.lastError ? `${f.label} couldn't be read.` : `${f.label} is up to date.`);
    } catch (e) {
      toast(said(e, `${f.label} couldn't be read.`));
    }
  };
  const remove = (f: Feed) =>
    ask({
      title: `Remove ${f.label}?`,
      body: "Its events leave Planning. To see them again you'll need its ICS address again.",
      confirmLabel: "Remove calendar",
      danger: true,
      onConfirm: () =>
        void api("DELETE", `/api/calendar/feeds/${f.id}`)
          .then(() => setFeeds((all) => all.filter((x) => x.id !== f.id)))
          .catch((e) => toast(said(e, `${f.label} couldn't be removed.`))),
    });

  return (
    <div>
      <SubHead>Calendars</SubHead>
      {feeds.length > 0 && (
        <RowList label="Calendars">
          {feeds.map((f) => (
            <div key={f.id} className="set-item">
              <span className={f.lastError ? "set-dot bad" : "set-dot ok"} aria-hidden="true" />
              <span className="set-item-x">
                <b>{f.label}</b>
                <small>
                  {f.lastError ? `Couldn't be read: ${f.lastError}` : `${f.host ?? ""}${f.lastSyncedAt ? ` · read ${dateTimeLabel(f.lastSyncedAt)}` : ""}`}
                </small>
              </span>
              <Button size="sm" kind="quiet" icon="repeat" aria-label={`Read ${f.label} again now`} tip="Read again now" onClick={() => void refresh(f)} />
              <Button size="sm" kind="quiet" icon="trash" danger aria-label={`Remove ${f.label}`} tip="Remove" onClick={() => remove(f)} />
            </div>
          ))}
        </RowList>
      )}
      <form
        className="set-add"
        onSubmit={(e) => {
          e.preventDefault();
          if (label.trim() && url.trim() && !busy) void add();
        }}
      >
        <Field label="Name">
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="School, Work…" />
        </Field>
        <Field label="ICS address" error={error}>
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…/basic.ics" inputMode="url" />
        </Field>
        <Button type="submit" icon="plus" disabled={busy || !label.trim() || !url.trim()}>
          Add
        </Button>
      </form>
      <p className="set-help">
        Its events show in Planning, only to you, and can't be edited here.{" "}
        <button type="button" className="set-how" aria-expanded={how} onClick={() => setHow(!how)}>
          Where's the address?
        </button>
      </p>
      {how && (
        <p className="set-help">
          In Google Calendar: Settings, your calendar, then <em>Secret address in iCal format</em>. In Apple Calendar: share
          the calendar publicly and copy its link.
        </p>
      )}
    </div>
  );
}

const NO_MAIL: MailAccount = { connected: false, email: null, imapHost: null, lastCheckedAt: null, lastError: null };

function MailAccountPart({ ask }: { ask: Ask }) {
  const [acct, setAcct] = useState<MailAccount | null>(null);
  const [email, setEmail] = useState("");
  const [appPassword, setAppPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [how, setHow] = useState(false);

  useEffect(() => {
    api<MailAccount>("GET", "/api/mail/account")
      .then(setAcct)
      .catch(() => setAcct(NO_MAIL));
  }, []);

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      setAcct(await api<MailAccount>("POST", "/api/mail/account", { email: email.trim(), appPassword }));
      setEmail("");
      setAppPassword("");
    } catch (e) {
      setError(said(e, "Gmail didn't accept that. Check the address and the app password."));
    } finally {
      setBusy(false);
    }
  };
  const disconnect = () =>
    ask({
      title: "Disconnect mail?",
      body: "The app password is deleted from this server. Google shows an app password only once, so connecting again means making a new one.",
      confirmLabel: "Disconnect mail",
      danger: true,
      onConfirm: () =>
        void api("DELETE", "/api/mail/account")
          .then(() => setAcct(NO_MAIL))
          .catch((e) => toast(said(e, "Mail couldn't be disconnected."))),
    });

  return (
    <div>
      <SubHead>Mail</SubHead>
      {acct?.connected ? (
        <StateLine
          tone={acct.lastError ? "bad" : "ok"}
          title={acct.email ?? "Connected"}
          detail={acct.lastError ? `Couldn't connect: ${acct.lastError}` : "read and reply in Mail"}
          action={
            <Button size="sm" danger onClick={disconnect}>
              Disconnect
            </Button>
          }
        />
      ) : (
        <>
          <form
            className="set-add"
            onSubmit={(e) => {
              e.preventDefault();
              if (email.trim() && appPassword.trim() && !busy) void connect();
            }}
          >
            <Field label="Gmail address">
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@gmail.com" autoComplete="email" />
            </Field>
            <Field label="App password" error={error}>
              <Input type="password" value={appPassword} onChange={(e) => setAppPassword(e.target.value)} placeholder="16 letters" autoComplete="off" />
            </Field>
            <Button type="submit" kind="solid" disabled={busy || !email.trim() || !appPassword.trim()}>
              {busy ? "Connecting…" : "Connect"}
            </Button>
          </form>
          <p className="set-help">
            An app password, not your Google password. It stays encrypted on this Mac; mail never leaves your server.{" "}
            <button type="button" className="set-how" aria-expanded={how} onClick={() => setHow(!how)}>
              How?
            </button>
          </p>
          {how && (
            <p className="set-help">
              Turn on 2-Step Verification, then Google Account, Security, <em>App passwords</em>: make one for Mail and paste
              it here.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function Publish({ ask }: { ask: Ask }) {
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ token: string | null }>("GET", "/api/me/ics-token")
      .then((r) => setToken(r.token))
      .catch(() => setToken(null));
  }, []);

  const mint = async () => {
    setError(null);
    try {
      setToken((await api<{ token: string }>("POST", "/api/me/ics-token")).token);
    } catch (e) {
      setError(said(e, "The link couldn't be made."));
    }
  };
  const url = token ? `${location.origin}/ics/${token}.ics` : null;
  const copy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      toast("Link copied.");
    } catch {
      toast("Couldn't copy. Select the link and copy it.");
    }
  };
  const rotate = () =>
    ask({
      title: "Make a new link?",
      body: "The current link stops working at once: every calendar subscribed to it stops updating until it's added again with the new one.",
      confirmLabel: "Make a new link",
      danger: true,
      onConfirm: () => void mint(),
    });
  const off = () =>
    ask({
      title: "Stop publishing your planning?",
      body: "The link stops working at once and calendars subscribed to it stop updating. Publishing again makes a new link.",
      confirmLabel: "Stop publishing",
      danger: true,
      onConfirm: () =>
        void api("DELETE", "/api/me/ics-token")
          .then(() => setToken(null))
          .catch((e) => setError(said(e, "Publishing couldn't be turned off."))),
    });

  return (
    <div>
      <SubHead>Publish my planning</SubHead>
      {token === undefined ? null : url ? (
        <>
          <div className="set-keyrow">
            <Input readOnly value={url} aria-label="Your planning's private link" onFocus={(e) => e.currentTarget.select()} />
            <Button onClick={() => void copy()}>
              Copy
            </Button>
          </div>
          <p className="set-help">Add it in Google Calendar (Other calendars, From URL) or Apple Calendar: your blocks and events, everywhere. Anyone with the link can read it.</p>
          <div className="set-actions">
            <Button size="sm" icon="repeat" onClick={rotate}>
              New link
            </Button>
            <Button size="sm" danger onClick={off}>
              Stop publishing
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="set-help set-lead">Your blocks and events as a private calendar link, for Google or Apple Calendar.</p>
          <div className="set-actions">
            <Button onClick={() => void mint()}>Make a private link</Button>
          </div>
        </>
      )}
      {error && <Notice title="Not done" text={error} />}
    </div>
  );
}
