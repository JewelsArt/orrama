/**
 * A failed write is never silent (audit WEB-010). Every change the app sends — a form, an inline
 * edit, a tick, a drag, a menu pick — ends one of two ways the person can see: it landed, or a
 * plain sentence says what didn't happen, the control comes back and what they typed is still
 * there. Two shapes, one rule:
 *
 * - `attempt` for one-click writes (a checkbox, a menu, a drag): a toast says what failed, with
 *   Retry when trying again could help. It never throws.
 * - `useWrite` for a form or an inline edit: busy while it runs, the sentence to show beside the
 *   field when it fails, and busy always ends. It never touches the fields: keeping the words is
 *   the caller doing nothing.
 *
 * And a net under both: `installWriteNet` says any failed write nobody caught, so a call site
 * that forgets is still not silent. It is the page speaking, never Orr.
 */
import { useCallback, useState } from "react";
import { ApiError, isAbort, isFailedWrite } from "../api.js";
import { toast } from "./overlays.js";

/** "the server said no" → a sentence, ending in a full stop. */
const sentence = (m: string) => {
  const t = m.trim();
  return t.charAt(0).toUpperCase() + t.slice(1) + (/[.!?]$/.test(t) ? "" : ".");
};

/**
 * What went wrong, after `what` didn't happen ("The step wasn't ticked."): the server's reason
 * when it gave one a person can read, else what to do. Never an exception's text.
 */
export function failureText(e: unknown, what: string): string {
  if (!(e instanceof ApiError)) return `${what} The server didn't answer. Check it's running, then try again.`;
  if (e.status === 403) return `${what} You can read this but not change it.`;
  const m = e.message.trim();
  if (e.status >= 500 || !m || /^(request failed|internal( server)? error|bad request|not found|conflict|\d{3}\b)/i.test(m)) return `${what} Try again in a moment.`;
  return `${what} ${sentence(m)}`;
}

/**
 * Trying the same thing again helps when the server didn't answer or broke (a restart, a 5xx),
 * not when it refused: a 4xx gets the same answer twice.
 */
export const worthRetrying = (e: unknown): boolean => !(e instanceof ApiError) || e.status >= 500 || e.status === 408 || e.status === 429;

/**
 * Run a one-click write. True when it landed; on failure a toast says so (with Retry when it
 * could help, which runs the whole of `run` again) and the result is false. A cancelled
 * request is not a failure and says nothing.
 */
export async function attempt(what: string, run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return true;
  } catch (e) {
    if (isAbort(e)) return false;
    toast(failureText(e, what), worthRetrying(e) ? { ms: 10_000, action: { label: "Retry", run: () => void attempt(what, run) } } : { ms: 8000 });
    return false;
  }
}

/**
 * For a form or an inline edit. `run(what, job)` sets busy, clears the last failure, and on a
 * failure sets `error` to the sentence; busy ends whatever happens, so the button comes back.
 */
export function useWrite() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (what: string, job: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await job();
      return true;
    } catch (e) {
      if (!isAbort(e)) setError(failureText(e, what));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  const clear = useCallback(() => setError(null), []);
  return { busy, error, run, clear };
}

/**
 * The net: a write that failed and that nothing caught is said in a toast instead of only in the
 * console. Installed once, in main.tsx. Returns the uninstall, for tests.
 */
export function installWriteNet(target: Window = window): () => void {
  const onRejection = (ev: PromiseRejectionEvent) => {
    if (!isFailedWrite(ev.reason)) return;
    ev.preventDefault();
    toast(failureText(ev.reason, "That change didn't save."), { ms: 8000 });
  };
  target.addEventListener("unhandledrejection", onRejection);
  return () => target.removeEventListener("unhandledrejection", onRejection);
}
