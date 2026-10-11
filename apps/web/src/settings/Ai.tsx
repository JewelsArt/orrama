/**
 * Settings → Orr & AI (structure.md §3.1 #3), owners only (the server checks): the provider
 * (a ChatGPT plan, an API key, or an OpenAI-compatible server), the model, the key, and "How
 * Orr should work for you" (the agent's instructions). One Save for the section.
 *
 * The key is write-only: it never comes back from the server, only whether one is stored, so
 * the field shows that one is stored and Replace opens an empty field; a blank key keeps the
 * stored one. "ChatGPT plan" has no key: Continue with ChatGPT signs in on OpenAI's page and
 * comes back here (apps/server/src/chatgpt.ts), from a browser on the Mac itself.
 */
import { useCallback, useEffect, useState } from "react";
import type { AiConfig } from "@basalt/schema/responses";
import { api } from "../api.js";
import { Confirm, type ConfirmRequest } from "../Confirm.js";
import { Button } from "../ui/controls.js";
import { Field, Input, RadioGroup, Select, Textarea } from "../ui/fields.js";
import { Orr } from "../ui/orr/Orr.js";
import { Notice, Skeleton } from "../ui/states.js";
import { SectionHead, StateLine, said, type SectionMeta } from "./parts.js";

type Kind = "chatgpt" | "key" | "openai-compatible";
type Company = "anthropic" | "google";
const COMPANY: Record<Company, string> = { anthropic: "Anthropic", google: "Google (Gemini)" };
const PROVIDER_NAME: Record<string, string> = { chatgpt: "ChatGPT plan", anthropic: "Anthropic", google: "Google", "openai-compatible": "OpenAI-compatible" };

const kindOf = (p: string | null): Kind => (p === "chatgpt" ? "chatgpt" : p === "openai-compatible" ? "openai-compatible" : "key");

export function AiSection({ meta }: { meta: SectionMeta }) {
  const [cfg, setCfg] = useState<AiConfig | null | undefined>(undefined);
  const [kind, setKind] = useState<Kind>("key");
  const [company, setCompany] = useState<Company>("anthropic");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [instructions, setInstructions] = useState("");
  const [planModels, setPlanModels] = useState<{ slug: string; name: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [ask, setAsk] = useState<ConfirmRequest | null>(null);

  /** Take what the server says, and drop every unsaved edit. */
  const adopt = (c: AiConfig) => {
    setCfg(c);
    const k = c.provider ? kindOf(c.provider) : c.chatgpt.connected ? "chatgpt" : "key";
    setKind(k);
    if (c.provider === "anthropic" || c.provider === "google") setCompany(c.provider);
    setModel(c.model ?? "");
    setBaseUrl(c.baseUrl);
    setInstructions(c.instructions);
    setApiKey("");
    setReplacing(false);
  };
  const load = useCallback(async () => {
    try {
      adopt(await api<AiConfig>("GET", "/api/admin/ai"));
    } catch {
      setCfg(null);
    }
  }, []);
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
        <Notice title="Couldn't load the AI settings." text="The server didn't answer. Everything else keeps working." actions={<Button size="sm" onClick={() => void load()}>Retry</Button>} />
      </section>
    );

  const provider = kind === "key" ? company : kind;
  const keyStored = cfg.configured && cfg.provider === provider && kind !== "chatgpt";
  const showKeyField = !keyStored || replacing;
  // Nothing set up yet: choosing a radio is not a change until something is typed, so the
  // instructions can be saved on their own, as before.
  const configDirty =
    (cfg.provider === null ? model.trim() !== "" : provider !== cfg.provider) ||
    model.trim() !== (cfg.model ?? "") ||
    (kind === "openai-compatible" && baseUrl.trim() !== cfg.baseUrl) ||
    (kind !== "chatgpt" && apiKey.trim() !== "");
  const instrDirty = instructions !== cfg.instructions;
  const configValid =
    kind === "chatgpt" ? connected && !!model : !!model.trim() && (keyStored || apiKey.trim().length > 0) && (kind !== "openai-compatible" || !!baseUrl.trim());
  const changed = [
    configDirty && (kind !== "chatgpt" && apiKey.trim() ? "the key" : provider !== (cfg.provider ?? "") ? "the provider" : "the model"),
    instrDirty && "the instructions",
  ].filter(Boolean) as string[];

  const save = async () => {
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      if (configDirty) {
        if (kind === "chatgpt") await api("POST", "/api/admin/ai", { provider: "chatgpt", model });
        else await api("POST", "/api/admin/ai", { provider, model: model.trim(), apiKey: apiKey.trim(), baseUrl: kind === "openai-compatible" ? baseUrl.trim() : "" });
      }
      if (instrDirty) await api("POST", "/api/admin/ai/instructions", { instructions });
      adopt(await api<AiConfig>("GET", "/api/admin/ai"));
      setSaved(`Saved ${changed.join(" and ")}.`);
    } catch (e) {
      setError(said(e, "That didn't save. Try again in a moment."));
    } finally {
      setBusy(false);
    }
  };

  const signIn = async () => {
    setError(null);
    try {
      const { url } = await api<{ url: string }>("POST", "/api/admin/ai/chatgpt/start");
      window.location.href = url;
    } catch (e) {
      setError(said(e, "Couldn't start the ChatGPT sign-in."));
    }
  };

  const disconnect = () =>
    setAsk({
      title: "Disconnect ChatGPT?",
      body: "Orr stops answering until you sign in with ChatGPT again or choose another provider. Signing in again works only from this Mac.",
      confirmLabel: "Disconnect",
      danger: true,
      onConfirm: () =>
        void api("POST", "/api/admin/ai/chatgpt/disconnect")
          .then(load)
          .catch((e) => setError(said(e, "Couldn't disconnect ChatGPT."))),
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
            <RadioGroup<Kind>
              label="Provider"
              value={kind}
              onChange={(k) => {
                setKind(k);
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

        {kind === "chatgpt" && !connected && (
          <div className="set-actions">
            <Button kind="solid" onClick={() => void signIn()}>
              Continue with ChatGPT
            </Button>
            <span className="set-help">Opens OpenAI's sign-in, then comes back here. Only from a browser on this Mac.</span>
          </div>
        )}
        {kind === "chatgpt" && connected && (
          <>
            <Field label="Model">
              <Select value={model} onChange={(e) => setModel(e.target.value)}>
                {!planModels.some((m) => m.slug === model) && <option value={model}>{model || "Choose a model"}</option>}
                {planModels.map((m) => (
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
              <Button size="sm" danger onClick={disconnect}>
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
                  <Select value={company} onChange={(e) => setCompany(e.target.value as Company)}>
                    {(Object.keys(COMPANY) as Company[]).map((c) => (
                      <option key={c} value={c}>
                        {COMPANY[c]}
                      </option>
                    ))}
                  </Select>
                </Field>
              ) : (
                <Field label="Address" help="The server's base URL, ending in /v1 for most.">
                  <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://llm.example.com/v1" inputMode="url" />
                </Field>
              )}
              <Field label="Model">
                <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder={company === "google" && kind === "key" ? "gemini-2.5-flash" : "claude-sonnet-5"} />
              </Field>
            </div>
            <Field
              label="API key"
              help={
                <>
                  Encrypted on this Mac.{" "}
                  {kind === "key" && (
                    <a href={company === "google" ? "https://aistudio.google.com/apikey" : "https://console.anthropic.com/settings/keys"} target="_blank" rel="noopener noreferrer">
                      Where do I get one?
                    </a>
                  )}
                </>
              }
            >
              {showKeyField ? (
                <div className="set-keyrow">
                  <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={keyStored ? "The new key" : "Paste your key"} autoComplete="off" />
                  {keyStored && (
                    <Button
                      onClick={() => {
                        setReplacing(false);
                        setApiKey("");
                      }}
                    >
                      Keep the stored key
                    </Button>
                  )}
                </div>
              ) : (
                <div className="set-keyrow">
                  <span className="inp set-stored">A key is stored on this server</span>
                  <Button onClick={() => setReplacing(true)}>Replace</Button>
                </div>
              )}
            </Field>
          </>
        )}

        <Field label="How Orr should work for you" help="Added to Orr's own guide, which already covers projects, tasks and the calendar, and to your notes' CLAUDE.md.">
          <Textarea rows={5} value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="e.g. Be direct and structured. Push me on deadlines." />
        </Field>

        {error && <Notice title="Not saved" text={error} />}
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
