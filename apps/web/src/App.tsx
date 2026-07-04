import { useCallback, useEffect, useState } from "react";
import { Admin } from "./Admin.js";
import { api, clearToken, type Me } from "./api.js";
import { Architecture } from "./Architecture.js";
import { AskPanel } from "./AskPanel.js";
import { CharacterAvatar } from "./avatars.js";
import { Contacts } from "./Contacts.js";
import { Dashboard } from "./Dashboard.js";
import { IconAdmin, IconArchitecture, IconAsk, IconContacts, IconDashboard, IconMark, IconOverview, IconPlanning, IconSearch } from "./icons.js";
import { Login } from "./Login.js";
import { Overview } from "./Overview.js";
import { Planning } from "./Planning.js";
import { QuickCapture } from "./QuickCapture.js";
import { SearchPalette } from "./SearchPalette.js";
import { Settings } from "./Settings.js";
import { connectWs, disconnectWs } from "./ws.js";

export type View =
  | { kind: "dashboard" }
  | { kind: "architecture"; noteId?: string }
  | { kind: "planning" }
  | { kind: "overview" }
  | { kind: "contacts" }
  | { kind: "admin" };

const NAV: { kind: View["kind"]; label: string; icon: () => React.ReactNode; ownerOnly?: boolean }[] = [
  { kind: "dashboard", label: "Dashboard", icon: IconDashboard },
  { kind: "architecture", label: "Architecture", icon: IconArchitecture },
  { kind: "planning", label: "Planning", icon: IconPlanning },
  { kind: "overview", label: "Overview", icon: IconOverview },
  { kind: "contacts", label: "Contacts", icon: IconContacts },
  { kind: "admin", label: "Admin", icon: IconAdmin, ownerOnly: true },
];

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [view, setView] = useState<View>({ kind: "dashboard" });
  const [theme, setTheme] = useState(localStorage.getItem("basalt-theme") ?? "command");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [askOpen, setAskOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("basalt-theme", theme);
  }, [theme]);

  useEffect(() => {
    api<Me>("GET", "/api/me")
      .then(setMe)
      .catch(() => setMe(null));
  }, []);

  useEffect(() => {
    if (me) connectWs(localStorage.getItem("basalt-token") ?? "");
    return () => disconnectWs();
  }, [me]);

  const openNote = useCallback((noteId: string) => setView({ kind: "architecture", noteId }), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.closest(".cm-editor");
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      if (inField || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "c") {
        e.preventDefault();
        setCaptureOpen(true);
      } else if (e.key === "1") setView({ kind: "dashboard" });
      else if (e.key === "2") setView({ kind: "architecture" });
      else if (e.key === "3") setView({ kind: "planning" });
      else if (e.key === "4") setView({ kind: "overview" });
      else if (e.key === "5") setView({ kind: "contacts" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (me === undefined) return <div className="boot">basalt</div>;
  if (me === null) return <Login onLogin={setMe} />;

  const firstTeam = me.teams[0];

  return (
    <div className="shell">
      <nav className="rail" aria-label="Main">
        <div className="rail-brand">
          <IconMark size={20} />
          <span>basalt</span>
        </div>

        <div className="rail-nav" role="tablist" aria-orientation="vertical">
          {NAV.filter((n) => !n.ownerOnly || me.isOwner).map((n, i) => (
            <button
              key={n.kind}
              role="tab"
              aria-selected={view.kind === n.kind}
              className={`rail-item ${view.kind === n.kind ? "active" : ""}`}
              onClick={() => setView({ kind: n.kind } as View)}
            >
              <n.icon />
              <span>{n.label}</span>
              {!n.ownerOnly && <kbd className="rail-kbd">{i + 1}</kbd>}
            </button>
          ))}
        </div>

        <div className="rail-tools">
          <button className="rail-item" onClick={() => setPaletteOpen(true)}>
            <IconSearch />
            <span>Search</span>
            <kbd className="rail-kbd">⌘K</kbd>
          </button>
          <button className="rail-item" onClick={() => setAskOpen((v) => !v)}>
            <IconAsk />
            <span>Ask vault</span>
          </button>
        </div>

        <div className="rail-spacer" />

        <button
          className="account"
          onClick={() => setSettingsOpen(true)}
          aria-haspopup="dialog"
          aria-label={`Account: ${me.displayName}. Open settings`}
        >
          <CharacterAvatar id={me.avatar} size={32} />
          <span className="account-text">
            <span className="account-name">{me.displayName}</span>
            <span className="account-team">{firstTeam ? firstTeam.name : me.isOwner ? "Workspace owner" : "No team yet"}</span>
          </span>
        </button>
      </nav>

      <main className="content">
        {view.kind === "dashboard" ? (
          <Dashboard me={me} onOpenNote={openNote} />
        ) : view.kind === "architecture" ? (
          <Architecture me={me} noteId={view.noteId} />
        ) : view.kind === "planning" ? (
          <Planning me={me} onOpenNote={openNote} />
        ) : view.kind === "overview" ? (
          <Overview me={me} onOpenNote={openNote} />
        ) : view.kind === "contacts" ? (
          <Contacts me={me} onOpenNote={openNote} />
        ) : (
          <Admin />
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
      {settingsOpen && (
        <Settings
          me={me}
          theme={theme}
          onTheme={setTheme}
          onUpdate={setMe}
          onClose={() => setSettingsOpen(false)}
          onSignOut={() => {
            clearToken();
            disconnectWs();
            setMe(null);
            setSettingsOpen(false);
          }}
        />
      )}
    </div>
  );
}
