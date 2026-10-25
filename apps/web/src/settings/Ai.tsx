/**
 * Orr's AI: which service he thinks with. One form, two places (2C): Settings → Orr & AI
 * (structure.md §3.1 #3), owners only (the server checks), and the third step of first run
 * (door/AiStep.tsx). Both use `useAiForm` for the state and the requests and `AiFields` for
 * what is shown under the choice, so the two never drift apart.
 *
 * The choices: a ChatGPT plan (Sign in with ChatGPT, for everyone under the AGPL: chatgpt.ts),
 * an API key (Anthropic or Google, with a two-line guide and its link, checked with the
 * provider before it is saved: `POST /api/admin/ai/check`), or an OpenAI-compatible server
 * (Settings only). First run adds Later: Orr stays off and nothing is sent anywhere.
 *
 * The key is write-only: it never comes back from the server, only whether one is stored, so
 * the field shows that one is stored and Replace opens an empty field; a blank key keeps the
 * stored one.
 *
 * ChatGPT's sign-in: in the desktop app the shell opens OpenAI's page in the system browser
 * (Google refuses to sign in inside an app's window), so the page starts a sign-in it waits for
 * (`wait: true`) and watches GET /api/admin/ai every 2 s, and when the window comes back to the
 * front, for up to 10 minutes; the browser is told it can close. In a browser tab on the
 * computer Orrama runs on, the tab itself goes to OpenAI and comes back (`?ai=chatgpt-connected`,
 * App.tsx): it already works there, and a second tab opened after a request is blocked by Safari.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { AiConfig } from "@orrama/schema/responses";
import { api } from "../api.js";
import { Confirm, type ConfirmRequest } from "../Confirm.js";
import { inApp } from "../desktop.js";
import { Button } from "../ui/controls.js";
import { Field, Input, RadioGroup, Select, Textarea } from "../ui/fields.js";
import { Orr } from "../ui/orr/Orr.js";
import { Notice, Skeleton } from "../ui/states.js";
import { SectionHead, StateLine, said, type SectionMeta } from "./parts.js";

export type AiKind = "chatgpt" | "key" | "openai-compatible";
export type Company = "anthropic" | "google";
const COMPANY: Record<Company, string> = { anthropic: "Anthropic", google: "Google (Gemini)" };
const PROVIDER_NAME: Record<string, string> = { chatgpt: "ChatGPT plan", anthropic: "Anthropic", google: "Google", "openai-compatible": "OpenAI-compatible" };

/** The model a new key starts with; the check says so if the key can't use it. */
export const DEFAULT_MODEL: Record<Company, string> = { anthropic: "claude-sonnet-5-5", google: "gemini-flash-latest" };

/** Where a key comes from, in two lines, and the page to make one. */
export const KEY_GUIDE: Record<Company, { lines: [string, string]; href: string; link: string }> = {
  anthropic: {
    lines: ["Make a key in Anthropic's console, under API keys, and paste it here.", "Anthropic bills you for what Orr asks. You can set a monthly limit there."],
    href: "https://console.anthropic.com/settings/keys",
    link: "Open Anthropic's console",
  },
  google: {
    lines: ["Make a key in Google AI Studio, with Get API key, and paste it here.", "Google bills past a free allowance. You can set limits in Google Cloud."],
    href: "https://aistudio.google.com/apikey",
    link: "Open Google AI Studio",
  },
};

/** How long the page waits for a sign-in in the browser. */
export const SIGN_IN_WAIT_MS = 10 * 60_000;
const SIGN_IN_POLL_MS = 2000;

const kindOf = (p: string | null): AiKind => (p === "chatgpt" ? "chatgpt" : p === "openai-compatible" ? "openai-compatible" : "key");

/** The provider part of the form: its state, what changed, and its requests. */
export function useAiForm({ onAdopt, start }: { onAdopt?: (c: AiConfig) => void; start?: AiKind } = {}) {
  const [cfg, setCfg] = useState<AiConfig | null | undefined>(undefined);
  const [kind, setKind] = useState<AiKind>("key");
  const [company, setCompany] = useState<Company>("anthropic");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [planModels, setPlanModels] = useState<{ slug: string; name: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** When the browser sign-in started, while the page waits for it. */
  const [waiting, setWaiting] = useState<number | null>(null);
  /** The sign-in the page waited for has landed. */
  const [signedIn, setSignedIn] = useState(false);
  const adopted = useRef(onAdopt);
  useEffect(() => {
    adopted.current = onAdopt;
  });

  /** Take what the server says, and drop every unsaved edit. */
  const adopt = useCallback((c: AiConfig) => {
    setCfg(c);
    setKind(start ?? (c.provider ? kindOf(c.provider) : c.chatgpt.connected ? "chatgpt" : "key"));
    if (c.provider === "anthropic" || c.provider === "google") setCompany(c.provider);
    setModel(c.model ?? "");
    setBaseUrl(c.baseUrl);
    setApiKey("");
    setReplacing(false);
    adopted.current?.(c);
  }, [start]);
  const load = useCallback(async () => {
    try {
      adopt(await api<AiConfig>("GET", "/api/admin/ai"));
    } catch {
      setCfg(null);
    }
  }, [adopt]);
  useEffect(() => {
    void load();
  }, [load]);

  const connected = !!cfg?.chatgpt.connected;
  useEffect(() => {
    if (kind !== "chatgpt" || !connected) return;
    api<{ slug: string; name: string }[]>("GET", "/api/admin/ai/chatgpt/models")
      .then(setPlanModels)
      .catch(() => setPlanModels([]));
  }, [kind, connected]);

  // Waiting for the sign-in in the browser: ask every 2 s and when the window is back in front.
  useEffect(() => {
    if (waiting === null) return;
    let alive = true;
    const look = async () => {
      try {
        const c = await api<AiConfig>("GET", "/api/admin/ai");
        if (alive && c.chatgpt.connected) {
          setWaiting(null);
          setSignedIn(true);
          adopt(c);
        }
      } catch {
        /* asked again in a moment */
      }
    };
    const tick = setInterval(() => {
      if (Date.now() - waiting > SIGN_IN_WAIT_MS) {
        setWaiting(null);
        setError("The sign-in wasn't finished within 10 minutes. Try again.");
        return;
      }
      void look();
    }, SIGN_IN_POLL_MS);
    const back = () => void look();
    window.addEventListener("focus", back);
    return () => {
      alive = false;
      clearInterval(tick);
      window.removeEventListener("focus", back);
    };
  }, [waiting, adopt]);

  /** A company chosen: a model left empty, or still the other company's default, follows it. */
  const chooseCompany = (c: Company) => {
    setCompany(c);
    if (!model.trim() || Object.values(DEFAULT_MODEL).includes(model.trim())) setModel(DEFAULT_MODEL[c]);
  };

  const provider = kind === "key" ? company : kind;
  const keyStored = !!cfg && cfg.configured && cfg.provider === provider && kind !== "chatgpt";
  // Nothing set up yet: choosing a radio is not a change until something is typed.
  const configDirty =
    !!cfg &&
    ((cfg.provider === null ? model.trim() !== "" : provider !== cfg.provider) ||
      model.trim() !== (cfg.model ?? "") ||
      (kind === "openai-compatible" && baseUrl.trim() !== cfg.baseUrl) ||
      (kind !== "chatgpt" && apiKey.trim() !== ""));
  const configValid =
    kind === "chatgpt" ? connected && !!model : !!model.trim() && (keyStored || apiKey.trim().length > 0) && (kind !== "openai-compatible" || !!baseUrl.trim());
  const changedWhat = kind !== "chatgpt" && apiKey.trim() ? "the key" : provider !== (cfg?.provider ?? "") ? "the provider" : "the model";

  /** Save the provider part. A new key is checked with its provider first; a refusal throws. */
  const saveConfig = async () => {
    if (kind === "chatgpt") {
      await api("POST", "/api/admin/ai", { provider: "chatgpt", model });
      return;
    }
    if (kind === "key" && apiKey.trim()) await api("POST", "/api/admin/ai/check", { provider: company, model: model.trim(), apiKey: apiKey.trim() });
    await api("POST", "/api/admin/ai", { provider, model: model.trim(), apiKey: apiKey.trim(), baseUrl: kind === "openai-compatible" ? baseUrl.trim() : "" });
  };

  /** Sign in with ChatGPT: in the app, in the system browser while this page waits. */
  const signIn = async () => {
    setError(null);
    try {
      const app = inApp();
      const { url } = await api<{ url: string }>("POST", "/api/admin/ai/chatgpt/start", app ? { wait: true } : undefined);
      if (app) setWaiting(Date.now());
      // The app's shell opens it in the browser and the page stays; a browser tab goes there.
      window.location.assign(url);
    } catch (e) {
      setError(said(e, "Couldn't start the ChatGPT sign-in."));
    }
  };

  return {
    cfg,
    load,
    adopt,
    kind,
    setKind,
    company,
    chooseCompany,
    model,
    setModel,
    apiKey,
    setApiKey,
    replacing,
    setReplacing,
    baseUrl,
    setBaseUrl,
    planModels,
    connected,
    provider,
    keyStored,
    configDirty,
    configValid,
    changedWhat,
    saveConfig,
    signIn,
    waiting: waiting !== null,
    stopWaiting: () => setWaiting(null),
    signedIn,
    error,
    setError,
  };
}

export type AiForm = ReturnType<typeof useAiForm>;

/** What the browser sign-in says while the page waits for it. */
function Waiting({ form }: { form: AiForm }) {
  return (
    <div className="ai-wait" role="status">
      <b>Finish signing in in your browser, then come back here.</b>
      <span>Orrama moves on by itself once you're signed in.</span>
      <div className="ai-wait-acts">
        <Button size="sm" onClick={() => void form.signIn()}>
          Open the sign-in again
        </Button>
        <Button size="sm" onClick={form.stopWaiting}>
          Choose another way
        </Button>
      </div>
    </div>
  );
}

/** The two lines and the link: where a key comes from. */
function KeyGuide({ company }: { company: Company }) {
  const g = KEY_GUIDE[company];
  return (
    <p className="ai-guide">
      {g.lines[0]} {g.lines[1]}{" "}
      <a href={g.href} target="_blank" rel="noopener noreferrer">
        {g.link}
      </a>
    </p>
  );
}

/**
 * What shows under the choice, in both places: the ChatGPT sign-in (or the plan's model once
 * connected), or the key's company, guide, key and model. `place` "first" leaves the sign-in
 * button and the connected plan's controls to first run's own step.
 */
export function AiFields({ form, place, onDisconnect }: { form: AiForm; place: "first" | "settings"; onDisconnect?: () => void }) {
  const { kind, cfg } = form;
  if (!cfg) return null;
  const showKeyField = !form.keyStored || form.replacing;
  const app = inApp();
  return (
    <>
      {kind === "chatgpt" && !form.connected && (form.waiting ? (
        <Waiting form={form} />
      ) : place === "settings" ? (
        <div className="set-actions">
          <Button kind="solid" onClick={() => void form.signIn()}>
            Continue with ChatGPT
          </Button>
          <span className="set-help">
            {app ? "Opens OpenAI's sign-in in your browser. Come back here once you're signed in." : "Opens OpenAI's sign-in, then comes back here. Only on the computer Orrama runs on."}
          </span>
        </div>
      ) : null)}
      {kind === "chatgpt" && form.connected && place === "settings" && (
        <>
          <Field label="Model">
            <Select value={form.model} onChange={(e) => form.setModel(e.target.value)}>
              {!form.planModels.some((m) => m.slug === form.model) && <option value={form.model}>{form.model || "Choose a model"}</option>}
              {form.planModels.map((m) => (
                <option key={m.slug} value={m.slug}>
                  {m.name}
                </option>
              ))}
            </Select>
          </Field>
          <div className="set-actions">
            <Button size="sm" icon="ext" onClick={() => window.open(cfg.chatgpt.manageUsage, "_blank", "noopener")}>
              Manage usage
            </Button>
            <Button size="sm" danger onClick={onDisconnect}>
              Disconnect ChatGPT
            </Button>
          </div>
        </>
      )}

      {kind !== "chatgpt" && (
        <>
          <div className="set-two">
            {kind === "key" ? (
              <Field label="Company">
                <Select value={form.company} onChange={(e) => form.chooseCompany(e.target.value as Company)}>
                  {(Object.keys(COMPANY) as Company[]).map((c) => (
                    <option key={c} value={c}>
                      {COMPANY[c]}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : (
              <Field label="Address" help="The server's base URL, ending in /v1 for most.">
                <Input value={form.baseUrl} onChange={(e) => form.setBaseUrl(e.target.value)} placeholder="https://llm.example.com/v1" inputMode="url" />
              </Field>
            )}
            <Field label="Model">
              <Input value={form.model} onChange={(e) => form.setModel(e.target.value)} placeholder={kind === "key" ? DEFAULT_MODEL[form.company] : "the server's model name"} spellCheck={false} autoCapitalize="off" />
            </Field>
          </div>
          {kind === "key" && <KeyGuide company={form.company} />}
          <Field label="API key" help={kind === "key" ? `Checked with ${PROVIDER_NAME[form.company]} before it's saved, then kept encrypted where Orrama runs.` : "Kept encrypted where Orrama runs."}>
            {showKeyField ? (
              <div className="set-keyrow">
                <Input type="password" value={form.apiKey} onChange={(e) => form.setApiKey(e.target.value)} placeholder={form.keyStored ? "The new key" : "Paste your key"} autoComplete="off" />
                {form.keyStored && (
                  <Button
                    onClick={() => {
                      form.setReplacing(false);
                      form.setApiKey("");
                    }}
                  >
                    Keep the stored key
                  </Button>
                )}
              </div>
            ) : (
              <div className="set-keyrow">
                <span className="inp set-stored">A key is stored on this server</span>
                <Button onClick={() => form.setReplacing(true)}>Replace</Button>
              </div>
            )}
          </Field>
        </>
      )}
    </>
  );
}

export function AiSection({ meta }: { meta: SectionMeta }) {
  const [instructions, setInstructions] = useState("");
  const form = useAiForm({ onAdopt: (c) => setInstructions(c.instructions) });
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [ask, setAsk] = useState<ConfirmRequest | null>(null);
  const { cfg } = form;

  if (cfg === undefined)
    return (
      <section className="set-sec" aria-label={meta.label}>
        <SectionHead meta={meta} />
        <Skeleton rows={4} label="Loading Orr & AI" />
      </section>
    );
  if (cfg === null)
    return (
      <section className="set-sec" aria-label={meta.label}>
        <SectionHead meta={meta} />
        <Notice title="Couldn't load the AI settings." text="The server didn't answer. Everything else keeps working." actions={<Button size="sm" onClick={() => void form.load()}>Retry</Button>} />
      </section>
    );

  const { configDirty, configValid } = form;
  const instrDirty = instructions !== cfg.instructions;
  const changed = [configDirty && form.changedWhat, instrDirty && "the instructions"].filter(Boolean) as string[];

  const save = async () => {
    setBusy(true);
    form.setError(null);
    setSaved(null);
    try {
      if (configDirty) await form.saveConfig();
      if (instrDirty) await api("POST", "/api/admin/ai/instructions", { instructions });
      form.adopt(await api<AiConfig>("GET", "/api/admin/ai"));
      setSaved(`Saved ${changed.join(" and ")}.`);
    } catch (e) {
      form.setError(said(e, "That didn't save. Try again in a moment."));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = () =>
    setAsk({
      title: "Disconnect ChatGPT?",
      body: "Orr stops answering until you sign in with ChatGPT again or choose another provider. Signing in again works only on the computer Orrama runs on.",
      confirmLabel: "Disconnect",
      danger: true,
      onConfirm: () =>
        void api("POST", "/api/admin/ai/chatgpt/disconnect")
          .then(form.load)
          .catch((e) => form.setError(said(e, "Couldn't disconnect ChatGPT."))),
    });

  const state = cfg.configured ? (
    <StateLine
      tone="ok"
      title="Connected"
      detail={
        cfg.provider === "chatgpt"
          ? `ChatGPT plan${cfg.chatgpt.email ? ` (${cfg.chatgpt.email})` : ""} · ${cfg.model}`
          : `${PROVIDER_NAME[cfg.provider ?? ""] ?? cfg.provider} · ${cfg.model}`
      }
    />
  ) : (
    <StateLine tone="off" title="Not set up" detail="Nothing is sent anywhere until you choose a provider and save." />
  );

  return (
    <section className="set-sec" aria-label={meta.label}>
      <SectionHead
        meta={meta}
        aside={
          <div className="orrbox">
            <Orr pose="think" size={62} />
          </div>
        }
      />
      {state}

      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy && (configDirty || instrDirty) && (!configDirty || configValid)) void save();
        }}
      >
        <div className="field">
          <span className="lbl" id="ai-provider">
            Provider
          </span>
          <div className="set-opts">
            <RadioGroup<AiKind>
              label="Provider"
              value={form.kind}
              onChange={(k) => {
                form.setKind(k);
                setSaved(null);
              }}
              options={[
                { id: "chatgpt", label: "ChatGPT plan", help: "Use your Plus or Pro subscription. Sign in with ChatGPT; answers count against the plan." },
                { id: "key", label: "An API key", help: "Anthropic or Google. You pay the provider per answer." },
                { id: "openai-compatible", label: "OpenAI-compatible", help: "Your own server or a local model, by its address." },
              ]}
            />
          </div>
        </div>

        <AiFields form={form} place="settings" onDisconnect={disconnect} />

        <Field label="How Orr should work for you" help="Added to Orr's own guide, which already covers projects, tasks and the calendar, and to your notes' CLAUDE.md.">
          <Textarea rows={5} value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="e.g. Be direct and structured. Push me on deadlines." />
        </Field>

        {form.error && <Notice title="Not saved" text={form.error} />}
        <div className="set-savebar">
          <Button type="submit" kind="solid" disabled={busy || (!configDirty && !instrDirty) || (configDirty && !configValid)}>
            {busy ? "Saving…" : "Save"}
          </Button>
          <span className="set-help" role="status">
            {changed.length > 0 ? `You changed ${changed.join(" and ")}.` : saved ?? ""}
          </span>
        </div>
      </form>
      <Confirm request={ask} onClose={() => setAsk(null)} />
    </section>
  );
}
