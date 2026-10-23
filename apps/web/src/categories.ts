import { useEffect, useSyncExternalStore } from "react";
import { api, type TreeNote } from "./api.js";
import type { LifeAreas } from "@orrama/schema/responses";
import { daysTo as coreDaysTo, isoLocal } from "@orrama/core/dates";

/**
 * The life areas, each with its colour. This one module is the single source of truth for how
 * the vault is grouped and coloured: Planning's lanes, the Projects board, the Notes tree, the
 * entity pages, first run and the Orrery all read from here, so a note is the same colour
 * everywhere. The list is the person's (Settings → Notes → Life areas, `GET /api/areas`); which
 * notes fall in each is decided on the server and arrives as `TreeNote.category` and a project
 * row's `area`.
 *
 * The colours are TOKENS, not hex, by position (Jules, 23 Oct 2026): the first area `--c1`, the
 * fifth `--c5`, and every one after that `--c-other`, as Money's categories are drawn; the
 * colour-vision profiles override the five. Retint in `packages/ui/src/tokens.css`, never here.
 * Every consumer puts them in a DOM or SVG context where `var()` resolves; the graph canvas
 * reads its own colours from CSS. Category colours belong on white boxes: on the paper ground
 * they fall below 3:1 (§12).
 */
export interface Category {
  id: string;
  label: string;
  color: string;
  /** The area for everything no other area claims. */
  catchAll: boolean;
}

/** The colour of the area at position `i` in the list: the five, then grey. */
export const areaColorAt = (i: number): string => (i >= 0 && i < 5 ? `var(--c${i + 1})` : "var(--c-other)");

/** The list as the server sends it, drawn: each area with its colour. */
export function categoriesOf(areas: readonly { id: string; name: string; catchAll: boolean }[]): Category[] {
  return areas.map((a, i) => ({ id: a.id, label: a.name, color: areaColorAt(i), catchAll: a.catchAll }));
}

/** What a vault has before the server has said (and without an areas note): Work and Personal. */
const STARTER: Category[] = categoriesOf([
  { id: "work", name: "Work", catchAll: false },
  { id: "personal", name: "Personal", catchAll: true },
]);

let current: Category[] = STARTER;
let loaded: Promise<void> | null = null;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
const snapshot = () => current;

/** Asks the server for the list again (after Settings changes it), and tells every screen. */
export function loadAreas(): Promise<void> {
  loaded = api<LifeAreas>("GET", "/api/areas")
    .then((r) => {
      current = categoriesOf(r.areas);
      changed();
    })
    .catch(() => {
      // Keep what is drawn; the next screen that asks tries again.
      loaded = null;
    });
  return loaded;
}

/** The areas in order, as the screens draw them; asked of the server the first time. */
export function useAreas(): Category[] {
  const list = useSyncExternalStore(subscribe, snapshot);
  useEffect(() => {
    if (!loaded) void loadAreas();
  }, []);
  return list;
}

/** The list as last drawn, for code outside a component. */
export const areasNow = (): Category[] => current;

/** Tests: the list as if the server had sent it. */
export function setAreasForTest(areas: readonly { id: string; name: string; catchAll: boolean }[] | null): void {
  current = areas ? categoriesOf(areas) : STARTER;
  loaded = areas ? Promise.resolve() : null;
  changed();
}

/** The catch-all's id. */
export const catchAllOf = (areas: readonly Category[] = current): string => (areas.find((a) => a.catchAll) ?? areas[areas.length - 1])?.id ?? "personal";

const FALLBACK = "var(--c-other)";

/**
 * Project lifecycle, spelled the several ways a hand-written `status:` line
 * actually appears in the vault. The Overview board already used the first two
 * sets to lift parked work off the board; they live here now so the Dashboard's
 * Projects card retires the same projects the board does, rather than inventing
 * a second opinion.
 */
export const SLEEP_STATES = new Set(["sleeping", "asleep", "paused", "on-hold", "on hold", "someday"]);
export const CANCEL_STATES = new Set(["cancelled", "canceled", "dropped", "abandoned"]);
export const DONE_STATES = new Set(["done", "complete", "completed", "finished", "shipped", "delivered"]);

/**
 * Is this project still live work? No, if it says so — and also no if every one
 * of its steps is ticked, which is what "completed" looks like for the many
 * project notes that carry no `status:` at all. A project with no steps yet is
 * active: nothing has been done, which is not the same as nothing being left.
 */
export function isProjectActive(p: { status: string | null; total: number; done: number }): boolean {
  const st = (p.status ?? "").trim().toLowerCase();
  if (SLEEP_STATES.has(st) || CANCEL_STATES.has(st) || DONE_STATES.has(st)) return false;
  return !(p.total > 0 && p.done >= p.total);
}

/** Whole days from today to a YYYY-MM-DD; negative is past. Local midnight on
 *  both sides, so a DST boundary never rounds a 7-day gap down to 6. */
export function daysTo(date: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  // Through the one local-date module: today off the local clock, the span
  // counted between UTC midnights so a 23-hour DST day still counts as one.
  return coreDaysTo(isoLocal(), date);
}

/** "3d late" / "today" / "in 2w" — a date rendered as distance from now. */
export function relDay(days: number): string {
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  const a = Math.abs(days);
  const span = a >= 60 ? `${Math.round(a / 30)}mo` : a >= 14 ? `${Math.round(a / 7)}w` : `${a}d`;
  return days < 0 ? `${span} late` : `in ${span}`;
}

/**
 * Claude Code's per-session transcripts. Real notes everywhere else — the map,
 * the file tree and search all still show them — but they are machine output,
 * so any *proportion* of the vault (the dashboard donut, the note count) has to
 * leave them out or it just measures how much Claude has run. 550 of 613 files
 * live here, which is why the donut used to read "Claude & tools 76%".
 * Mirrored server-side in apps/server/src/routes/home.ts. Change one, change
 * the other.
 */
export function isSessionLog(note: Pick<TreeNote, "path">): boolean {
  return note.path.startsWith("Claude Sessions/");
}

export function categoryOf(note: Pick<TreeNote, "category">): string {
  return note.category ?? catchAllOf();
}

/** An area's colour by id in a list (the current one by default); an id the list doesn't have is grey. */
export function categoryColor(id: string, areas: readonly Category[] = current): string {
  return areas.find((c) => c.id === id)?.color ?? FALLBACK;
}
