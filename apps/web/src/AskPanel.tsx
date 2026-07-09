import { useEffect, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { api } from "./api.js";
import { IconAsk, IconX } from "./icons.js";

/** Ask your vault (spec §9.1): answers grounded in readable notes, with citations. */
export function AskPanel({ onClose, onOpenNote }: { onClose: () => void; onOpenNote: (id: string) => void }) {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api<{ configured: boolean }>("GET", "/api/ai/status").then((s) => setConfigured(s.configured));
  }, []);

  const { messages, input, handleInputChange, handleSubmit, isLoading } = useChat({
    api: "/api/ai/ask",
    headers: { Authorization: `Bearer ${localStorage.getItem("basalt-token")}` },
  });

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [messages]);

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
          AI isn't configured. A workspace owner can add a provider key under <strong>Admin → AI</strong>. Your notes never
          leave your server until then.
        </p>
      )}
      <div className="ask-scroll" ref={scroller}>
        {messages.length === 0 && configured && (
          <p className="ask-hint">Answers cite [[notes]] and only ever search notes you can read. The AI can also create and edit projects and notes.</p>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`ask-turn ${m.role}`}>
            {m.content && <p>{m.content}</p>}
            {m.toolInvocations?.map(t => (
              <div key={t.toolCallId} className="ask-tool" style={{ fontSize: "0.85em", color: "var(--text-dim)", marginTop: 4 }}>
                {t.state === 'result' ? `✓ Executed ${t.toolName}` : `⚙ Executing ${t.toolName}…`}
              </div>
            ))}
          </div>
        ))}
        {isLoading && messages[messages.length - 1]?.role !== 'assistant' && (
          <div className="ask-turn assistant"><p className="ask-thinking">thinking…</p></div>
        )}
      </div>
      <form className="ask-input" onSubmit={handleSubmit}>
        <input
          value={input}
          onChange={handleInputChange}
          placeholder={configured ? "Ask or instruct your agent…" : "AI not configured"}
          disabled={!configured || isLoading}
          aria-label="Question"
        />
      </form>
    </aside>
  );
}
