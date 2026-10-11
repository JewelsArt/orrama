/**
 * The rail's Mail dot (Jules, 11 October): it shows when Orr's drafts are waiting for you, not
 * for unread mail. Asked again whenever you go somewhere (you may have just sent one), when the
 * window comes back into focus, and every two minutes (Orr drafts from Ask and from Claude Code
 * while you are elsewhere).
 */
import { useEffect, useState } from "react";
import { api } from "../api.js";

export const DRAFTS_EVERY_MS = 120_000;

export function useDraftsWaiting(signedIn: boolean, where: string): number {
  const [waiting, setWaiting] = useState(0);
  useEffect(() => {
    if (!signedIn) {
      setWaiting(0);
      return;
    }
    let live = true;
    const ask = () =>
      api<unknown[]>("GET", "/api/mail/drafts")
        .then((d) => live && setWaiting(Array.isArray(d) ? d.length : 0))
        .catch(() => {
          /* the dot stays as it was; the next ask may reach the server */
        });
    void ask();
    window.addEventListener("focus", ask);
    const timer = setInterval(ask, DRAFTS_EVERY_MS);
    return () => {
      live = false;
      window.removeEventListener("focus", ask);
      clearInterval(timer);
    };
  }, [signedIn, where]);
  return waiting;
}
