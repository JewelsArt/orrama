import { useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { api } from "./api.js";
import { IconAsk, IconX } from "./icons.js";

/** Ask your vault (spec §9.1): answers grounded in readable notes, with citations. */
export function AskPanel({ onClose }: { onClose: () => void; onOpenNote: (id: string) => void }) {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [input, setInput] = useState("");
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api<{ configured: boolean }>("GET", "/api/ai/status").then((s) => setConfigured(s.configured));
  }, []);

  // AI SDK v5+: we own the input state; the transport carries the endpoint + auth.
  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/ai/ask",
        headers: { Authorization: `Bearer ${localStorage.getItem("basalt-token") ?? ""}` },
      }),
    [],
  );
  const { messages, sendMessage, status, error } = useChat({ transport });
  const busy = status === "submitted" || status === "streaming";

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
              if (part.type === "text") return part.text ? <p key={i}>{part.text}</p> : null;
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
      </form>
    </aside>
  );
}
