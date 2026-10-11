/**
 * The real name of the thing an entity page shows, for the window title and the phone's top
 * bar. The address carries only a slug ("ines-vermaat"), so App's title for it was the slug in
 * words ("Ines vermaat"); the page knows the note's title once it has loaded and says it here.
 */
import { useEffect, useSyncExternalStore } from "react";

let current: { href: string; title: string } | null = null;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((l) => l());

/** Called by an entity page with its address and its name; cleared when it goes. */
export function usePageTitle(href: string, title: string | null | undefined): void {
  useEffect(() => {
    if (!title) return;
    current = { href, title };
    changed();
    return () => {
      if (current?.href === href) {
        current = null;
        changed();
      }
    };
  }, [href, title]);
}

/** The name an entity page gave for this address, if it is the one showing. */
export function usePageTitleFor(href: string): string | null {
  const v = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
  return v && v.href === href ? v.title : null;
}
