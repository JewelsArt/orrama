/**
 * Settings → Developer (structure.md §3.1 #8): API tokens (scripts and the MCP server call the
 * API as you), outgoing webhooks (HMAC-signed), and the address Claude Code's MCP server talks
 * to. A new token or signing secret is shown once. Revoking a token and deleting a webhook ask
 * first (WEB-017): whatever used them stops working.
 */
import { useEffect, useState } from "react";
import type { ApiToken as TokenRow, Webhook as HookRow } from "@basalt/schema/responses";
import { api } from "../api.js";
import { Confirm, type ConfirmRequest } from "../Confirm.js";
import { Button } from "../ui/controls.js";
import { Field, Input } from "../ui/fields.js";
import { toast } from "../ui/overlays.js";
import { dateLabel } from "../ui/dates.js";
import { SectionHead, SubHead, said, type SectionMeta } from "./parts.js";

/** A token row; `token` only on the one answer that creates it, shown once. */
type ApiToken = TokenRow & { token?: string };
/** A webhook row; `secret` only on the answer that creates it, shown once. */
type Webhook = HookRow & { secret?: string };

const HOOK_EVENTS = [
  { id: "task.completed", label: "A task is done" },
  { id: "note.changed", label: "A note changes" },
];
/** The server records a class, not the far end's code (safeFetch.ts): say it in words. */
const hookResult = (s: number | null) => (s === 200 ? "delivered" : s === 400 ? "refused" : s === 500 ? "server error" : "unreachable or not allowed");

const copy = async (text: string, what: string) => {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} copied.`);
  } catch {
    toast("Couldn't copy. Select it and copy it.");
  }
};

export function DeveloperSection({ meta }: { meta: SectionMeta }) {
  const [ask, setAsk] = useState<ConfirmRequest | null>(null);
  return (
    <section className="set-sec" aria-label={meta.label}>
      <SectionHead meta={meta} />
      <Tokens ask={setAsk} />
      <Webhooks ask={setAsk} />
      <Mcp />
      <Confirm request={ask} onClose={() => setAsk(null)} />
    </section>
  );
}

type Ask = (r: ConfirmRequest) => void;

/** A secret shown once, with its copy button. */
function Reveal({ value, what, note }: { value: string; what: string; note: string }) {
  return (
    <div className="set-reveal">
      <div className="set-keyrow">
        <Input readOnly value={value} aria-label={what} onFocus={(e) => e.currentTarget.select()} />
        <Button onClick={() => void copy(value, what)}>Copy</Button>
      </div>
      <span className="set-help">{note}</span>
    </div>
  );
}

function Tokens({ ask }: { ask: Ask }) {
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [label, setLabel] = useState("");
  const [fresh, setFresh] = useState<ApiToken | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<ApiToken[]>("GET", "/api/tokens")
      .then(setTokens)
      .catch(() => setTokens([]));
  }, []);

  const create = async () => {
    setError(null);
    try {
      const t = await api<ApiToken>("POST", "/api/tokens", { label: label.trim() });
      setTokens((all) => [...all, t]);
      setFresh(t);
      setLabel("");
    } catch (e) {
      setError(said(e, "The token couldn't be made."));
    }
  };
  const revoke = (t: ApiToken) =>
    ask({
      title: `Revoke ${t.label}?`,
      body: "Whatever uses it (a script, a shortcut, Claude Code's MCP server) stops working until it gets a new token.",
      confirmLabel: "Revoke token",
      danger: true,
      onConfirm: () =>
        void api("DELETE", `/api/tokens/${t.id}`)
          .then(() => {
            setTokens((all) => all.filter((x) => x.id !== t.id));
            setFresh((f) => (f?.id === t.id ? null : f));
          })
          .catch((e) => toast(said(e, "The token couldn't be revoked."))),
    });

  return (
    <div>
      <SubHead>API tokens</SubHead>
      {tokens.map((t) => (
        <div key={t.id} className="set-item">
          <span className="set-dot ok" aria-hidden="true" />
          <span className="set-item-x">
            <b>{t.label}</b>
            <small>
              {t.prefix}… · {t.lastUsedAt ? `used ${dateLabel(t.lastUsedAt)}` : "never used"}
            </small>
          </span>
          <Button size="sm" danger onClick={() => revoke(t)} aria-label={`Revoke ${t.label}`}>
            Revoke
          </Button>
        </div>
      ))}
      {fresh?.token && <Reveal value={fresh.token} what="The token" note="Shown once: store it now. It reads and writes what you can, and can't send mail or change sign-in." />}
      <form
        className="set-add"
        onSubmit={(e) => {
          e.preventDefault();
          if (label.trim()) void create();
        }}
      >
        <Field label="Name" error={error} help={<>Scripts send it as <code>Authorization: Bearer bslt_…</code></>}>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Claude Code, Shortcuts…" />
        </Field>
        <Button type="submit" icon="plus" disabled={!label.trim()}>
          New token
        </Button>
      </form>
    </div>
  );
}

function Webhooks({ ask }: { ask: Ask }) {
  const [hooks, setHooks] = useState<Webhook[]>([]);
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<Set<string>>(new Set(["task.completed"]));
  const [fresh, setFresh] = useState<Webhook | null>(null);
  const [tested, setTested] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Webhook[]>("GET", "/api/webhooks")
      .then(setHooks)
      .catch(() => setHooks([]));
  }, []);

  const create = async () => {
    setError(null);
    try {
      const h = await api<Webhook>("POST", "/api/webhooks", { url: url.trim(), events: [...events] });
      setHooks((all) => [...all, h]);
      setFresh(h);
      setUrl("");
    } catch (e) {
      setError(said(e, "The webhook couldn't be added."));
    }
  };
  const test = async (h: Webhook) => {
    try {
      const r = await api<{ status: number | null }>("POST", `/api/webhooks/${h.id}/test`);
      setTested((t) => ({ ...t, [h.id]: hookResult(r.status) }));
    } catch (e) {
      toast(said(e, "The test couldn't be sent."));
    }
  };
  const remove = (h: Webhook) =>
    ask({
      title: "Delete this webhook?",
      body: `Nothing more is sent to ${h.url}. Adding it again makes a new signing secret.`,
      confirmLabel: "Delete webhook",
      danger: true,
      onConfirm: () =>
        void api("DELETE", `/api/webhooks/${h.id}`)
          .then(() => {
            setHooks((all) => all.filter((x) => x.id !== h.id));
            setFresh((f) => (f?.id === h.id ? null : f));
          })
          .catch((e) => toast(said(e, "The webhook couldn't be deleted."))),
    });
  const toggle = (id: string) =>
    setEvents((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div>
      <SubHead>Webhooks</SubHead>
      {hooks.map((h) => (
        <div key={h.id} className="set-item">
          <span className={h.lastStatus !== null && h.lastStatus !== 200 ? "set-dot bad" : "set-dot ok"} aria-hidden="true" />
          <span className="set-item-x">
            <b className="set-url" title={h.url}>
              {h.url}
            </b>
            <small>
              {h.events.map((ev) => HOOK_EVENTS.find((x) => x.id === ev)?.label ?? ev).join(", ")}
              {h.lastFiredAt !== null && ` · last: ${hookResult(h.lastStatus)}`}
              {tested[h.id] && ` · test: ${tested[h.id]}`}
            </small>
          </span>
          <Button size="sm" onClick={() => void test(h)} aria-label={`Send a test to ${h.url}`}>
            Test
          </Button>
          <Button size="sm" kind="quiet" icon="trash" danger aria-label={`Delete the webhook to ${h.url}`} tip="Delete" onClick={() => remove(h)} />
        </div>
      ))}
      {fresh?.secret && <Reveal value={fresh.secret} what="The signing secret" note="Shown once. Each POST carries an HMAC-SHA256 signature made with it." />}
      <form
        className="set-add"
        onSubmit={(e) => {
          e.preventDefault();
          if (url.trim() && events.size > 0) void create();
        }}
      >
        <Field label="Address" error={error} help="POSTed to when something you can read changes, signed with its secret.">
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://hooks.example.com/…" inputMode="url" />
        </Field>
        <Button type="submit" icon="plus" disabled={!url.trim() || events.size === 0}>
          Add
        </Button>
      </form>
      <div className="set-checks" role="group" aria-label="Send when">
        {HOOK_EVENTS.map((ev) => (
          <label key={ev.id}>
            <input type="checkbox" checked={events.has(ev.id)} onChange={() => toggle(ev.id)} />
            {ev.label}
          </label>
        ))}
      </div>
    </div>
  );
}

function Mcp() {
  const [how, setHow] = useState(false);
  const origin = location.origin;
  return (
    <div>
      <SubHead>MCP</SubHead>
      <div className="set-keyrow">
        <Input readOnly value={origin} aria-label="The MCP address" onFocus={(e) => e.currentTarget.select()} />
        <Button onClick={() => void copy(origin, "The address")}>Copy</Button>
      </div>
      <p className="set-help">
        Claude Code's MCP server reads and writes your notes through this address with an API token.{" "}
        <button type="button" className="set-how" aria-expanded={how} onClick={() => setHow(!how)}>
          How?
        </button>
      </p>
      {how && (
        <p className="set-help">
          Make a token above, then register the server at user scope, so the token stays in <code>~/.claude.json</code> and
          out of your notes: <code>claude mcp add basalt --scope user --env BASALT_URL={origin} --env BASALT_TOKEN=bslt_… -- node …/apps/mcp/dist/index.js</code>
        </p>
      )}
    </div>
  );
}
