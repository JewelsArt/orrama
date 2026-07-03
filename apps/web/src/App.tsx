import { useCallback, useEffect, useState } from "react";
import { Admin } from "./Admin.js";
import { api, clearToken, type Me } from "./api.js";
import { AskPanel } from "./AskPanel.js";
import { Dashboard } from "./Dashboard.js";
import { Login } from "./Login.js";
import { Notes } from "./Notes.js";
import { QuickCapture } from "./QuickCapture.js";
import { SearchPalette } from "./SearchPalette.js";
import { connectWs, disconnectWs } from "./ws.js";

export type View = { kind: "dashboard" } | { kind: "notes"; noteId?: string } | { kind: "admin" };

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [view, setView] = useState<View>({ kind: "dashboard" });
  const [theme, setTheme] = useState(localStorage.getItem("basalt-theme") ?? "command");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [askOpen, setAskOpen] = useState(false);

  // Live sync: one socket for the whole session.
  useEffect(() => {
    if (me) connectWs(localStorage.getItem("basalt-token") ?? "");
    return () => disconnectWs();
  }, [me]);

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
          {me.isOwner && (
            <button role="tab" aria-selected={view.kind === "admin"} className={view.kind === "admin" ? "active" : ""} onClick={() => setView({ kind: "admin" })}>
              Admin
            </button>
          )}
        </div>
        <div className="topbar-right">
          <button className="ghost" onClick={() => setAskOpen((v) => !v)} title="Ask your vault">
            ✦ Ask
          </button>
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
        {view.kind === "dashboard" ? (
          <Dashboard me={me} onOpenNote={openNote} />
        ) : view.kind === "admin" ? (
          <Admin />
        ) : (
          <Notes me={me} noteId={view.noteId} />
        )}
      </main>
      {askOpen && <AskPanel onClose={() => setAskOpen(false)} onOpenNote={openNote} />}
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
