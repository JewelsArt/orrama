import type { TreeNote } from "./api.js";
import { daysTo as coreDaysTo, isoLocal } from "@basalt/core/dates";

/**
 * Semantic categories over the PARA vault, each with a colour. This one module
 * is the single source of truth for how the vault is grouped and coloured — the
 * map, the file list, and the category filter all read from here, so a note is
 * the same colour everywhere. The grouping itself is the vault's
 * `#vault-categories` note, applied on the server.
 *
 * The colours are TOKENS, not hex. They used to be five hand-picked hex values
 * that were chosen against a white page and then carried unchanged into the
 * near-black theme, which is precisely what the design rules forbid. Retint in
 * `packages/ui/src/tokens.css`, never here. Every consumer puts them in a DOM
 * or SVG context where `var()` resolves; the graph canvas reads its own colours
 * from CSS and never touches these, which is why it can stay monochrome.
 */
export interface Category {
  id: string;
  label: string;
  color: string;
}

/**
 * The areas, in the order they are drawn. WHICH notes fall in each is decided
 * on the server from the vault's own `#vault-categories` note (core
 * vaultCategories.ts) and arrives as `TreeNote.category` — the rules used to be
 * regexes here naming Jules's university, employer and projects.
 */
export const CATEGORIES: Category[] = [
  { id: "school", label: "School", color: "var(--vault-school)" },
  { id: "work", label: "Work", color: "var(--vault-work)" },
  { id: "knowledge", label: "Knowledge", color: "var(--vault-knowledge)" },
  { id: "tools", label: "Claude & tools", color: "var(--vault-tools)" },
  { id: "personal", label: "Personal", color: "var(--vault-personal)" },
];

const FALLBACK = "var(--vault-other)";

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

/** Life-areas, as the Overview board separates projects. Shared by the board,
 *  the project workspace and the Dashboard's Projects card so a project is the
 *  same colour wherever it appears. */
export const DOMAIN_COLOR: Record<string, string> = {
  personal: "var(--area-personal)",
  professional: "var(--area-professional)",
  academic: "var(--area-academic)",
};

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
  return note.category ?? "personal";
}

export function categoryColor(id: string): string {
  return CATEGORIES.find((c) => c.id === id)?.color ?? FALLBACK;
}

export function colorOf(note: Pick<TreeNote, "category">): string {
  return categoryColor(categoryOf(note));
}
