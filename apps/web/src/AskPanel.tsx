import { useEffect, useRef, useState } from "react";
import { api } from "./api.js";

interface Turn {
  role: "user" | "assistant";
  text: string;
  sources?: { id: string; title: string }[];
}

/** Ask your vault (spec §9.1): answers grounded in readable notes, with citations. */
export function AskPanel({ onClose, onOpenNote }: { onClose: () => void; onOpenNote: (id: string) => void }) {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api<{ configured: boolean }>("GET", "/api/ai/status").then((s) => setConfigured(s.configured));
  }, []);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [turns]);

  const ask = async (e: React.FormEvent) => {
    e.preventDefault();
    const question = q.trim();
    if (!question || busy) return;
    setQ("");
    setTurns((t) => [...t, { role: "user", text: question }]);
    setBusy(true);
    try {
      const res = await api<{ answer: string; sources: { id: string; title: string }[] }>("POST", "/api/ai/ask", { question });
      setTurns((t) => [...t, { role: "assistant", text: res.answer, sources: res.sources }]);
    } catch (err) {
      setTurns((t) => [...t, { role: "assistant", text: `⚠ ${err instanceof Error ? err.message : "failed"}` }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="ask-panel" aria-label="Ask your vault">
      <header className="ask-head">
        <span>✦ Ask your vault</span>
        <button className="ghost" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </header>
      {configured === false && (
        <p className="ask-off">
          AI isn't configured. A workspace owner can add a provider key under <strong>Admin → AI</strong>. Your notes never
          leave your server until then.
        </p>
      )}
      <div className="ask-scroll" ref={scroller}>
        {turns.length === 0 && configured && (
          <p className="ask-hint">Answers cite [[notes]] and only ever search notes you can read.</p>
        )}
        {turns.map((t, i) => (
          <div key={i} className={`ask-turn ${t.role}`}>
            <p>{t.text}</p>
            {t.sources && t.sources.length > 0 && (
              <div className="ask-sources">
                {t.sources.map((s) => (
                  <button key={s.id} className="ghost" onClick={() => onOpenNote(s.id)}>
                    [[{s.title}]]
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
        {busy && <div className="ask-turn assistant"><p className="ask-thinking">thinking…</p></div>}
      </div>
      <form className="ask-input" onSubmit={ask}>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={configured ? "Ask about your team's notes…" : "AI not configured"}
          disabled={!configured}
          aria-label="Question"
        />
      </form>
    </aside>
  );
}
