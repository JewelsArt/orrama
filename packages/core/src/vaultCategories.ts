/**
 * The life areas: a list the person names (Work, Family, Running…), in the order they are drawn,
 * and which area each note belongs to, for Planning's lanes, the Projects board, the Notes tree
 * and the Orrery.
 *
 * The list is data in the vault, like every other ledger: a note tagged `#vault-categories`
 * holding one table, a row per area, in order:
 *
 *     | Area     | Matches                   |
 *     | School   | universit, /\blaw\b/      |
 *     | Work     | scooperz, career          |
 *     | Family   |                           |
 *     | Personal | everything else           |
 *
 * Settings → Notes → Life areas writes it (and makes it in `Orrama/` when there is none); a
 * hand-written one reads the same. An area's id is its name's slug. Matches are optional words:
 * a case-insensitive substring of a note's path and tags, or a `/regex/`; the first row that
 * matches wins. One area is the catch-all, the one nothing else claims (its Matches cell says
 * "everything else"; without that, a row named Personal, else a Personal added at the end, which
 * is how a note written before areas were a list reads exactly as it did).
 *
 * A project's own note can say its area outright, `area: Family`, read before the words; the
 * `domain:` it may carry from before (academic, professional, personal) is read after them.
 * Without the note, a vault has Work and Personal (Jules, 23 Oct 2026).
 */
import { compileSafeRegex, type SafeRegex } from "./safeRegex.js";
import { spliceNoteLines, noteLines } from "./parse.js";
import { cells, isRule, mapHeader } from "./table.js";

/** The tag of the note that holds the list. */
export const LIFE_AREAS_TAG = "vault-categories";
/** Where Settings makes that note when the vault has none, beside the note that says what things are. */
export const LIFE_AREAS_PATH = "Orrama/Life areas.md";
/** What the catch-all's Matches cell says. */
export const CATCH_ALL_WORDS = "everything else";

export interface LifeArea {
  /** The name's slug: what a tree note's `category` and an address's `?area=` carry. */
  id: string;
  name: string;
  /** "Also put notes here when their folder or tags contain…": phrases and `/regex/`es, as written. */
  words: string[];
  /** The area for everything no other area claims. Exactly one per list. */
  catchAll: boolean;
}

export interface VaultCategoryRule {
  id: string;
  matches: (string | SafeRegex)[];
}

/** A vault with no areas note: Work, and Personal for the rest. */
export const STARTER_AREAS: readonly LifeArea[] = [
  { id: "work", name: "Work", words: [], catchAll: false },
  { id: "personal", name: "Personal", words: [], catchAll: true },
];

export const AREAS_MAX = 24;
export const AREA_NAME_MAX = 40;
export const AREA_WORD_MAX = 80;
export const AREA_WORDS_MAX = 60;

/**
 * What one rule set's regexes may cost together, in compiled instructions:
 * each character of a note's path and tags costs at most this much across
 * them all (safeRegex.ts). Regexes past it are dropped, like broken ones.
 */
export const REGEX_BUDGET = 2_000;
/** How much of a note's path and tags the regexes read: a fixed bound on one note's cost. */
export const REGEX_HAY = 512;

const HEADERS: Record<string, string> = { category: "category", area: "category", "life area": "category", matches: "matches", match: "matches" };

/** "Claude & tools" → "claude-tools", "École" → "ecole": an area's id. Never empty. */
export function areaSlug(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "area";
}

/**
 * A `/regex/` item, compiled by the linear-time matcher (safeRegex.ts), or
 * null when it does not compile or is outside what that matcher runs. Never a
 * native RegExp: note text decides the pattern, and one backtracking pattern
 * froze the tree for the whole vault (audit INP-003). `g`/`y` are dropped
 * (COR-020).
 */
function regexOf(item: string): SafeRegex | null {
  const m = /^\/(.+)\/([a-z]*)$/.exec(item);
  return m ? compileSafeRegex(m[1]!, m[2]!) : null;
}

const isRegexItem = (m: string) => /^\/.+\/[a-z]*$/.test(m);

/**
 * A Matches cell's items, split on commas — but a `/regex/` is one item
 * whatever commas it holds: `/ch(apter){1,2}/` was split into two broken
 * phrases (COR-020). An item starting with `/` runs to the first unescaped `/`
 * outside a class that is followed by flags and then a comma or the end; with
 * no such `/` it is a phrase (`/agents`).
 */
export function splitMatches(cell: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < cell.length) {
    while (i < cell.length && /\s/.test(cell[i]!)) i++;
    if (i >= cell.length) break;
    let end = -1;
    if (cell[i] === "/") {
      let inClass = false;
      for (let j = i + 1; j < cell.length; j++) {
        const c = cell[j];
        if (c === "\\") j++;
        else if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass && j > i + 1) {
          const tail = /^[a-z]*\s*(?:,|$)/.exec(cell.slice(j + 1));
          if (tail) {
            end = j + 1 + tail[0].replace(/,$/, "").length;
            break;
          }
        }
      }
    }
    if (end < 0) end = cell.indexOf(",", i) < 0 ? cell.length : cell.indexOf(",", i);
    const item = cell.slice(i, end).trim();
    if (item) out.push(item);
    i = cell[end] === "," ? end + 1 : end;
  }
  return out;
}

/** The area rows a note's tables state, in order, as written; null when it has no such table. */
function readRows(content: string): { name: string; matches: string }[] | null {
  let rows: { name: string; matches: string }[] | null = null;
  let cols: string[] | null = null;
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim().startsWith("|")) {
      cols = null;
      continue;
    }
    const row = cells(line);
    if (isRule(row)) continue;
    if (!cols) {
      const mapped = mapHeader(row, HEADERS);
      if (mapped.includes("category") && mapped.includes("matches")) {
        cols = mapped;
        rows ??= [];
      }
      continue;
    }
    const get = (k: string) => (row[cols!.indexOf(k)] ?? "").trim();
    rows!.push({ name: get("category"), matches: get("matches") });
  }
  return rows;
}

/**
 * The list a note's table states, in order, with exactly one catch-all; null when the note has
 * no `| Area | Matches |` table. Two rows with one slug are one area (the first's name, both
 * rows' words); a nameless row is skipped; past AREAS_MAX rows are dropped.
 */
export function parseLifeAreas(content: string): LifeArea[] | null {
  const rows = readRows(content);
  if (!rows) return null;
  const out: LifeArea[] = [];
  for (const r of rows) {
    const name = r.name.replace(/\s+/g, " ").trim().slice(0, AREA_NAME_MAX).trim();
    if (!name) continue;
    const id = areaSlug(name);
    const catchAll = r.matches.trim().toLowerCase() === CATCH_ALL_WORDS;
    const words = catchAll ? [] : splitMatches(r.matches);
    const same = out.find((a) => a.id === id);
    if (same) {
      same.words.push(...words);
      same.catchAll ||= catchAll;
      continue;
    }
    if (out.length >= AREAS_MAX) continue;
    out.push({ id, name, words, catchAll });
  }
  // One catch-all: the first marked, else the row named Personal, else a Personal at the end.
  const marked = out.findIndex((a) => a.catchAll);
  out.forEach((a, i) => (a.catchAll = i === marked));
  if (marked < 0) {
    const personal = out.find((a) => a.id === "personal");
    if (personal) personal.catchAll = true;
    else out.push({ id: "personal", name: "Personal", words: [], catchAll: true });
  }
  return out;
}

/** The list a vault has: its note's, or the starter list without one (or with an unreadable one). */
export function lifeAreasOf(content: string | null | undefined): LifeArea[] {
  const parsed = content == null ? null : parseLifeAreas(content);
  return parsed ?? STARTER_AREAS.map((a) => ({ ...a, words: [...a.words] }));
}

/** The catch-all's id. */
export const catchAllOf = (areas: readonly LifeArea[]): string => (areas.find((a) => a.catchAll) ?? areas[areas.length - 1])?.id ?? "personal";

/**
 * The areas' words as rules, in the list's order; areas without words have none. A regex that
 * does not compile, or one past the set's budget, is dropped.
 */
export function areaRules(areas: readonly LifeArea[]): VaultCategoryRule[] {
  let budget = REGEX_BUDGET;
  const out: VaultCategoryRule[] = [];
  for (const a of areas) {
    const matches = a.words
      // `/…/flags` is a regex; anything else — `/agents` included — a phrase.
      .map((m) => (isRegexItem(m) ? regexOf(m) : m.toLowerCase()))
      .filter((m): m is string | SafeRegex => m !== null && m !== "")
      .filter((m) => typeof m === "string" || (budget -= m.size) >= 0);
    if (matches.length) out.push({ id: a.id, matches });
  }
  return out;
}

/** The rules a note's table states, in order; [] if none. */
export function parseVaultCategoryRules(content: string): VaultCategoryRule[] {
  const areas = parseLifeAreas(content);
  return areas ? areaRules(areas) : [];
}

/** The area of a note, from its path and tags: the first rule that matches, else the catch-all. */
export function categorizeNote(note: { path: string; tags: readonly string[] }, rules: readonly VaultCategoryRule[], catchAll = "personal"): string {
  const hay = `${note.path} ${note.tags.join(" ")}`.toLowerCase();
  const regexHay = hay.slice(0, REGEX_HAY);
  for (const r of rules) {
    if (r.matches.some((m) => (typeof m === "string" ? hay.includes(m) : m.test(regexHay)))) return r.id;
  }
  return catchAll;
}

/** The area a project note names in `area:` (by name or id, any case), or null for none or one not in the list. */
export function namedAreaOf(frontmatter: Record<string, unknown> | null | undefined, areas: readonly LifeArea[]): string | null {
  const v = frontmatter?.["area"];
  if (typeof v !== "string" || !v.trim()) return null;
  const id = areaSlug(v);
  return areas.some((a) => a.id === id) ? id : null;
}

/** What a project's old `domain:` meant, as the board grouped by it before there were areas. */
const DOMAIN_AREA: Record<string, string> = { academic: "school", professional: "work" };

/** The area an old `domain:` puts a project in, when the list has it; null otherwise. */
export function domainAreaOf(frontmatter: Record<string, unknown> | null | undefined, areas: readonly LifeArea[]): string | null {
  const v = frontmatter?.["domain"];
  if (typeof v !== "string" || !v.trim()) return null;
  const word = v.trim().toLowerCase();
  if (word === "personal") return catchAllOf(areas);
  const id = DOMAIN_AREA[word] ?? areaSlug(word);
  return areas.some((a) => a.id === id) ? id : null;
}

/** Where a note's area comes from: what decides it, for the screens that move it. */
export type AreaSource = "named" | "words" | "domain" | "rest";

/**
 * The area of a note, and why. A project's own note (`project: true`) is first its `area:`;
 * every note then the words; a project's note still in the catch-all then its old `domain:`
 * (the order the board read them in before areas were a list); then the catch-all.
 */
export function areaOfNote(
  note: { path: string; tags: readonly string[]; frontmatter?: Record<string, unknown> | null; project?: boolean },
  areas: readonly LifeArea[],
  rules: readonly VaultCategoryRule[] = areaRules(areas),
): { id: string; source: AreaSource } {
  const rest = catchAllOf(areas);
  if (note.project) {
    const named = namedAreaOf(note.frontmatter, areas);
    if (named) return { id: named, source: "named" };
  }
  const byWords = categorizeNote(note, rules, "");
  if (byWords) return { id: byWords, source: "words" };
  if (note.project) {
    const domain = domainAreaOf(note.frontmatter, areas);
    if (domain) return { id: domain, source: "domain" };
  }
  return { id: rest, source: "rest" };
}

/** A word as it may stand in a Matches cell: a pipe would split the row and a newline end it; a comma splits a phrase. */
const asWord = (w: string) => (isRegexItem(w.trim()) ? w.trim().replace(/[\r\n]/g, "") : w.replace(/[|,\r\n]/g, " ").replace(/\s+/g, " ").trim());

/**
 * A list as a person sent it, cleaned (names collapsed and trimmed, words trimmed, empty words
 * dropped), or the sentence saying why it can't be written.
 */
export function cleanLifeAreas(input: readonly { name: string; words?: readonly string[]; catchAll?: boolean }[]): { ok: true; areas: LifeArea[] } | { ok: false; reason: string } {
  if (input.length === 0) return { ok: false, reason: "Keep at least one area." };
  if (input.length > AREAS_MAX) return { ok: false, reason: `At most ${AREAS_MAX} areas.` };
  const areas: LifeArea[] = [];
  for (const a of input) {
    const name = a.name.replace(/[|\r\n]/g, " ").replace(/\s+/g, " ").trim();
    if (!name) return { ok: false, reason: "Every area needs a name." };
    if (name.length > AREA_NAME_MAX) return { ok: false, reason: `An area's name is at most ${AREA_NAME_MAX} characters.` };
    const id = areaSlug(name);
    if (areas.some((x) => x.id === id)) return { ok: false, reason: `There are two areas called ${name}.` };
    if (name.toLowerCase() === CATCH_ALL_WORDS) return { ok: false, reason: `An area can't be called "${name}".` };
    const words = [...new Set((a.words ?? []).map(asWord).filter(Boolean))];
    if (words.length > AREA_WORDS_MAX) return { ok: false, reason: `At most ${AREA_WORDS_MAX} words per area.` };
    if (words.some((w) => w.length > AREA_WORD_MAX)) return { ok: false, reason: `A word is at most ${AREA_WORD_MAX} characters.` };
    if (words.some((w) => w.toLowerCase() === CATCH_ALL_WORDS)) return { ok: false, reason: `"${CATCH_ALL_WORDS}" can't be one of the words.` };
    areas.push({ id, name, words: a.catchAll ? [] : words, catchAll: !!a.catchAll });
  }
  const catchAlls = areas.filter((a) => a.catchAll).length;
  if (catchAlls !== 1) return { ok: false, reason: "One area takes everything else." };
  return { ok: true, areas };
}

/** The table's lines for a list. */
function tableLines(areas: readonly LifeArea[]): string[] {
  return ["| Area | Matches |", "| --- | --- |", ...areas.map((a) => `| ${a.name} | ${a.catchAll ? CATCH_ALL_WORDS : a.words.join(", ")} |`.replace(/ {2}\|$/, " |"))];
}

/** A new areas note for a vault that has none. */
export function lifeAreasNote(areas: readonly LifeArea[]): string {
  return [
    "---",
    "tags:",
    `  - ${LIFE_AREAS_TAG}`,
    "---",
    "# Life areas",
    "",
    "Your life areas, in the order Orrama draws them. Settings → Notes → Life areas changes them.",
    "",
    ...tableLines(areas),
    "",
  ].join("\n");
}

/**
 * The note's text with its table replaced by the list, everything around it kept byte for byte;
 * a note with no table gets one at its end. Refused when the table has columns of its own (they
 * would be lost) or the note holds two area tables (which one is the list?).
 */
export function writeLifeAreas(content: string, areas: readonly LifeArea[]): { ok: true; content: string } | { ok: false; reason: string } {
  const { lines } = noteLines(content);
  const tables: { headerAt: number; lastRowAt: number; extra: boolean }[] = [];
  let open: (typeof tables)[number] | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim().startsWith("|")) {
      open = null;
      continue;
    }
    const row = cells(line);
    if (open) {
      open.lastRowAt = i;
      continue;
    }
    if (isRule(row)) continue;
    const mapped = mapHeader(row, HEADERS);
    if (mapped.includes("category") && mapped.includes("matches")) {
      open = { headerAt: i, lastRowAt: i, extra: mapped.some((c) => c === "") };
      tables.push(open);
    }
  }
  if (tables.length > 1) return { ok: false, reason: "The areas note holds two area tables. Open it and keep one." };
  const t = tables[0];
  if (t?.extra) return { ok: false, reason: "The areas table has columns of its own. Open the note to change it." };
  if (!t) {
    // Before the final line ending (the empty last "line"), after a blank line.
    const end = lines.length && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
    const insert = [...(end > 0 && lines[end - 1]!.trim() ? [""] : []), ...tableLines(areas), ...(end === lines.length ? [""] : [])];
    return { ok: true, content: spliceNoteLines(content, end, end, insert) };
  }
  return { ok: true, content: spliceNoteLines(content, t.headerAt, t.lastRowAt + 1, tableLines(areas)) };
}
