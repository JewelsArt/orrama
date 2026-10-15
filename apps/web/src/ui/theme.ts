/**
 * The theme (structure.md §9): light or dark per account, so a second device shows the same
 * app, plus **Match this device**, a choice one device makes to follow its system instead (the
 * phone at night). The account keeps its own theme while a device matches.
 *
 * Words: the account stores "light" or "command" (the server's names; "paper" is an older
 * light). The page says data-theme="light" or "dark". Settings offers Light, Dark and Match
 * this device.
 *
 * The first frame: public/boot-theme.js puts the theme on <html> before anything draws
 * (WEB-019), from the two keys below, which App keeps current. Its rule is resolveTheme's, and
 * theme.dom.test.ts runs the file against it.
 */
import { useSyncExternalStore } from "react";

export type Shown = "light" | "dark";
export type ThemeChoice = Shown | "match";

/** The account's theme, cached on this device for the first frame. */
export const THEME_KEY = "orrama-theme";
/** "match" on a device that follows its system. */
export const DEVICE_KEY = "orrama-theme-device";

const DARK = "(prefers-color-scheme: dark)";

/** What a stored theme shows. */
export const shownOf = (stored: string | null | undefined): Shown => (stored === "dark" || stored === "command" ? "dark" : "light");

/** The account's word for a theme. */
export const accountTheme = (shown: Shown): "light" | "command" => (shown === "dark" ? "command" : "light");

/** The theme the page shows: the system's on a device that matches it, else the account's. */
export const resolveTheme = (account: string | null | undefined, match: boolean, systemDark: boolean): Shown =>
  match ? (systemDark ? "dark" : "light") : shownOf(account);

/** Is the system dark right now? */
export const systemIsDark = (): boolean => typeof matchMedia === "function" && matchMedia(DARK).matches;

/** Whether the system is dark, kept current as it changes (at sunset, say). */
export function useSystemDark(): boolean {
  return useSyncExternalStore((changed) => {
    if (typeof matchMedia !== "function") return () => {};
    const query = matchMedia(DARK);
    query.addEventListener("change", changed);
    return () => query.removeEventListener("change", changed);
  }, systemIsDark);
}
