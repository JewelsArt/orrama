import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, clearToken, getToken, lastEmail, SESSION_ENDED, signOut, type Me } from "./api.js";
import { Architecture } from "./Architecture.js";
import { AskPanel } from "./AskPanel.js";
import { CharacterAvatar } from "./avatars.js";
import { Contacts } from "./Contacts.js";
import { Finance } from "./Finance.js";
import { Project } from "./Project.js";
import { Dashboard } from "./Dashboard.js";
import { IconArchitecture, IconAsk, IconBack, IconContacts, IconDashboard, IconFinance, IconMail, IconMark, IconMoon, IconOverview, IconPlanning, IconRefresh, IconSearch, IconSun } from "./icons.js";
import { Lock } from "./Lock.js";
import { Login } from "./Login.js";
import { Mail } from "./Mail.js";
import { Overview } from "./Overview.js";
import { PROFILE_VAR_NAMES, customId, isCustom, profileVars, type VisionProfile } from "./palette.js";
import { Planning } from "./Planning.js";
import { QuickCapture } from "./QuickCapture.js";
import { SearchPalette } from "./SearchPalette.js";
import { Settings } from "./Settings.js";
import { Setup } from "./Setup.js";
import { readJson, readKey, writeKey } from "./storage.js";
import { canGoBack, canonical, goBack as historyBack, navigate as go, placeOf, useRoute, type MoneyPage, type Route } from "./ui/router.js";
import { disconnectWs, useLiveSync } from "./ws.js";

/** The pages inside the Finance area that are not a category or a merchant. */
export type FinancePage = MoneyPage;

export type View =
  | { kind: "dashboard" }
  | { kind: "architecture"; noteId?: string; category?: string }
  | { kind: "planning" }
  | { kind: "overview" }
  | { kind: "project"; slug: string }
  | { kind: "contacts" }
  | { kind: "finance"; category?: string; merchant?: string; page?: FinancePage; month?: string }
  | { kind: "mail" };

const NAV: { kind: View["kind"]; label: string; icon: () => React.ReactNode; ownerOnly?: boolean }[] = [
  { kind: "dashboard", label: "Dashboard", icon: IconDashboard },
  { kind: "architecture", label: "Architecture", icon: IconArchitecture },
  { kind: "planning", label: "Planning", icon: IconPlanning },
  { kind: "overview", label: "Overview", icon: IconOverview },
  { kind: "contacts", label: "Contacts", icon: IconContacts },
  { kind: "mail", label: "Mail", icon: IconMail },
  { kind: "finance", label: "Finance", icon: IconFinance },
];

/** Finance's own name for its "all spending" page, when it is opened as a category. */
const SPENDING_PAGE = "__spending";

/**
 * The old View objects, kept so the screens keep their callbacks until each moves to the
 * addresses itself: a View becomes a route (and its URL) on the way out, and the route a View
 * on the way in. `noteFor` turns a note's id into its vault path when the tree knows it.
 */
export function routeOfView(v: View, pathOf: (id: string) => string | undefined = () => undefined): Route {
  switch (v.kind) {
    case "dashboard":
      return { kind: "today" };
    case "architecture": {
      if (v.noteId) {
        const path = pathOf(v.noteId);
        return path ? { kind: "notes", path } : { kind: "notes", id: v.noteId };
      }
      return v.category ? { kind: "orrery", area: v.category } : { kind: "notes" };
    }
    case "planning":
      return { kind: "planning", scale: "week" };
    case "overview":
      return { kind: "projects" };
    case "project":
      return { kind: "project", slug: v.slug };
    case "contacts":
      return { kind: "people" };
    case "mail":
      return { kind: "mail" };
    case "finance": {
      if (v.month) return v.category && v.category !== SPENDING_PAGE ? { kind: "money", page: "spending", category: v.category, month: v.month } : { kind: "money", month: v.month };
      if (v.merchant) return { kind: "money", merchant: v.merchant };
      if (v.page) return { kind: "money", page: v.page };
      if (v.category === SPENDING_PAGE) return { kind: "money", page: "spending" };
      if (v.category) return { kind: "money", page: "spending", category: v.category };
      return { kind: "money" };
    }
  }
}

/** What the screens are shown for a route, until each reads the address itself. */
export function viewOfRoute(r: Route, idOf: (path: string) => string | undefined = () => undefined): View {
  switch (r.kind) {
    case "today":
    case "settings":
      return { kind: "dashboard" };
    case "planning":
      return { kind: "planning" };
    case "notes":
      return { kind: "architecture", noteId: r.id ?? (r.path ? idOf(r.path) : undefined) };
    case "notes-health":
    case "conversation":
    case "document":
      return { kind: "architecture" };
    case "orrery":
      return r.area ? { kind: "architecture", category: r.area } : { kind: "architecture" };
    case "projects":
      return { kind: "overview" };
    case "project":
      return { kind: "project", slug: r.slug };
    case "people":
    case "person":
    case "company":
      return { kind: "contacts" };
    case "mail":
      return { kind: "mail" };
    case "money": {
      if (r.month) return { kind: "finance", month: r.month, category: r.category };
      if (r.merchant) return { kind: "finance", merchant: r.merchant };
      if (r.category) return { kind: "finance", category: r.category };
      return r.page ? { kind: "finance", page: r.page } : { kind: "finance" };
    }
  }
}

/** A note's address is its vault path without ".md". */
const notePath = (path: string) => path.replace(/\.md$/i, "");

/**
 * Note ids and paths, both ways, from the vault tree: `/notes/<path>` needs the id the editor
 * opens, and a note opened by id gets its readable address once the path is known.
 */
function useNotePaths(signedIn: boolean) {
  const [tree, setTree] = useState<Map<string, string> | null>(null);
  useEffect(() => {
    if (!signedIn) return;
    let live = true;
    api<{ id: string; path: string }[]>("GET", "/api/vault/tree")
      .then((notes) => live && setTree(new Map(notes.map((n) => [n.id, notePath(n.path)]))))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [signedIn]);
  const byPath = useMemo(() => new Map([...(tree ?? [])].map(([id, path]) => [path, id])), [tree]);
  return {
    loaded: tree !== null,
    pathOf: useCallback((id: string) => tree?.get(id), [tree]),
    idOf: useCallback((path: string) => byPath.get(path), [byPath]),
  };
}

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  /** undefined = still asking the server; true = empty install, show Setup. */
  const [needsSetup, setNeedsSetup] = useState<boolean | undefined>(undefined);
  /** Set when the user chooses "use password instead", to skip the lock screen. */
  const [forcePassword, setForcePassword] = useState(false);
  /*
   * Where you are is the address (structure.md §1.2): reload keeps your place, and the
   * browser's Back and Forward, Android's back gesture and links all work. The page under
   * Settings is the last place you were, since Settings still opens over a page.
   */
  useState(() => canonical()); // once: `/` → `/today`, old forms written in full
  const parsed = useRoute();
  const route = useMemo<Route>(() => parsed ?? { kind: "today" }, [parsed]);
  const notes = useNotePaths(!!me);
  const [under, setUnder] = useState<Route>(route.kind === "settings" ? { kind: "today" } : route);
  useEffect(() => {
    if (route.kind !== "settings") setUnder(route);
  }, [route]);
  const shown = route.kind === "settings" ? under : route;
  const view = viewOfRoute(shown, notes.idOf);
  const settingsOpen = route.kind === "settings";
  const navigate = useCallback((next: View) => go(routeOfView(next, notes.pathOf)), [notes.pathOf]);
  const goBack = useCallback(() => {
    const p = placeOf(shown);
    historyBack(p === "money" ? { kind: "money" } : p === "projects" ? { kind: "projects" } : { kind: "today" });
  }, [shown]);
  const openSettings = useCallback(() => go({ kind: "settings" }), []);
  const closeSettings = useCallback(() => historyBack(under), [under]);
  // A note opened by its id gets its readable address as soon as the tree knows its path.
  useEffect(() => {
    if (route.kind !== "notes" || !route.id) return;
    const path = notes.pathOf(route.id);
    if (path) go({ kind: "notes", path }, { replace: true });
  }, [route, notes.pathOf]);
  // Light is the design target now; "command" is the same language inverted.
  const [theme, setTheme] = useState(() => readKey("basalt-theme") ?? "light");
  // Colour-vision mode. Orthogonal to the theme: it swaps the palette, not the
  // ground, so every combination of the two is a real, tested surface.
  const [vision, setVision] = useState(() => readKey("basalt-vision") ?? "none");
  const [profiles, setProfiles] = useState<VisionProfile[]>(() => {
    const saved = readJson<unknown>("basalt-vision-profiles", []);
    return Array.isArray(saved) ? (saved as VisionProfile[]) : [];
  });
  const [paletteOpen, setPaletteOpen] = useState(false);
  // A project workspace is opened from the board, so the rail keeps Overview lit.
  const activeKind: View["kind"] = view.kind === "project" ? "overview" : view.kind;
  const [captureOpen, setCaptureOpen] = useState(false);
  const [askOpen, setAskOpen] = useState(false);
  const [updateReady, setUpdateReady] = useState(false);

  // localStorage is the first-paint cache for the three appearance values; the
  // account (see below) is where they actually live.
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    writeKey("basalt-theme", theme);
  }, [theme]);

  useEffect(() => {
    writeKey("basalt-vision-profiles", JSON.stringify(profiles));
  }, [profiles]);

  /* Built-in modes are a CSS attribute; a hand-built one cannot be, because its
     values are not known until someone picks them. So the attribute goes on
     either way (styles keyed to "is a mode active" keep working) and a custom
     profile additionally writes its properties inline on <html>.

     Clear first, always. The pinned status colours are read AFTER the clear and
     BEFORE the new set is written, which is the only moment --ok resolves to
     what the theme and mode actually say rather than to the outgoing profile —
     miss it and each edit inherits the last one's status. */
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.vision = vision;
    writeKey("basalt-vision", vision);
    for (const name of PROFILE_VAR_NAMES) root.style.removeProperty(name);

    const profile = isCustom(vision) ? profiles.find((p) => p.id === customId(vision)) : undefined;
    if (!profile) return;
    const cs = getComputedStyle(root);
    const vars = profileVars(profile, cs.getPropertyValue("--surface").trim(), theme === "command" || theme === "dark" ? "dark" : "light", {
      ok: cs.getPropertyValue("--ok").trim(),
      warn: cs.getPropertyValue("--warn").trim(),
      danger: cs.getPropertyValue("--danger").trim(),
    });
    for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
  }, [vision, profiles, theme]);

  // Back from "Continue with ChatGPT": show where it landed, at its own address.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("ai") !== "chatgpt-connected") return;
    go({ kind: "settings", section: "ai" }, { replace: true });
  }, []);

  // The server ended this session (signed out elsewhere, or revoked in
  // Settings on another device): drop it and show the sign-in screen.
  useEffect(() => {
    const ended = () => {
      clearToken();
      disconnectWs();
      setMe(null);
      if (location.pathname.startsWith("/settings")) go({ kind: "today" }, { replace: true });
    };
    window.addEventListener(SESSION_ENDED, ended);
    return () => window.removeEventListener(SESSION_ENDED, ended);
  }, []);

  useEffect(() => {
    // Both answers are needed before anything renders: a stored token might still
    // be valid (straight into the app), and an empty install must offer Setup
    // rather than a sign-in form no one can satisfy.
    api<Me>("GET", "/api/me")
      .then(setMe)
      .catch(() => setMe(null));
    api<{ needsSetup: boolean }>("GET", "/api/auth/status")
      .then((s) => setNeedsSetup(s.needsSetup))
      .catch(() => setNeedsSetup(false));
  }, []);

  /* ---- appearance follows the account, not the browser --------------------
     The account is the truth and localStorage is a cache — in that order, and
     the order is the whole design. Reading the cache synchronously at boot is
     what stops a light flash before /api/me answers; adopting the account's copy
     when it arrives is what makes a second device show the same app.

     `serverSnapshot` is STATE, not a ref, and that is load-bearing. Hydration
     applies the account's values and records them in the same batch, so the
     write-back below only ever runs on a render where the two are consistent.
     With a ref it ran in the same effect flush as hydration, still holding the
     PRE-hydration local values — which it then dutifully pushed up, overwriting
     the account with the very values it had just been told to replace. */
  const [serverSnapshot, setServerSnapshot] = useState<string | null>(null);
  useEffect(() => {
    if (!me || serverSnapshot !== null) return;
    const a = me.appearance;
    if (!a) {
      // An account that has never stored one adopts what this browser is
      // already showing, rather than resetting a working setup to defaults.
      setServerSnapshot("");
      return;
    }
    if (a.theme) setTheme(a.theme);
    if (a.vision) setVision(a.vision);
    if (a.profiles) setProfiles(a.profiles);
    setServerSnapshot(JSON.stringify({ theme: a.theme, vision: a.vision, profiles: a.profiles }));
  }, [me, serverSnapshot]);

  useEffect(() => {
    if (!me || serverSnapshot === null) return; // not hydrated: never write first
    const next = JSON.stringify({ theme, vision, profiles });
    if (next === serverSnapshot) return;
    // Recorded on success only. A write that fails during a server restart must
    // not be remembered as synced — that is how a stale value gets resurrected
    // and pushed back up as if it were a choice.
    api<Me>("PATCH", "/api/me", { appearance: { theme, vision, profiles } })
      .then(() => setServerSnapshot(next))
      .catch(() => {});
  }, [me, serverSnapshot, theme, vision, profiles]);

  useLiveSync(me?.id, getToken);

  /**
   * Notice when the server starts serving a bundle newer than the one this tab
   * is running (i.e. someone ran `pnpm ship`), and say so on the Reload button.
   * The trigger is window focus rather than a poll or a WS message, because
   * that is exactly the shape of the workflow: ship in the terminal, click back
   * into the app. `build` is null in dev — Vite serves the bundle and there is
   * nothing on disk to digest — so there is nothing to compare and we stay
   * quiet; HMR covers that case anyway.
   */
  const bootBuild = useRef<string | null>(null);
  useEffect(() => {
    if (!me) return;
    const check = async () => {
      try {
        const h = await api<{ build: string | null }>("GET", "/api/health");
        if (!h.build) return;
        if (bootBuild.current === null) bootBuild.current = h.build;
        else if (h.build !== bootBuild.current) setUpdateReady(true);
      } catch {
        /* server restarting or offline — ask again on the next focus */
      }
    };
    void check();
    window.addEventListener("focus", check);
    return () => window.removeEventListener("focus", check);
  }, [me]);

  const openNote = useCallback((noteId: string) => navigate({ kind: "architecture", noteId }), [navigate]);

  const isLight = theme !== "command" && theme !== "dark";
  const toggleTheme = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      const next = isLight ? "command" : "light";
      const root = document.documentElement;

      // Origin is the BUTTON's centre, not the pointer. The wipe should grow out
      // of the control that caused it, and a keyboard activation reports
      // clientX/clientY of 0 — which bloomed the whole theme out of the top-left
      // corner of the window.
      const r = e.currentTarget.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      // Radius at which the circle has swallowed the viewport: the distance to
      // whichever corner is furthest from the button.
      const rEnd = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
      root.style.setProperty("--rx", `${x}px`);
      root.style.setProperty("--ry", `${y}px`);
      root.style.setProperty("--r-end", `${Math.ceil(rEnd)}px`);

      // dataset is written directly, not via React state: startViewTransition
      // captures the new state as soon as this callback returns, and a setState
      // wouldn't have flushed by then. setTheme only keeps React in step after.
      const swap = () => {
        root.dataset.theme = next;
        setTheme(next);
      };
      const start = (document as Document & { startViewTransition?: (cb: () => void) => { finished: Promise<void> } }).startViewTransition;
      if (!start || matchMedia("(prefers-reduced-motion: reduce)").matches) {
        swap();
        return;
      }
      root.classList.add("rippling");
      start.call(document, swap).finished.finally(() => root.classList.remove("rippling"));
    },
    [isLight],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.closest(".cm-editor");
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      // The Tauri window defines no menu, so ⌘R has no accelerator bound to it
      // there and picking up a new build meant quitting and reopening the app.
      // Handling it here gives the desktop shell the shortcut every browser
      // already has; in a real browser the native binding fires first and this
      // is simply never reached.
      // ⌘[ and ⌘← — the two bindings every macOS app answers to for "back".
      if ((e.metaKey || e.ctrlKey) && (e.key === "[" || e.key === "ArrowLeft")) {
        e.preventDefault();
        goBack();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "r") {
        e.preventDefault();
        location.reload();
        return;
      }
      if (inField || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "c") {
        e.preventDefault();
        setCaptureOpen(true);
      } else if (e.key === "1") navigate({ kind: "dashboard" });
      else if (e.key === "2") navigate({ kind: "architecture" });
      else if (e.key === "3") navigate({ kind: "planning" });
      else if (e.key === "4") navigate({ kind: "overview" });
      else if (e.key === "5") navigate({ kind: "contacts" });
      else if (e.key === "6") navigate({ kind: "mail" });
      else if (e.key === "7") navigate({ kind: "finance" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate, goBack]);

  if (me === undefined || needsSetup === undefined) return <div className="boot">basalt</div>;
  if (me === null && needsSetup) return <Setup onDone={setMe} />;
  // A device that has signed in before gets the quick-unlock screen; it offers
  // "use password instead", which is also the only way out of a passcode lockout.
  if (me === null && !forcePassword && lastEmail()) {
    return <Lock onUnlock={setMe} onUsePassword={() => setForcePassword(true)} />;
  }
  if (me === null) return <Login onLogin={setMe} />;

  const firstTeam = me.teams[0];

  return (
    <div className="shell">
      <nav className="rail" aria-label="Main">
        <div className="rail-brand">
          <IconMark size={26} />
          <span>basalt</span>
        </div>

        <button
          className="rail-item rail-back"
          onClick={goBack}
          disabled={!canGoBack()}
          title={canGoBack() ? "Back" : "Nothing to go back to"}
          aria-label={canGoBack() ? "Back" : "Back (nothing to go back to)"}
        >
          <IconBack />
          <span>Back</span>
          <kbd className="rail-kbd">⌘[</kbd>
        </button>

        <div className="rail-nav" role="tablist" aria-orientation="vertical">
          {NAV.filter((n) => !n.ownerOnly || me.isOwner).map((n, i) => (
            <button
              key={n.kind}
              role="tab"
              aria-selected={activeKind === n.kind}
              className={`rail-item ${activeKind === n.kind ? "active" : ""}`}
              onClick={() => navigate({ kind: n.kind } as View)}
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
          <button
            className={`rail-item ${updateReady ? "has-update" : ""}`}
            onClick={() => location.reload()}
            aria-label={updateReady ? "A new build is available. Reload" : "Reload the app"}
          >
            <IconRefresh />
            <span>{updateReady ? "Update ready" : "Reload"}</span>
            <kbd className="rail-kbd">⌘R</kbd>
          </button>
          <button className="rail-item theme-toggle" onClick={toggleTheme} aria-label={isLight ? "Switch to dark" : "Switch to light"}>
            {/* Wrapped so it carries its own view-transition-name: the sun and
                the moon are the "old" and "new" snapshots of this one box, which
                is what lets them turn into each other. */}
            <span className="theme-ic">{isLight ? <IconMoon /> : <IconSun />}</span>
            <span>{isLight ? "Dark" : "Light"}</span>
          </button>
        </div>

        <div className="rail-spacer" />

        <button
          className="account"
          onClick={openSettings}
          aria-haspopup="dialog"
          aria-label={`Account: ${me.displayName}. Open settings`}
        >
          <CharacterAvatar id={me.avatar} size={32} />
          <span className="account-text">
            <span className="account-name">{me.displayName}</span>
            <span className="account-team">your vault</span>
          </span>
        </button>
      </nav>

      <main className="content">
        {view.kind === "dashboard" ? (
          <Dashboard
            me={me}
            onOpenNote={openNote}
            onOpenProject={(slug) => navigate({ kind: "project", slug })}
            onOpenOverview={() => navigate({ kind: "overview" })}
            onOpenPlanning={() => navigate({ kind: "planning" })}
            onOpenCategory={(category) => navigate({ kind: "architecture", category })}
            onOpenFinance={(to) => navigate({ kind: "finance", ...to })}
            onOpenSettings={openSettings}
          />
        ) : view.kind === "architecture" ? (
          <Architecture me={me} noteId={view.noteId} category={view.category} />
        ) : view.kind === "planning" ? (
          <Planning me={me} onOpenNote={openNote} onOpenProject={(slug) => navigate({ kind: "project", slug })} />
        ) : view.kind === "overview" ? (
          <Overview me={me} onOpenNote={openNote} onOpenProject={(slug) => navigate({ kind: "project", slug })} />
        ) : view.kind === "project" ? (
          <Project me={me} slug={view.slug} onBack={goBack} onOpenNote={openNote} />
        ) : view.kind === "contacts" ? (
          <Contacts me={me} onOpenNote={openNote} />
        ) : view.kind === "mail" ? (
          <Mail me={me} />
        ) : (
          <Finance
            onOpenNote={openNote}
            category={view.category}
            merchant={view.merchant}
            page={view.page}
            month={view.month}
            onOpenCategory={(c) => navigate({ kind: "finance", category: c })}
            onOpenMerchant={(m) => navigate({ kind: "finance", merchant: m })}
            onOpenPage={(pg) => navigate({ kind: "finance", page: pg })}
            onOpenMonth={(m, c) => navigate({ kind: "finance", month: m, category: c })}
            onBack={goBack}
          />
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
          vision={vision}
          onVision={setVision}
          profiles={profiles}
          onProfiles={setProfiles}
          onUpdate={setMe}
          onClose={closeSettings}
          onSignOut={() => {
            disconnectWs();
            void signOut();
            setMe(null);
            go({ kind: "today" }, { replace: true });
          }}
        />
      )}
    </div>
  );
}
