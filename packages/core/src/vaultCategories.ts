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
import { cells, isRule, mapHeader } from "./table.js";

export const VAULT_CATEGORY_IDS = ["school", "work", "knowledge", "tools", "personal"] as const;
export type VaultCategoryId = (typeof VAULT_CATEGORY_IDS)[number];

export interface VaultCategoryRule {
  id: VaultCategoryId;
  matches: (string | RegExp)[];
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

/** A `/regex/` item as a RegExp, or null when it does not compile. */
function regexOf(item: string): RegExp | null {
  const m = /^\/(.+)\/([a-z]*)$/.exec(item);
  if (!m) return null;
  try {
    return new RegExp(m[1]!, m[2]!.includes("i") ? m[2] : `${m[2]}i`);
  } catch {
    return null;
  }
}

/** The rules a note's `| Category | Matches |` table states, in order; [] if none. */
export function parseVaultCategoryRules(content: string): VaultCategoryRule[] {
  const out: VaultCategoryRule[] = [];
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
      if (mapped.includes("category") && mapped.includes("matches")) cols = mapped;
      continue;
    }
    const get = (k: string) => (row[cols!.indexOf(k)] ?? "").trim();
    const id = LABELS[get("category").toLowerCase()];
    if (!id) continue;
    const matches = get("matches")
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean)
      // `/…/flags` is a regex; anything else — `/agents` included — a phrase.
      .map((m) => (/^\/.+\/[a-z]*$/.test(m) ? regexOf(m) : m.toLowerCase()))
      .filter((m): m is string | RegExp => m !== null);
    if (matches.length) out.push({ id, matches });
  }
  return out;
}

/** The category of a note, from its path and tags. */
export function categorizeNote(note: { path: string; tags: readonly string[] }, rules: VaultCategoryRule[]): VaultCategoryId {
  const hay = `${note.path} ${note.tags.join(" ")}`.toLowerCase();
  for (const r of rules) {
    if (r.matches.some((m) => (typeof m === "string" ? hay.includes(m) : m.test(hay)))) return r.id;
  }
  return "personal";
}
