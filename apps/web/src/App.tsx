import { useCallback, useEffect, useState } from "react";
import { api, clearToken, type Me } from "./api.js";
import { Dashboard } from "./Dashboard.js";
import { Login } from "./Login.js";
import { Notes } from "./Notes.js";
import { QuickCapture } from "./QuickCapture.js";
import { SearchPalette } from "./SearchPalette.js";

export type View = { kind: "dashboard" } | { kind: "notes"; noteId?: string };

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [view, setView] = useState<View>({ kind: "dashboard" });
  const [theme, setTheme] = useState(localStorage.getItem("basalt-theme") ?? "command");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [captureOpen, setCaptureOpen] = useState(false);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("basalt-theme", theme);
  }, [theme]);

  useEffect(() => {
    api<Me>("GET", "/api/me")
      .then(setMe)
      .catch(() => setMe(null));
  }, []);

  const openNote = useCallback((noteId: string) => setView({ kind: "notes", noteId }), []);

  // Keyboard-first (spec §8): cmd+k palette, `c` quick capture, `g d`/`g n` nav.
  useEffect(() => {
    let pendingG = false;
    const onKey = (e: KeyboardEvent) => {
      const inField = /^(INPUT|TEXTAREA)$/.test((e.target as HTMLElement).tagName) || (e.target as HTMLElement).closest(".cm-editor");
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      if (inField || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "c") {
        e.preventDefault();
        setCaptureOpen(true);
      } else if (e.key === "g") {
        pendingG = true;
        setTimeout(() => (pendingG = false), 600);
      } else if (pendingG && e.key === "d") {
        setView({ kind: "dashboard" });
        pendingG = false;
      } else if (pendingG && e.key === "n") {
        setView({ kind: "notes" });
        pendingG = false;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (me === undefined) return <div className="boot">basalt</div>;
  if (me === null) return <Login onLogin={setMe} />;

  return (
    <div className="shell">
      <nav className="topbar">
        <span className="wordmark" aria-label="Basalt">
          <span className="wordmark-mark">⬡</span> basalt
        </span>
        <div className="topbar-nav" role="tablist">
          <button role="tab" aria-selected={view.kind === "dashboard"} className={view.kind === "dashboard" ? "active" : ""} onClick={() => setView({ kind: "dashboard" })}>
            Dashboard
          </button>
          <button role="tab" aria-selected={view.kind === "notes"} className={view.kind === "notes" ? "active" : ""} onClick={() => setView({ kind: "notes" })}>
            Notes
          </button>
        </div>
        <div className="topbar-right">
          <button className="ghost" onClick={() => setPaletteOpen(true)} title="Search (⌘K)">
            ⌘K
          </button>
          <button
            className="ghost"
            onClick={() => setTheme(theme === "command" ? "paper" : "command")}
            title="Toggle theme"
            aria-label="Toggle theme"
          >
            {theme === "command" ? "☀" : "☾"}
          </button>
          <span className="avatar" title={me.displayName}>
            {me.displayName[0]}
          </span>
          <button
            className="ghost"
            onClick={() => {
              clearToken();
              setMe(null);
            }}
          >
            Sign out
          </button>
        </div>
      </nav>
      <main className="content">
        {view.kind === "dashboard" ? <Dashboard me={me} onOpenNote={openNote} /> : <Notes me={me} noteId={view.noteId} />}
      </main>
      {paletteOpen && (
        <SearchPalette
          onClose={() => setPaletteOpen(false)}
          onPick={(id) => {
            setPaletteOpen(false);
            openNote(id);
          }}
        />
      )}
      {captureOpen && <QuickCapture onClose={() => setCaptureOpen(false)} />}
    </div>
  );
}
