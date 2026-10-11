/**
 * Which life-area a note belongs to — School, Work, Knowledge, Claude & tools,
 * or Personal (the catch-all) — for the Dashboard donut and the map's
 * category filter.
 *
 * The rules used to be regexes in the web bundle naming Jules's university,
 * employer and projects. They are now data in the vault, like every other
 * ledger: a note tagged `#vault-categories` holding
 *
 *     | Category | Matches |
 *     | School   | universit, resit, /\blaw\b/, amsib |
 *     | Work     | scooperz, career, linkedin |
 *
 * Each match is a case-insensitive substring of the note's path and tags, or
 * a `/regex/`. The first row that matches wins; nothing matching is Personal.
 * Without such a note, the defaults below only know the PARA folders.
 */
import { compileSafeRegex, type SafeRegex } from "./safeRegex.js";
import { cells, isRule, mapHeader } from "./table.js";

export const VAULT_CATEGORY_IDS = ["school", "work", "knowledge", "tools", "personal"] as const;
export type VaultCategoryId = (typeof VAULT_CATEGORY_IDS)[number];

export interface VaultCategoryRule {
  id: VaultCategoryId;
  matches: (string | SafeRegex)[];
}

export const DEFAULT_VAULT_CATEGORY_RULES: VaultCategoryRule[] = [
  { id: "knowledge", matches: ["03-knowledge", "knowledge/"] },
  { id: "tools", matches: ["07-claude", "claude sessions", "claude.md"] },
];

const HEADERS: Record<string, string> = { category: "category", area: "category", matches: "matches", match: "matches" };
const LABELS: Record<string, VaultCategoryId> = {
  school: "school",
  work: "work",
  knowledge: "knowledge",
  tools: "tools",
  "claude & tools": "tools",
  claude: "tools",
  personal: "personal",
};

/**
 * What one rule set's regexes may cost together, in compiled instructions:
 * each character of a note's path and tags costs at most this much across
 * them all (safeRegex.ts). Regexes past it are dropped, like broken ones.
 */
export const REGEX_BUDGET = 2_000;
/** How much of a note's path and tags the regexes read: a fixed bound on one note's cost. */
export const REGEX_HAY = 512;

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

/** The rules a note's `| Category | Matches |` table states, in order; [] if none. */
export function parseVaultCategoryRules(content: string): VaultCategoryRule[] {
  const out: VaultCategoryRule[] = [];
  let cols: string[] | null = null;
  let budget = REGEX_BUDGET;
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim().startsWith("|")) {
      cols = null;
      continue;
    }
    const row = cells(line);
    if (isRule(row)) continue;
    if (!cols) {
      const mapped = mapHeader(row, HEADERS);
      if (mapped.includes("category") && mapped.includes("matches")) cols = mapped;
      continue;
    }
    const get = (k: string) => (row[cols!.indexOf(k)] ?? "").trim();
    const id = LABELS[get("category").toLowerCase()];
    if (!id) continue;
    const matches = splitMatches(get("matches"))
      // `/…/flags` is a regex; anything else — `/agents` included — a phrase.
      .map((m) => (/^\/.+\/[a-z]*$/.test(m) ? regexOf(m) : m.toLowerCase()))
      .filter((m): m is string | SafeRegex => m !== null)
      .filter((m) => typeof m === "string" || (budget -= m.size) >= 0);
    if (matches.length) out.push({ id, matches });
  }
  return out;
}

/** The category of a note, from its path and tags. */
export function categorizeNote(note: { path: string; tags: readonly string[] }, rules: VaultCategoryRule[]): VaultCategoryId {
  const hay = `${note.path} ${note.tags.join(" ")}`.toLowerCase();
  const regexHay = hay.slice(0, REGEX_HAY);
  for (const r of rules) {
    if (r.matches.some((m) => (typeof m === "string" ? hay.includes(m) : m.test(regexHay)))) return r.id;
  }
  return "personal";
}
