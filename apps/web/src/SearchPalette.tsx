import { useEffect, useRef, useState } from "react";
import { api } from "./api.js";

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
    const t = setTimeout(async () => {
      const res = await api<Hit[]>("GET", `/api/vault/search?q=${encodeURIComponent(q)}`);
      setHits(res);
      setSel(0);
    }, 120);
    return () => clearTimeout(t);
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
