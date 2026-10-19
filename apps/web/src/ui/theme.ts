/**
 * The theme (structure.md §9): light or dark per account, so a second device shows the same
 * app, plus **Match this device**, a choice one device makes to follow its system instead (the
 * phone at night). The account keeps its own theme while a device matches.
 *
 * Words: the account stores "light" or "command" (the server's names; "paper" is an older
 * light). Settings offers Day, Night and Match this device.
 *
 * The look (Clay, 19 Oct 2026): Paper (warm paper by day, night blue after dark) or Clay (cool
 * grey and burnt orange, near black after dark), per account like the theme; absent is Paper.
 * The page gets one data-theme from the two: "light" | "dark" for Paper, "clay" | "clay-dark"
 * for Clay. Code that cares whether it is night asks isNight(), never compares to "dark".
 *
 * The first frame: public/boot-theme.js puts the theme on <html> before anything draws
 * (WEB-019), from the two keys below, which App keeps current. Its rule is resolveTheme's, and
 * theme.dom.test.ts runs the file against it.
 */
import { useSyncExternalStore } from "react";

/** Light or dark: the mode, whatever the look. */
export type Shown = "light" | "dark";
export type ThemeChoice = Shown | "match";
export type Look = "paper" | "clay";
/** What the page's data-theme says: the look and the mode together. */
export type PageTheme = "light" | "dark" | "clay" | "clay-dark";

/** The account's theme, cached on this device for the first frame. */
export const THEME_KEY = "orrama-theme";
/** "match" on a device that follows its system. */
export const DEVICE_KEY = "orrama-theme-device";
/** The account's look, cached on this device for the first frame. */
export const LOOK_KEY = "orrama-look";

const DARK = "(prefers-color-scheme: dark)";

/** What a stored theme shows. */
export const shownOf = (stored: string | null | undefined): Shown => (stored === "dark" || stored === "command" ? "dark" : "light");

/** The account's word for a theme. */
export const accountTheme = (shown: Shown): "light" | "command" => (shown === "dark" ? "command" : "light");

/** What a stored look is: Clay, or Paper for anything else (absent included). */
export const lookOf = (stored: string | null | undefined): Look => (stored === "clay" ? "clay" : "paper");

/** The page's data-theme for a look in a mode. */
export const pageTheme = (look: Look, mode: Shown): PageTheme => (look === "clay" ? (mode === "dark" ? "clay-dark" : "clay") : mode);

/** Is this data-theme a night one? Dark, Clay at night, and the account's old "command". */
export const isNight = (theme: string | null | undefined): boolean => theme === "dark" || theme === "clay-dark" || theme === "command";

/** Light or dark, whatever the look. */
export const modeOf = (theme: string | null | undefined): Shown => (isNight(theme) ? "dark" : "light");

/** The theme the page shows: the system's on a device that matches it, else the account's, in the look. */
export const resolveTheme = (account: string | null | undefined, match: boolean, systemDark: boolean, look: Look = "paper"): PageTheme =>
  pageTheme(look, match ? (systemDark ? "dark" : "light") : shownOf(account));

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
