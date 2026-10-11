/**
 * The App with its screens replaced by stubs, for tests of the shell itself: addresses, keys,
 * overlays, the error boundary. Each stub renders its props and buttons for its callbacks.
 * Import this module before App (vi.mock calls are hoisted within it).
 */
import { vi } from "vitest";

type P = Record<string, unknown> & { [k: string]: any };

const stub = (name: string, buttons: (p: P) => [string, () => void][] = () => []) =>
  function Stub(p: P) {
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
      </div>
    );
  };

vi.mock("../Dashboard.js", () => ({
  Dashboard: stub("dashboard", (p) => [
    ["open project", () => p.onOpenProject("thesis")],
    ["open note", () => p.onOpenNote("n-1")],
    ["open month", () => p.onOpenFinance({ month: "2026-09", category: "Groceries" })],
    ["open area", () => p.onOpenCategory("work")],
    ["open settings", () => p.onOpenSettings()],
  ]),
}));
vi.mock("../Architecture.js", () => ({ Architecture: stub("architecture") }));
vi.mock("../Planning.js", () => ({ Planning: stub("planning") }));
vi.mock("../Overview.js", () => ({ Overview: stub("overview") }));
vi.mock("../Project.js", () => ({ Project: stub("project", (p) => [["back", () => p.onBack()]]) }));
vi.mock("../Contacts.js", () => ({ Contacts: stub("contacts") }));
vi.mock("../Mail.js", () => ({ Mail: stub("mail") }));
vi.mock("../Finance.js", () => ({
  Finance: stub("finance", (p) => [
    ["category Shopping", () => p.onOpenCategory("Shopping")],
    ["merchant UNIQLO", () => p.onOpenMerchant("UNIQLO")],
    ["page savings", () => p.onOpenPage("savings")],
    ["back", () => p.onBack()],
  ]),
}));
vi.mock("../Settings.js", () => ({ Settings: stub("settings", (p) => [["close settings", () => p.onClose()]]) }));
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
