import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { api, getToken } from "./api.js";
import { IconAsk, IconX } from "./icons.js";
import { Markdown } from "./ask/Answer.js";
import { citedNote, contextNoteOf, EMPTY_VAULT, noteRoute, type Vault } from "./ask/targets.js";
import type { LinkRef } from "./notes/links.js";
import { navigate, routeHref, useRoute, type Route } from "./ui/router.js";

/**
 * The notes Orr's tools returned in this conversation, by title and by path: a citation names
 * the note he read before any other note of that name (targets.ts).
 */
function seenNotes(messages: UIMessage[]): LinkRef[] {
  const out: LinkRef[] = [];
  const visit = (v: unknown, depth: number) => {
    if (!v || typeof v !== "object" || depth > 5) return;
    if (Array.isArray(v)) return v.forEach((x) => visit(x, depth + 1));
    const o = v as Record<string, unknown>;
    if (typeof o.id === "string" && typeof o.title === "string") out.push({ target: o.title, targetId: o.id });
    if (typeof o.id === "string" && typeof o.path === "string") out.push({ target: o.path.replace(/\.md$/i, ""), targetId: o.id });
    for (const x of Object.values(o)) visit(x, depth + 1);
  };
  for (const m of messages) for (const p of m.parts) if ("output" in p && p.state === "output-available") visit(p.output, 0);
  return out;
}

/** A link the app follows itself, leaving the panel open; a ⌘-click still opens a new tab. */
const follow = (to: Route) => (e: MouseEvent) => {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  navigate(to);
};

/** Ask your vault (spec §9.1): answers grounded in readable notes, with citations. */
export function AskPanel({ onClose }: { onClose: () => void; onOpenNote?: (id: string) => void }) {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [vault, setVault] = useState<Vault>(EMPTY_VAULT);
  const [input, setInput] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const route = useRoute();

  // Whether Orr has a model, and the vault the names lead into: asked together, so a question
  // is never sent before the panel knows which note the page is about. A vault that does not
  // load leaves the citations as text; it never stops a question.
  useEffect(() => {
    let live = true;
    void Promise.allSettled([
      api<{ configured: boolean }>("GET", "/api/ai/status"),
      api<Vault["tree"]>("GET", "/api/vault/tree"),
      api<Vault["projects"]>("GET", "/api/projects"),
    ]).then(([status, tree, projects]) => {
      if (!live) return;
      setVault({ tree: tree.status === "fulfilled" ? tree.value : [], projects: projects.status === "fulfilled" ? projects.value : [] });
      setConfigured(status.status === "fulfilled" && status.value.configured);
    });
    return () => {
      live = false;
    };
  }, []);

  // The note the page is about goes with each question (AI-012); read when the question is sent.
  const context = useRef<string | undefined>(undefined);
  context.current = route ? contextNoteOf(route, vault) : undefined;

  // AI SDK v5+: we own the input state; the transport carries the endpoint, auth and the note.
  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/ai/ask",
        headers: () => ({ Authorization: `Bearer ${getToken()}` }),
        body: () => (context.current ? { contextNoteId: context.current } : {}),
      }),
    [],
  );
  const { messages, sendMessage, status, error, stop } = useChat({ transport });
  const busy = status === "submitted" || status === "streaming";
  const seen = useMemo(() => seenNotes(messages), [messages]);
  /** A citation: a link to its note's page when the note is known, its words when it is not. */
  const cite = (target: string, label: string) => {
    const id = citedNote(target, seen, vault);
    if (!id) return <span className="cite-none">{label}</span>;
    const to = noteRoute(id, vault);
    return (
      <a className="cite" href={routeHref(to)} onClick={follow(to)}>
        {label}
      </a>
    );
  };
  // Closing the panel ends the run (AI-006): the request closes, and the server stops the model
  // and every tool call after it. A ref, so a new `stop` on a later render never ends it early.
  const stopRun = useRef(stop);
  stopRun.current = stop;
  useEffect(
    () => () => {
      void stopRun.current();
    },
    [],
  );

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [messages]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    void sendMessage({ text });
    setInput("");
  };

  return (
    <aside className="ask-panel" aria-label="Ask your vault">
      <header className="ask-head">
        <span className="ask-title">
          <IconAsk /> Ask your vault
        </span>
        <button className="ghost" onClick={onClose} aria-label="Close">
          <IconX />
        </button>
      </header>
      {configured === false && (
        <p className="ask-off">
          AI isn't configured. A workspace owner can add a provider key under <strong>Settings → AI</strong>. Your notes never
          leave your server until then.
        </p>
      )}
      <div className="ask-scroll" ref={scroller}>
        {messages.length === 0 && configured && (
          <p className="ask-hint">
            Answers cite [[notes]] and only ever search notes you can read. The agent can also create projects, tasks,
            deadlines and calendar events.
          </p>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`ask-turn ${m.role}`}>
            {m.parts.map((part, i) => {
              if (part.type === "text")
                return part.text ? (
                  m.role === "assistant" ? (
                    <div key={i} className="ask-md">
                      <Markdown text={part.text} cite={cite} />
                    </div>
                  ) : (
                    <p key={i}>{part.text}</p>
                  )
                ) : null;
              if (part.type === "dynamic-tool" || part.type.startsWith("tool-")) {
                const name = part.type === "dynamic-tool" ? part.toolName : part.type.slice("tool-".length);
                const done = "state" in part && part.state === "output-available";
                return (
                  <div key={i} className="ask-tool" style={{ fontSize: "0.85em", color: "var(--text-dim)", marginTop: 4 }}>
                    {done ? `✓ ${name}` : `⚙ ${name}…`}
                  </div>
                );
              }
              return null;
            })}
          </div>
        ))}
        {status === "submitted" && (
          <div className="ask-turn assistant">
            <p className="ask-thinking">thinking…</p>
          </div>
        )}
        {error && (
          <div className="ask-error" role="alert">
            <strong>Something went wrong.</strong>
            <span>{error.message || "The model request failed."}</span>
            <span className="ask-error-hint">Check the model name and API key under Settings → AI, then try again.</span>
          </div>
        )}
      </div>
      <form className="ask-input" onSubmit={submit}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={configured ? "Ask or instruct your agent…" : "AI not configured"}
          disabled={!configured || busy}
          aria-label="Question"
        />
        {busy && (
          <button type="button" className="ghost" onClick={() => void stop()}>
            Stop
          </button>
        )}
      </form>
    </aside>
  );
}
