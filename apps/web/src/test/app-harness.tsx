/**
 * The App with its screens replaced by stubs, for tests of the shell itself: addresses, keys,
 * overlays, the error boundary. Each stub renders its props and buttons for its callbacks.
 * Import this module before App (vi.mock calls are hoisted within it).
 */
import { useEffect, useState, type ReactNode } from "react";
import { vi } from "vitest";
import { Dialog } from "../dialog.js";

type P = Record<string, unknown> & { [k: string]: any };

/** Screens that throw when they render, for the error boundary's tests. */
export const crash = new Set<string>();

const stub = (name: string, buttons: (p: P) => [string, () => void][] = () => [], extra?: () => ReactNode) =>
  function Stub(p: P) {
    // A test can make a screen throw while rendering: crash.add("planning").
    if (crash.has(name)) throw new Error(`${name} fell over`);
    const shown = Object.entries(p)
      .filter(([, v]) => v !== undefined && typeof v !== "function" && typeof v !== "object")
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    return (
      <div data-testid="view" data-view={name}>
        {name} {shown}
        {buttons(p).map(([label, fn]) => (
          <button key={label} onClick={fn}>
            {label}
          </button>
        ))}
        {extra?.()}
      </div>
    );
  };

// Today goes to its addresses itself (navigate), as every redrawn screen does.
vi.mock("../Today.js", async () => {
  const { navigate } = await import("../ui/router.js");
  return {
    Today: stub("today", (p) => [
      ["open project", () => navigate({ kind: "project", slug: "thesis" })],
      ["open note", () => navigate({ kind: "notes", id: "n-1" })],
      ["new task", () => p.onCapture()],
    ]),
  };
});
vi.mock("../Notes.js", () => ({ Notes: stub("notes") }));
vi.mock("../orrery/Orrery.js", () => {
  const Orrery = stub("orrery");
  return { Orrery: (p: P) => <Orrery area={p.route.area} center={p.route.center} topic={p.route.topic} /> };
});
vi.mock("../Planning.js", () => ({ Planning: stub("planning") }));
vi.mock("../Overview.js", () => ({ Overview: stub("overview") }));
/** How many times the project page was mounted: its tabs are addresses, not new pages. */
const counts = vi.hoisted(() => ({ project: 0 }));
export const mounted = counts;
vi.mock("../Project.js", () => {
  const Stub = stub("project");
  return {
    Project: (p: P) => {
      useEffect(() => {
        counts.project++;
      }, []);
      return <Stub {...p} />;
    },
  };
});
// People holds what was typed in it: its own addresses (a person, ?q=) must not remount it.
vi.mock("../people/People.js", () => ({ People: stub("contacts", () => [], () => <input aria-label="people draft" />) }));
vi.mock("../Mail.js", () => ({ Mail: stub("mail") }));
vi.mock("../Finance.js", async () => {
  // Money reads its own address and goes where its links point (money/links.ts).
  const { useRoute, navigate, goBack } = await import("../ui/router.js");
  const Money = stub("money", () => [
    ["category Shopping", () => navigate({ kind: "money", page: "spending", category: "Shopping" })],
    ["month Groceries", () => navigate({ kind: "money", page: "spending", category: "Groceries", month: "2026-09" })],
    ["merchant UNIQLO", () => navigate({ kind: "money", page: "spending", merchant: "UNIQLO" })],
    ["page savings", () => navigate({ kind: "money", page: "savings" })],
    ["back", () => goBack({ kind: "money" })],
  ]);
  return {
    Money: () => {
      const r = useRoute();
      return r?.kind === "money" ? <Money page={r.page} category={r.category} merchant={r.merchant} month={r.month} /> : null;
    },
  };
});
/** A box the Settings page opens over itself, the way its colour profile editor does. */
function ProfileEditor() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>edit a profile</button>
      {open && (
        <Dialog label="Edit colour profile" onEscape={() => setOpen(false)}>
          <input aria-label="Profile name" />
        </Dialog>
      )}
    </>
  );
}

vi.mock("../Settings.js", () => ({
  Settings: stub(
    "settings",
    (p) => [
      ["theme light", () => p.onTheme("light")],
      ["theme dark", () => p.onTheme("command")], // the word Settings has always sent
      ["theme match", () => p.onTheme("match")],
    ],
    () => <ProfileEditor />,
  ),
}));
vi.mock("../AskPanel.js", () => ({ AskPanel: stub("ask", (p) => [["close ask", () => p.onClose()]]) }));
vi.mock("../SearchPalette.js", () => ({ SearchPalette: stub("search", (p) => [["pick n-1", () => p.onPick("n-1")]]) }));
vi.mock("../QuickCapture.js", () => ({ QuickCapture: stub("capture") }));
vi.mock("../Login.js", () => ({ Login: stub("login") }));
vi.mock("../Lock.js", () => ({ Lock: stub("lock") }));
vi.mock("../Setup.js", () => ({ Setup: stub("setup") }));

export const ME = {
  id: "u-1",
  email: "jules@basalt.dev",
  username: "jules",
  displayName: "Jules",
  avatar: "victorr",
  isOwner: true,
  teams: [],
  appearance: null,
};

export const TREE = [{ id: "n-1", path: "04-Projects/thesis/Graduation thesis.md", folder: "04-Projects/thesis", title: "Graduation thesis", hash: "h", mtimeMs: 0, tags: [], openTasks: 0, category: "school" }];

class FakeSocket {
  onopen = null;
  onmessage = null;
  onclose = null;
  send() {}
  close() {}
}

/** Answer the App's own requests; anything else is a 404. */
export function serve(over: Record<string, unknown> = {}) {
  const routes: Record<string, unknown> = {
    "GET /api/me": ME,
    "GET /api/auth/status": { needsSetup: false },
    "GET /api/vault/tree": TREE,
    "GET /api/health": { ok: true, notes: 1, build: null },
    "PATCH /api/me": ME,
    ...over,
  };
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("fetch", async (url: string, init: { method?: string } = {}) => {
    const key = `${init.method ?? "GET"} ${url.split("?")[0]}`;
    if (!(key in routes)) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    const body = routes[key];
    if (body instanceof Response) return body;
    return new Response(JSON.stringify(body), { status: 200 });
  });
}

/** Start the app at an address, as a reload there would. */
export function at(href: string) {
  window.history.replaceState(null, "", href);
}
