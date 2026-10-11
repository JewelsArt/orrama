/**
 * Find's results (structure.md §2.12, board mockups/screens/find.html): what a query finds, typed
 * and grouped, each with its one line and the place it opens. Pure, so the palette and its tests
 * agree.
 *
 * Types follow the app's own pages (People's lists, the Projects board, saved chats), so a vault
 * without an ontology still finds people, companies and projects as themselves. Names are matched
 * here, every word of the query somewhere in the name (accents and case folded), the start of a
 * name or a word first; notes come from the server's search, which reads their text too. A
 * company that matches brings the people who work there and the projects it is in ("4 at Kade
 * Social"). A type typed first ("person ines") or picked with Tab narrows to that type.
 */
import type { Route } from "../ui/router.js";

export type FindType = "place" | "action" | "person" | "company" | "project" | "note" | "conversation" | "setting";

/** The types Tab cycles through, after "any". */
export const TYPES: FindType[] = ["person", "company", "project", "note", "conversation", "place", "setting", "action"];

export const TYPE_WORD: Record<FindType, string> = {
  place: "Place",
  action: "Action",
  person: "Person",
  company: "Company",
  project: "Project",
  note: "Note",
  conversation: "Conversation",
  setting: "Setting",
};

/** What a type is called when typed first: "person ines", "people kade", "project thesis". */
const TYPE_NAMES: Record<string, FindType> = {
  person: "person",
  people: "person",
  company: "company",
  companies: "company",
  project: "project",
  projects: "project",
  note: "note",
  notes: "note",
  conversation: "conversation",
  conversations: "conversation",
  chat: "conversation",
  place: "place",
  places: "place",
  setting: "setting",
  settings: "setting",
  action: "action",
  actions: "action",
};

export interface Lead {
  kind: "ring" | "square" | "progress" | "icon";
  /** The name for a ring or a square, the icon's name for an icon. */
  of: string;
  value?: number;
}

export interface Item {
  key: string;
  type: FindType;
  title: string;
  /** The one line under the name. */
  meta: string;
  lead: Lead;
  /** Where it opens; an action runs instead. */
  route?: Route;
  action?: string;
  /** A keycap shown with its type: a place's number. */
  keycap?: string;
  /** How well it matched, higher first. */
  score: number;
  /** The folder, said only when two results share a name. */
  folder?: string;
  /** Why a related result is here ("at Kade Social"). */
  via?: string;
}

export interface Group {
  id: string;
  label: string;
  /** The count, or why these are here ("4 at Kade Social"). */
  note: string;
  items: Item[];
}

export const fold = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();

/** The query as words, and the type it starts with if it starts with one. */
export function parseQuery(q: string, type: FindType | null): { words: string[]; type: FindType | null; raw: string } {
  const words = fold(q).split(/\s+/).filter(Boolean);
  if (!type && words.length > 0 && TYPE_NAMES[words[0]!]) {
    return { words: words.slice(1), type: TYPE_NAMES[words[0]!]!, raw: q.trim().split(/\s+/).slice(1).join(" ") };
  }
  return { words, type, raw: q.trim() };
}

/** A query the server's search reads itself (`tag:project`, `path:eng`): notes only, as before. */
export const isFilterQuery = (q: string) => /(^|\s)(tag|path|task|assignee):\S/i.test(q);

/**
 * How well a name matches every word: the whole name 100, its start 80, a word's start 60,
 * somewhere 40; the one line counts for 15 when the name does not hold every word. 0 is no match.
 */
export function scoreOf(words: string[], title: string, meta = ""): number {
  if (words.length === 0) return 0;
  const t = fold(title);
  const q = words.join(" ");
  if (!words.every((w) => t.includes(w))) {
    const m = fold(`${title} ${meta}`);
    return words.every((w) => m.includes(w)) ? 15 : 0;
  }
  if (t === q) return 100;
  if (t.startsWith(q)) return 80;
  const starts = t.split(/[^\p{L}\p{N}]+/u);
  if (words.every((w) => starts.some((s) => s.startsWith(w)))) return 60;
  return 40;
}

/** The match in a name, for its underline: [before, match, after], or null. */
export function markOf(title: string, words: string[]): [string, string, string] | null {
  const w = words[0];
  if (!w) return null;
  const i = fold(title).indexOf(w);
  // Folding keeps a letter's position for the scripts a name is typed in; when it does not, no mark.
  if (i < 0 || fold(title).length !== title.length) return null;
  return [title.slice(0, i), title.slice(i, i + w.length), title.slice(i + w.length)];
}

/** Several results with one name: each says its folder, quietly. Otherwise no paths. */
export function withFolders(items: Item[]): Item[] {
  const count = new Map<string, number>();
  for (const it of items) count.set(fold(it.title), (count.get(fold(it.title)) ?? 0) + 1);
  return items.map((it) => (it.folder && (count.get(fold(it.title)) ?? 0) > 1 ? it : { ...it, folder: undefined }));
}

const ORDER: Record<string, number> = { places: 0, people: 1, companies: 2, projects: 3, notes: 4, settings: 5, actions: 6 };
const GROUP_OF: Record<FindType, string> = { place: "places", action: "actions", person: "people", company: "companies", project: "projects", note: "notes", conversation: "notes", setting: "settings" };
const GROUP_LABEL: Record<string, string> = { places: "Places", people: "People", companies: "Companies", projects: "Projects", notes: "Notes and conversations", settings: "Settings", actions: "Actions" };

/**
 * Results in groups: the group with the best match first (a company called "Kade" before the 38
 * notes that say it), then the board's order; actions last. Each group sorted by score, then name.
 * `limits` caps a group's rows when nothing narrows the type.
 */
export function groupsOf(items: Item[], opts: { limit?: number; viaNote?: Record<string, string> } = {}): Group[] {
  const by = new Map<string, Item[]>();
  for (const it of items) (by.get(GROUP_OF[it.type]) ?? by.set(GROUP_OF[it.type], []).get(GROUP_OF[it.type])!).push(it);
  const groups: Group[] = [...by].map(([id, list]) => {
    const sorted = [...list].sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
    const shown = opts.limit ? sorted.slice(0, opts.limit) : sorted;
    return { id, label: GROUP_LABEL[id]!, note: opts.viaNote?.[id] ?? String(list.length), items: withFolders(shown) };
  });
  const best = (g: Group) => Math.max(...g.items.map((i) => i.score));
  return groups.sort((a, b) => {
    if (a.id === "actions" || b.id === "actions") return a.id === "actions" ? 1 : -1;
    return best(b) - best(a) || ORDER[a.id]! - ORDER[b.id]!;
  });
}

/** The rows in the order the arrow keys move through them. */
export const flat = (groups: Group[]): Item[] => groups.flatMap((g) => g.items);

/** The next type for Tab (Shift+Tab goes back): any → person → company → … → action → any. */
export function nextType(t: FindType | null, back = false): FindType | null {
  const all: (FindType | null)[] = [null, ...TYPES];
  const i = all.indexOf(t);
  return all[(i + (back ? all.length - 1 : 1)) % all.length]!;
}

/* ---- recent picks, kept on this device ----------------------------------------------------- */

export interface Recent {
  key: string;
  type: FindType;
  title: string;
  meta: string;
  lead: Lead;
  route: Route;
}

export const RECENT_MAX = 6;

/** A pick goes to the top of the recent list, once. Actions are not kept: they are always offered. */
export function remember(list: Recent[], it: Item): Recent[] {
  if (!it.route || it.type === "action") return list;
  const r: Recent = { key: it.key, type: it.type, title: it.title, meta: it.meta, lead: it.lead, route: it.route };
  return [r, ...list.filter((x) => x.key !== it.key)].slice(0, RECENT_MAX);
}
