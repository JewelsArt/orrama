/**
 * Addresses (structure.md §1.2): every place and every thing has a URL, so reload keeps your
 * place, the browser's Back and Android's back gesture work, and a view you can see is a view
 * you can link. The history API serves the same paths in the browser, the desktop window and
 * the phone; the server answers any path that is not /api with the app (main.ts).
 *
 * This module is the patterns and the eight places. Each screen fills in its own
 * sub-addresses in its wave (a project's tab, a week, a merchant): parseRoute keeps whatever
 * the address carries, and routeHref writes it back.
 */
import { useMemo, useSyncExternalStore } from "react";

export type Place = "today" | "planning" | "notes" | "orrery" | "projects" | "people" | "mail" | "money";

/** The rail's eight places, in order; the number is the key that opens it (§1.1, §1.5). */
export const PLACES: { place: Place; label: string; key: string }[] = [
  { place: "today", label: "Today", key: "1" },
  { place: "planning", label: "Planning", key: "2" },
  { place: "notes", label: "Notes", key: "3" },
  { place: "orrery", label: "Orrery", key: "4" },
  { place: "projects", label: "Projects", key: "5" },
  { place: "people", label: "People", key: "6" },
  { place: "mail", label: "Mail", key: "7" },
  { place: "money", label: "Money", key: "8" },
];

export type MoneyPage = "spending" | "documents" | "subscriptions" | "income" | "savings";
export type ProjectTab = "timeline" | "documents" | "todo";
export type SettingsSection = "you" | "appearance" | "ai" | "notes" | "connections" | "device" | "sessions" | "developer" | "access";

export type Route =
  | { kind: "today" }
  | { kind: "planning"; scale: "day" | "week" | "month"; at?: string }
  /** A note by its vault path (no .md), or, until the path is known, by its id. */
  | { kind: "notes"; path?: string; id?: string }
  | { kind: "notes-health" }
  | { kind: "orrery"; center?: string; area?: string; topic?: string }
  | { kind: "projects" }
  | { kind: "project"; slug: string; tab?: ProjectTab }
  | { kind: "people"; q?: string }
  | { kind: "person"; slug: string }
  | { kind: "company"; slug: string }
  | { kind: "conversation"; slug: string }
  | { kind: "document"; path: string }
  | { kind: "mail"; id?: string; waiting?: boolean }
  | { kind: "money"; page?: MoneyPage; category?: string; merchant?: string; month?: string }
  | { kind: "settings"; section?: SettingsSection };

const MONEY_PAGES = new Set<MoneyPage>(["spending", "documents", "subscriptions", "income", "savings"]);
const PROJECT_TABS = new Set<ProjectTab>(["timeline", "documents", "todo"]);
const SECTIONS = new Set<SettingsSection>(["you", "appearance", "ai", "notes", "connections", "device", "sessions", "developer", "access"]);
const SCALES = new Set(["day", "week", "month"]);

const dec = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};
const enc = (s: string) => encodeURIComponent(s);
/** A vault path in a URL: each folder its own segment, so slashes stay readable. */
const encPath = (p: string) => p.split("/").map(enc).join("/");

/**
 * What an address means, or null for one that means nothing here (the app then goes to
 * Today). `/` is Today; old and short forms (`/planning`, `/notes/map`) are understood and
 * written back in full by canonical().
 */
export function parseRoute(pathname: string, search = ""): Route | null {
  const q = new URLSearchParams(search);
  const [head = "", ...rest] = pathname.replace(/\/+$/, "").split("/").slice(1).map(dec);
  const opt = (k: string) => q.get(k) ?? undefined;
  switch (head) {
    case "":
    case "today":
      return { kind: "today" };
    case "planning": {
      const scale = rest[0] && SCALES.has(rest[0]) ? (rest[0] as "day" | "week" | "month") : "week";
      return rest[1] ? { kind: "planning", scale, at: rest[1] } : { kind: "planning", scale };
    }
    case "notes":
      if (rest.length === 0) return opt("id") ? { kind: "notes", id: opt("id") } : { kind: "notes" };
      if (rest.length === 1 && rest[0] === "health") return { kind: "notes-health" };
      if (rest.length === 1 && rest[0] === "map") return { kind: "orrery" };
      return { kind: "notes", path: rest.join("/") };
    case "orrery": {
      const r: Route = { kind: "orrery" };
      if (opt("center")) r.center = opt("center");
      if (opt("area")) r.area = opt("area");
      if (opt("topic")) r.topic = opt("topic");
      return r;
    }
    case "projects":
      if (!rest[0]) return { kind: "projects" };
      return rest[1] && PROJECT_TABS.has(rest[1] as ProjectTab) ? { kind: "project", slug: rest[0], tab: rest[1] as ProjectTab } : { kind: "project", slug: rest[0] };
    case "people":
      if (rest[0]) return { kind: "person", slug: rest[0] };
      return opt("q") ? { kind: "people", q: opt("q") } : { kind: "people" };
    case "companies":
      return rest[0] ? { kind: "company", slug: rest[0] } : { kind: "people" };
    case "conversations":
      return rest[0] ? { kind: "conversation", slug: rest[0] } : null;
    case "documents":
      return rest.length ? { kind: "document", path: rest.join("/") } : null;
    case "mail":
      if (rest[0] === "waiting") return { kind: "mail", waiting: true };
      return rest[0] ? { kind: "mail", id: rest[0] } : { kind: "mail" };
    case "money": {
      const r: Route = { kind: "money" };
      if (rest[0] && MONEY_PAGES.has(rest[0] as MoneyPage)) r.page = rest[0] as MoneyPage;
      if (r.page === "spending" && rest[1]) r.category = rest[1];
      if (r.page === "spending" && rest[2]) r.merchant = rest[2];
      if (opt("merchant")) r.merchant = opt("merchant");
      if (opt("month")) r.month = opt("month");
      return r;
    }
    case "settings":
      return rest[0] && SECTIONS.has(rest[0] as SettingsSection) ? { kind: "settings", section: rest[0] as SettingsSection } : { kind: "settings" };
    default:
      return null;
  }
}

/** The address of a route: what the browser shows, what a link points at. */
export function routeHref(r: Route): string {
  const query = (o: Record<string, string | undefined>) => {
    const q = new URLSearchParams(Object.entries(o).filter((e): e is [string, string] => !!e[1]));
    const s = q.toString();
    return s ? `?${s}` : "";
  };
  switch (r.kind) {
    case "today":
      return "/today";
    case "planning":
      return `/planning/${r.scale}${r.at ? `/${enc(r.at)}` : ""}`;
    case "notes":
      return r.path ? `/notes/${encPath(r.path)}` : `/notes${query({ id: r.id })}`;
    case "notes-health":
      return "/notes/health";
    case "orrery":
      return `/orrery${query({ center: r.center, area: r.area, topic: r.topic })}`;
    case "projects":
      return "/projects";
    case "project":
      return `/projects/${enc(r.slug)}${r.tab ? `/${r.tab}` : ""}`;
    case "people":
      return `/people${query({ q: r.q })}`;
    case "person":
      return `/people/${enc(r.slug)}`;
    case "company":
      return `/companies/${enc(r.slug)}`;
    case "conversation":
      return `/conversations/${enc(r.slug)}`;
    case "document":
      return `/documents/${encPath(r.path)}`;
    case "mail":
      return r.waiting ? "/mail/waiting" : r.id ? `/mail/${enc(r.id)}` : "/mail";
    case "money": {
      if (r.page === "spending" && r.category) return `/money/spending/${enc(r.category)}${r.merchant ? `/${enc(r.merchant)}` : ""}${query({ month: r.month })}`;
      if (r.page) return `/money/${r.page}${query({ merchant: r.merchant, month: r.month })}`;
      return `/money${query({ merchant: r.merchant, month: r.month })}`;
    }
    case "settings":
      return `/settings${r.section ? `/${r.section}` : ""}`;
  }
}

/** Which of the eight places a route belongs to (the rail lights it). Settings belongs to none. */
export function placeOf(r: Route): Place | null {
  switch (r.kind) {
    case "today":
      return "today";
    case "planning":
      return "planning";
    case "notes":
    case "notes-health":
    case "conversation":
    case "document":
      return "notes";
    case "orrery":
      return "orrery";
    case "projects":
    case "project":
      return "projects";
    case "people":
    case "person":
    case "company":
      return "people";
    case "mail":
      return "mail";
    case "money":
      return "money";
    case "settings":
      return null;
  }
}

/** The route a place opens on. */
export function placeRoute(p: Place): Route {
  switch (p) {
    case "planning":
      return { kind: "planning", scale: "week" };
    case "notes":
      return { kind: "notes" };
    case "orrery":
      return { kind: "orrery" };
    case "projects":
      return { kind: "projects" };
    case "people":
      return { kind: "people" };
    case "mail":
      return { kind: "mail" };
    case "money":
      return { kind: "money" };
    default:
      return { kind: "today" };
  }
}

/** Is this page deeper than its place's front page? (The phone's top bar shows Back.) */
export function isDeep(r: Route): boolean {
  const p = placeOf(r);
  if (!p) return true;
  // Planning's scales and dates are views of one place, side by side (its tabs and arrows), not levels.
  if (r.kind === "planning") return false;
  return routeHref(r).split("?")[0] !== routeHref(placeRoute(p)).split("?")[0];
}

/* ---- the history ------------------------------------------------------------------------ */

const NAVIGATED = "orrama:navigate";

interface HistoryState {
  /** How many in-app steps lie behind this entry: Back stays in the app while it is > 0. */
  depth: number;
}

const depthNow = (): number => (history.state as HistoryState | null)?.depth ?? 0;

/** Go somewhere: push a history entry (or replace this one). */
export function navigate(to: Route | string, opts: { replace?: boolean } = {}): void {
  const href = typeof to === "string" ? to : routeHref(to);
  if (href === location.pathname + location.search) return;
  if (opts.replace) history.replaceState({ depth: depthNow() } satisfies HistoryState, "", href);
  else history.pushState({ depth: depthNow() + 1 } satisfies HistoryState, "", href);
  window.dispatchEvent(new Event(NAVIGATED));
}

/** Can Back go to an earlier page of this app (rather than out of it)? */
export const canGoBack = (): boolean => depthNow() > 0;

/** Back one page in the app; with nowhere to go back to, to `fallback` (a place's front page). */
export function goBack(fallback?: Route): void {
  if (canGoBack()) history.back();
  else if (fallback) navigate(fallback, { replace: true });
}

const subscribe = (cb: () => void) => {
  window.addEventListener("popstate", cb);
  window.addEventListener(NAVIGATED, cb);
  return () => {
    window.removeEventListener("popstate", cb);
    window.removeEventListener(NAVIGATED, cb);
  };
};
const snapshot = () => location.pathname + location.search;

/** The address the page shows now; re-renders on every navigation, Back and Forward. */
export function useLocation(): string {
  return useSyncExternalStore(subscribe, snapshot);
}

/**
 * The route the page shows now, and, if the address is not one this app knows, null. The same
 * object while the address stays the same, so it can be an effect's dependency.
 */
export function useRoute(): Route | null {
  const href = useLocation();
  return useMemo(() => {
    const i = href.indexOf("?");
    return parseRoute(i < 0 ? href : href.slice(0, i), i < 0 ? "" : href.slice(i));
  }, [href]);
}

/**
 * Write the address in its full form once (`/` → `/today`, `/planning` → `/planning/week`,
 * `/notes/map` → `/orrery`), replacing the entry rather than adding one. Returns the route.
 */
export function canonical(): Route {
  const r = parseRoute(location.pathname, location.search) ?? { kind: "today" };
  const href = routeHref(r);
  if (href !== location.pathname + location.search) history.replaceState({ depth: depthNow() } satisfies HistoryState, "", href);
  return r;
}
