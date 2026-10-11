/**
 * One status vocabulary (structure.md §2.4): the vault ontology's seven words, *planned · on
 * track · at risk · paused · completed · archived · cancelled* (core `ONTOLOGY_TEMPLATE`,
 * `## Statuses`). A note's `status:` is hand-written, so the older spellings the board used
 * (`planning`, `sleeping`, `done`, `blocked`…) and the ontology's own aliases are read as the
 * word they mean; what is written back is always the ontology's id.
 *
 * Which shelf a project sits on follows from the same word: paused, cancelled, completed and
 * archived leave the board for their shelf, and a project whose every step is ticked is
 * completed even when its note says nothing.
 */
import { CANCEL_STATES, DONE_STATES, SLEEP_STATES } from "../categories.js";
import type { StatusWord } from "../ui/controls.js";

export type StatusId = "planned" | "on-track" | "at-risk" | "paused" | "completed" | "archived" | "cancelled";

/** The ontology's order, which is the menu's. */
export const STATUS_IDS: StatusId[] = ["planned", "on-track", "at-risk", "paused", "completed", "archived", "cancelled"];

/** The word on screen for each id (the `Status` component's vocabulary). */
export const STATUS_WORD: Record<StatusId, StatusWord> = {
  planned: "planned",
  "on-track": "on track",
  "at-risk": "at risk",
  paused: "paused",
  completed: "completed",
  archived: "archived",
  cancelled: "cancelled",
};

const ALIASES = new Map<string, StatusId>([
  ...STATUS_IDS.map((id) => [id, id] as const),
  ...Object.entries(STATUS_WORD).map(([id, word]) => [word, id as StatusId] as const),
  // The ontology's aliases (core ONTOLOGY_TEMPLATE).
  ["active", "on-track"],
  ["in-progress", "on-track"],
  ["blocked", "at-risk"],
  ["on hold", "paused"],
  ["finished", "completed"],
  // What the old status menu wrote.
  ["planning", "planned"],
  // Every spelling the board already parked, cancelled or finished a project on (categories.ts).
  ...[...SLEEP_STATES].map((s) => [s, "paused"] as const),
  ...[...CANCEL_STATES].map((s) => [s, "cancelled"] as const),
  ...[...DONE_STATES].map((s) => [s, "completed"] as const),
]);

/** A note's `status:` as one of the seven, or null: empty, or a word the vocabulary does not have. */
export function statusOf(raw: string | null | undefined): StatusId | null {
  const s = (raw ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  return ALIASES.get(s) ?? ALIASES.get(s.replace(/[ _]/g, "-")) ?? ALIASES.get(s.replace(/[-_]/g, " ")) ?? null;
}

export type Shelf = "active" | "paused" | "cancelled" | "completed" | "archived";

/**
 * Where a project sits. The note's word wins (a paused project stays paused with steps left, a
 * cancelled one never comes back on its own); otherwise every step ticked is completed, and a
 * project with no steps yet is active: nothing done is not nothing left.
 */
export function shelfOf(p: { status: string | null | undefined; total: number; done: number }): Shelf {
  const s = statusOf(p.status);
  if (s === "paused" || s === "cancelled" || s === "completed" || s === "archived") return s;
  return p.total > 0 && p.done >= p.total ? "completed" : "active";
}

/**
 * What is off about a project's status, in Orr's words, for the flag beside it (§2.4: a
 * project with no status carries Orr's head). The graph's own warnings are added by the caller.
 */
export function statusProblems(raw: string | null | undefined): string[] {
  if (!(raw ?? "").trim()) return ["No status yet: pick one."];
  if (!statusOf(raw)) return [`Its status “${String(raw).trim()}” is not one of the vault's words.`];
  return [];
}
