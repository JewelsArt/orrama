import { useEffect, useRef, useState } from "react";
import { api, unlessAborted } from "./api.js";

interface Hit {
  id: string;
  path: string;
  title: string;
}

/** ⌘K palette: fuzzy full-vault search with tag:/path:/task:/assignee: filters (spec §8). */
export function SearchPalette({ onClose, onPick }: { onClose: () => void; onPick: (noteId: string) => void }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [sel, setSel] = useState(0);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => ref.current?.focus(), []);

  useEffect(() => {
    // The debounce drops keystrokes not yet sent; the abort drops a search
    // already sent, so "ab"'s results cannot land after "abc"'s.
    const ac = new AbortController();
    const t = setTimeout(() => {
      api<Hit[]>("GET", `/api/vault/search?q=${encodeURIComponent(q)}`, undefined, { signal: ac.signal }).then((res) => {
        setHits(res);
        setSel(0);
      }, unlessAborted);
    }, 120);
    return () => {
      clearTimeout(t);
      ac.abort();
    };
  }, [q]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onClose();
    else if (e.key === "ArrowDown") setSel((s) => Math.min(s + 1, hits.length - 1));
    else if (e.key === "ArrowUp") setSel((s) => Math.max(s - 1, 0));
    else if (e.key === "Enter" && hits[sel]) onPick(hits[sel].id);
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="palette" onClick={(e) => e.stopPropagation()} onKeyDown={onKey}>
        <input
          ref={ref}
          placeholder="Search notes…  (try tag:project  path:eng  assignee:erin)"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Search"
        />
        <ul role="listbox">
          {hits.map((h, i) => (
            <li key={h.id} role="option" aria-selected={i === sel} className={i === sel ? "sel" : ""} onMouseEnter={() => setSel(i)} onClick={() => onPick(h.id)}>
              <span className="hit-title">{h.title}</span>
              <span className="hit-path">{h.path}</span>
            </li>
          ))}
          {hits.length === 0 && <li className="empty">No matches</li>}
        </ul>
      </div>
    </div>
  );
}
