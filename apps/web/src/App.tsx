import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, clearToken, getToken, lastEmail, SESSION_ENDED, signOut, type Me } from "./api.js";
import { Architecture } from "./Architecture.js";
import { AskPanel } from "./AskPanel.js";
import { Contacts } from "./Contacts.js";
import { Finance } from "./Finance.js";
import { Project } from "./Project.js";
import { Dashboard } from "./Dashboard.js";
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
import { readJson, readKey, removeKey, writeKey } from "./storage.js";
import { OrramaMark } from "./ui/orr/logo.js";
import { isTyping, shellKey } from "./ui/keys.js";
import { anyLayerOpen, Layer } from "./ui/overlays.js";
import { canonical, goBack as historyBack, navigate as go, placeOf, placeRoute, PLACES, routeHref, useRoute, type MoneyPage, type Route } from "./ui/router.js";
import { KeysSheet } from "./ui/shell/KeysSheet.js";
import { ErrorBoundary } from "./ui/ErrorBoundary.js";
import { Shell } from "./ui/shell/Shell.js";
import { accountTheme, DEVICE_KEY, resolveTheme, shownOf, systemIsDark, THEME_KEY, useSystemDark } from "./ui/theme.js";
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

/** A slug or a file name, said as words: "graduation-thesis" → "Graduation thesis". */
const words = (s: string) => {
  const w = s.split("/").pop()!.replace(/[-_]+/g, " ").trim();
  return w.charAt(0).toUpperCase() + w.slice(1);
};
const MONEY_TITLES: Record<MoneyPage, string> = { spending: "Spending", documents: "Documents", subscriptions: "Subscriptions", income: "Income", savings: "Saving" };

/**
 * The page's title for the phone's top bar and the window: the place, or for a page inside
 * one, what the address names. A screen with a better name (a project's real title) gives it
 * in its wave.
 */
export function titleOf(r: Route): string {
  switch (r.kind) {
    case "notes":
      return r.path ? words(r.path) : "Notes";
    case "notes-health":
      return "Orr noticed";
    case "project":
    case "person":
    case "company":
    case "conversation":
      return words(r.slug);
    case "document":
      return r.path.split("/").pop()!;
    case "mail":
      return r.waiting ? "Waiting for you" : "Mail";
    case "money":
      return r.merchant ?? r.category ?? (r.page ? MONEY_TITLES[r.page] : "Money");
    case "settings":
      return "Settings";
    default:
      return PLACES.find((p) => p.place === placeOf(r))?.label ?? "Orrama";
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
  // The account's theme ("light" or "command"), and whether this device follows its system
  // instead: Match this device (ui/theme.ts). The page shows what the two resolve to.
  const [theme, setTheme] = useState(() => readKey(THEME_KEY) ?? "light");
  const [matchDevice, setMatchDevice] = useState(() => readKey(DEVICE_KEY) === "match");
  const systemDark = useSystemDark();
  const themeShown = resolveTheme(theme, matchDevice, systemDark);
  // Colour-vision mode. Orthogonal to the theme: it swaps the palette, not the
  // ground, so every combination of the two is a real, tested surface.
  const [vision, setVision] = useState(() => readKey("basalt-vision") ?? "none");
  const [profiles, setProfiles] = useState<VisionProfile[]>(() => {
    const saved = readJson<unknown>("basalt-vision-profiles", []);
    return Array.isArray(saved) ? (saved as VisionProfile[]) : [];
  });
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [askOpen, setAskOpen] = useState(false);
  const [updateReady, setUpdateReady] = useState(false);

  // localStorage is the first-paint cache for the three appearance values; the
  // account (see below) is where they actually live. public/boot-theme.js reads the theme
  // keys before the first frame of the next load (WEB-019); a change is on <html> before
  // the browser paints it.
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = themeShown;
  }, [themeShown]);
  useEffect(() => writeKey(THEME_KEY, theme), [theme]);
  useEffect(() => (matchDevice ? writeKey(DEVICE_KEY, "match") : removeKey(DEVICE_KEY)), [matchDevice]);

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
    const vars = profileVars(profile, cs.getPropertyValue("--surface").trim(), themeShown, {
      ok: cs.getPropertyValue("--ok").trim(),
      warn: cs.getPropertyValue("--warn").trim(),
      danger: cs.getPropertyValue("--danger").trim(),
    });
    for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
  }, [vision, profiles, themeShown]);

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

  /*
   * A theme change, with the circular wipe (it left the rail with the Dark button, §8 #4, and
   * stays for Settings → Appearance and ⌘K). It grows out of the control that asked for it:
   * the focused element, which is the button just clicked or pressed.
   *
   * `choice` is "light", "dark" ("command" is the account's word for it) or "match": this
   * device follows its system from now on, and the account keeps its theme for the others.
   */
  const changeTheme = useCallback(
    (choice: string) => {
      const root = document.documentElement;
      const match = choice === "match";
      const next = match ? (systemIsDark() ? "dark" : "light") : shownOf(choice);
      // dataset is written directly, not via React state: startViewTransition
      // captures the new state as soon as this callback returns, and a setState
      // wouldn't have flushed by then. The state only keeps React in step after.
      const swap = () => {
        root.dataset.theme = next;
        setMatchDevice(match);
        if (!match) setTheme(accountTheme(next));
      };
      if (next === root.dataset.theme) return swap();

      // Origin is the CONTROL's centre, not the pointer: a keyboard activation reports
      // clientX/clientY of 0, which bloomed the whole theme out of the top-left corner.
      const at = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
      const r = at?.getBoundingClientRect() ?? new DOMRect(innerWidth / 2, innerHeight / 2, 0, 0);
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      // Radius at which the circle has swallowed the viewport: the distance to
      // whichever corner is furthest from the button.
      const rEnd = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
      root.style.setProperty("--rx", `${x}px`);
      root.style.setProperty("--ry", `${y}px`);
      root.style.setProperty("--r-end", `${Math.ceil(rEnd)}px`);

      const start = (document as Document & { startViewTransition?: (cb: () => void) => { finished: Promise<void> } }).startViewTransition;
      if (!start || matchMedia("(prefers-reduced-motion: reduce)").matches) {
        swap();
        return;
      }
      root.classList.add("rippling");
      start.call(document, swap).finished.finally(() => root.classList.remove("rippling"));
    },
    [],
  );

  /* The keys (structure.md §1.5), decided by shellKey (ui/keys.ts). ⌘R is main.tsx's,
     outside React, so it still reloads when a view has crashed (WEB-011). */
  const [keysOpen, setKeysOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = shellKey(e, isTyping(e.target), anyLayerOpen());
      if (!action) return;
      e.preventDefault();
      if (action.kind === "place") go(placeRoute(action.place));
      else if (action.kind === "find") setPaletteOpen((v) => !v);
      else if (action.kind === "ask") setAskOpen((v) => !v);
      else if (action.kind === "capture") setCaptureOpen(true);
      else if (action.kind === "settings") go({ kind: "settings" });
      else if (action.kind === "back") goBack();
      else if (action.kind === "keys") setKeysOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goBack]);

  if (me === undefined || needsSetup === undefined)
    return (
      <div className="boot">
        <OrramaMark height={44} title="Orrama" />
      </div>
    );
  if (me === null && needsSetup) return <Setup onDone={setMe} />;
  // A device that has signed in before gets the quick-unlock screen; it offers
  // "use password instead", which is also the only way out of a passcode lockout.
  if (me === null && !forcePassword && lastEmail()) {
    return <Lock onUnlock={setMe} onUsePassword={() => setForcePassword(true)} />;
  }
  if (me === null) return <Login onLogin={setMe} />;

  return (
    <Shell
      route={route}
      title={titleOf(route)}
      me={me}
      updateReady={updateReady}
      askOpen={askOpen}
      onFind={() => setPaletteOpen(true)}
      onAsk={() => setAskOpen((v) => !v)}
    >
      {/* A crash stays in the page (WEB-011): the rail, the keys and ⌘R keep working, and
          going to another address (a new key) starts the page afresh. */}
      <ErrorBoundary key={routeHref(shown)} onLeave={{ label: "Go to Today", run: () => go({ kind: "today" }) }}>
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
      </ErrorBoundary>

      {/* The overlays these screens draw themselves join the overlay stack (§1.4, WEB-018):
          their place in the order (⌘K over Settings, not under it), Escape, dialog semantics
          where they had none, focus kept inside and given back. Each screen moves to the
          system's own Palette, Sheet or Panel in its wave. */}
      {askOpen && (
        <ErrorBoundary what="Ask Orr" onLeave={{ label: "Close", run: () => setAskOpen(false) }}>
          <Layer kind="panel" label="Ask Orr" role={null} modal={false} trap={false} focus={false} onClose={() => setAskOpen(false)}>
            <AskPanel onClose={() => setAskOpen(false)} onOpenNote={openNote} />
          </Layer>
        </ErrorBoundary>
      )}
      {paletteOpen && (
        <ErrorBoundary what="Find" onLeave={{ label: "Close", run: () => setPaletteOpen(false) }}>
          <Layer kind="palette" label="Find" onClose={() => setPaletteOpen(false)}>
            <SearchPalette
              onClose={() => setPaletteOpen(false)}
              onPick={(id) => {
                setPaletteOpen(false);
                openNote(id);
              }}
            />
          </Layer>
        </ErrorBoundary>
      )}
      {captureOpen && (
        <ErrorBoundary what="Capture" onLeave={{ label: "Close", run: () => setCaptureOpen(false) }}>
          <Layer kind="dialog" label="Capture" onClose={() => setCaptureOpen(false)}>
            <QuickCapture onClose={() => setCaptureOpen(false)} />
          </Layer>
        </ErrorBoundary>
      )}
      {keysOpen && <KeysSheet onClose={() => setKeysOpen(false)} />}
      {settingsOpen && (
        <ErrorBoundary what="Settings" onLeave={{ label: "Close", run: closeSettings }}>
          {/* Settings draws its own dialog (role, Tab trap): the layer adds Escape and the order.
              It is a sheet in that order, so what it opens (the colour profile editor, a
              confirm) goes over it instead of replacing it. */}
          <Layer kind="sheet" label="Settings" role={null} trap={false} onClose={closeSettings}>
            <Settings
              me={me}
              theme={accountTheme(themeShown)}
              onTheme={changeTheme}
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
          </Layer>
        </ErrorBoundary>
      )}
    </Shell>
  );
}
