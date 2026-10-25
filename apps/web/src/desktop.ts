/**
 * Whether this page is inside the Orrama desktop app, and the three things only the app can do
 * for it (2C). The one place that knows: never the user agent, which says WebKit or WebView2
 * for any app and any browser alike.
 *
 * The app's shell marks its own window: an initialization script sets
 * `window.__ORRAMA_DESKTOP__` on every page it loads there (lib.rs). A browser tab, a phone over
 * Tailscale, and Jules's older window (which predates the mark) are all "not the app", and keep
 * what works in a browser: the typed folder path, ChatGPT's sign-in in the same tab, and the
 * reset said in words.
 *
 * - `pickFolder`: the system's folder chooser, through the dialog plugin's one command. The only
 *   Tauri call the server's pages may make (capability `server-page`, lib.rs): it returns the
 *   folder the person picked and can read or write nothing itself.
 * - `startReset`: "Forgot your password?" sends the window to a path the shell catches
 *   (`RESET_PATH`, window.rs). The shell asks the server for a one-time reset with a token only
 *   it holds, and opens `/reset#ticket=…`; the page never sees the token.
 * - ChatGPT's sign-in: the shell opens auth.openai.com in the system browser (Google refuses to
 *   sign in inside an app's window), so the page asks for a sign-in it waits for
 *   (settings/Ai.tsx).
 */

interface DesktopMark {
  shell: number;
}
interface TauriInternals {
  invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>;
}
declare global {
  interface Window {
    __ORRAMA_DESKTOP__?: DesktopMark;
    __TAURI_INTERNALS__?: TauriInternals;
  }
}

/** True inside the desktop app's window. */
export function inApp(): boolean {
  return typeof window !== "undefined" && typeof window.__ORRAMA_DESKTOP__?.shell === "number";
}

/** Where "Forgot your password?" sends the app's window; the shell catches it (window.rs). */
export const RESET_PATH = "/_shell/reset";

/** The page the shell opens once it has a ticket: `/reset#ticket=…`, or `#failed`. */
export const RESET_PAGE = "/reset";

/** Ask the shell for a reset. Only in the app: a browser would just load the app there. */
export function startReset(): void {
  if (inApp()) window.location.assign(RESET_PATH);
}

/**
 * What the shell left at `/reset`: the ticket, or that it couldn't get one. Read once, then the
 * address goes back to `/`, so the ticket is not left in the address bar or the history.
 */
export function takeResetTicket(loc: Pick<Location, "pathname" | "hash"> = window.location): { ticket: string } | { failed: true } | null {
  if (loc.pathname !== RESET_PAGE) return null;
  const hash = new URLSearchParams(loc.hash.replace(/^#/, ""));
  const ticket = hash.get("ticket");
  if (typeof history !== "undefined") history.replaceState(null, "", "/");
  return ticket ? { ticket } : { failed: true };
}

/**
 * The system's folder chooser. The folder picked, or null when the person cancelled. Throws when
 * the chooser can't open (not the app, or a shell without it): the caller offers the typed path.
 */
export async function pickFolder(title: string): Promise<string | null> {
  const ipc = window.__TAURI_INTERNALS__;
  if (!inApp() || !ipc) throw new Error("the folder chooser is only in the app");
  const picked = await ipc.invoke("plugin:dialog|open", { options: { directory: true, multiple: false, recursive: false, canCreateDirectories: true, title } });
  if (picked === null || picked === undefined) return null;
  if (typeof picked !== "string") throw new Error("the folder chooser answered something else");
  return picked;
}
