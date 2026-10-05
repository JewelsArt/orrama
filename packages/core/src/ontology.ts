/**
 * The vault's ontology — what kinds of things its notes are, how they relate,
 * and which rules the relations obey — as DATA in a note, like the life-area
 * rules in vaultCategories.ts. A note tagged `#vault-ontology` holds four
 * tables, all hand-editable in Obsidian:
 *
 *     | Type     | Matches                              | Description |
 *     | project  | folder:04-Projects + tag:project/*   | …           |
 *
 *     | Relation | Domain   | Range           | Inverse    | Fields  | Also from        | Description |
 *     | works_at | person   | company         | employs    | company |                  | …           |
 *
 *     | Status    | Aliases           | Meaning |
 *     | paused    | sleeping, on hold | …       |
 *
 *     | Rule              | Kind   | Meaning                          |
 *     | involves_company  | derive | involves . works_at (inverse: …) |
 *     | person-without-company | warn | …                            |
 *
 * `Matches` conditions: `tag:x` (or `tag:x/*`), `folder:x` (or `folder:x/*`),
 * `field:x` (front matter has it), `type:x` (front-matter `type`), `kind:conversation`.
 * A comma is OR, a `+` is AND; the first row that matches wins. Without the
 * note nothing is typed: the ontology is the vault's to define, not ours.
 *
 * Markdown stays the truth. Nothing here is stored; graph.ts rebuilds every
 * fact from the notes each time (delete the DB, re-index, it all comes back).
 */
import { cells, isRule } from "./table.js";

/** One AND-group of conditions; a type matches when any group does. */
export type Condition = string;
export interface TypeDef {
  id: string;
  matches: Condition[][];
  description: string;
}
export interface RelationDef {
  id: string;
  domain: string[];
  range: string[];
  inverse?: string;
  /** Front-matter keys and `key:: value` inline fields that write this relation. */
  fields: string[];
  /** Other places it is read from: `section:People`, `tag:project/*`. */
  also: string[];
  description: string;
}
export interface StatusDef {
  id: string;
  aliases: string[];
  meaning: string;
}
export interface RuleDef {
  id: string;
  kind: "derive" | "warn";
  meaning: string;
}
export interface Ontology {
  types: TypeDef[];
  relations: RelationDef[];
  statuses: StatusDef[];
  rules: RuleDef[];
}

export const EMPTY_ONTOLOGY: Ontology = { types: [], relations: [], statuses: [], rules: [] };
export const FALLBACK_TYPE = "note";
/** The tag that marks the ontology note. */
export const ONTOLOGY_TAG = "vault-ontology";

const clean = (s: string) => s.replace(/`/g, "").trim();
const list = (s: string) => s.split(",").map(clean).filter(Boolean);
const lower = (s: string) => s.toLowerCase();

/** Every `| … |` block of a note as {header, rows}, headers lower-cased. */
function readTables(content: string): { header: string[]; rows: string[][] }[] {
  const out: { header: string[]; rows: string[][] }[] = [];
  let cur: { header: string[]; rows: string[][] } | null = null;
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim().startsWith("|")) {
      cur = null;
      continue;
    }
    const row = cells(line);
    if (isRule(row)) continue;
    if (!cur) {
      cur = { header: row.map((c) => c.toLowerCase().replace(/[^a-z ]/g, "").trim()), rows: [] };
      out.push(cur);
    } else cur.rows.push(row);
  }
  return out;
}

/** Parse the four tables of an ontology note. Unknown or half-filled rows are skipped, not fatal. */
export function parseOntology(content: string): Ontology {
  const o: Ontology = { types: [], relations: [], statuses: [], rules: [] };
  for (const t of readTables(content)) {
    const col = (name: string) => t.header.indexOf(name);
    const get = (row: string[], name: string) => (col(name) === -1 ? "" : (row[col(name)] ?? "").trim());
    if (col("type") !== -1 && col("matches") !== -1) {
      for (const row of t.rows) {
        const id = lower(clean(get(row, "type")));
        const matches = get(row, "matches")
          .split(",")
          .map((alt) => alt.split("+").map(clean).filter(Boolean))
          .filter((g) => g.length > 0);
        if (id && id !== FALLBACK_TYPE) o.types.push({ id, matches, description: get(row, "description") });
      }
    } else if (col("relation") !== -1 && col("domain") !== -1 && col("range") !== -1) {
      for (const row of t.rows) {
        const id = lower(clean(get(row, "relation")));
        const domain = list(get(row, "domain")).map(lower);
        const range = list(get(row, "range")).map(lower);
        if (!id || !domain.length || !range.length) continue;
        const inverse = lower(clean(get(row, "inverse")));
        o.relations.push({
          id,
          domain,
          range,
          ...(inverse ? { inverse } : {}),
          fields: list(get(row, "fields")).map(lower),
          also: list(get(row, "also from")).map(lower),
          description: get(row, "description"),
        });
      }
    } else if (col("status") !== -1 && col("aliases") !== -1) {
      for (const row of t.rows) {
        const id = lower(clean(get(row, "status")));
        if (id) o.statuses.push({ id, aliases: list(get(row, "aliases")).map(lower), meaning: get(row, "meaning") });
      }
    } else if (col("rule") !== -1 && col("kind") !== -1) {
      for (const row of t.rows) {
        const id = lower(clean(get(row, "rule")));
        const kind = lower(clean(get(row, "kind")));
        if (id && (kind === "derive" || kind === "warn")) o.rules.push({ id, kind, meaning: get(row, "meaning") });
      }
    }
  }
  return o;
}

interface NoteLike {
  path: string;
  folder: string;
  tags: readonly { tag: string }[];
  frontmatter: Record<string, unknown>;
  kind: "note" | "conversation";
}

const nonEmpty = (v: unknown) => v !== undefined && v !== null && !(typeof v === "string" && v.trim() === "") && !(Array.isArray(v) && v.length === 0);

function holds(cond: Condition, note: NoteLike): boolean {
  const at = cond.indexOf(":");
  if (at === -1) return false;
  const kind = lower(cond.slice(0, at).trim());
  const arg = lower(cond.slice(at + 1).trim());
  const prefix = arg.endsWith("/*") ? arg.slice(0, -2) : null;
  switch (kind) {
    case "tag":
      return note.tags.some(({ tag }) => (prefix !== null ? tag.startsWith(`${prefix}/`) : tag === arg || tag.startsWith(`${arg}/`)));
    case "folder": {
      const f = lower(note.folder);
      return prefix !== null ? f === prefix || f.startsWith(`${prefix}/`) : f === arg;
    }
    case "field":
      return Object.entries(note.frontmatter).some(([k, v]) => lower(k) === arg && nonEmpty(v));
    case "type":
      return lower(String(note.frontmatter["type"] ?? "")) === arg;
    case "kind":
      return note.kind === arg;
    default:
      return false;
  }
}

/**
 * What a note is. A front-matter `type:` naming a type of the ontology wins
 * (that is how a note says so itself); otherwise the first row whose
 * conditions hold; otherwise a plain `note`.
 */
export function typeOfNote(note: NoteLike, ontology: Ontology): string {
  const declared = lower(String(note.frontmatter["type"] ?? "").trim());
  if (declared && ontology.types.some((t) => t.id === declared)) return declared;
  for (const t of ontology.types) {
    if (t.matches.some((group) => group.every((c) => holds(c, note)))) return t.id;
  }
  return FALLBACK_TYPE;
}

/**
 * The ontology Jules approved on 5 Oct 2026, as the note's own text. The
 * vault copy is the one that counts; this is what a fresh vault, the
 * backfill and the tests start from.
 */
export const ONTOLOGY_TEMPLATE = `---
tags:
  - vault-ontology
---
# Vault ontology

What the notes in this vault are and how they connect. Basalt reads these tables
(\`#vault-ontology\`); edit them here. A comma is "or", a \`+\` is "and"; the first
type row that matches wins. A note can also say \`type: person\` itself.

## Types

| Type | Matches | Description |
| --- | --- | --- |
| person | tag:contact, folder:01-Me/Contacts | someone Jules knows |
| company | tag:company, folder:Contacts/Companies | an organisation |
| project | folder:04-Projects + tag:project/* | the note that is a project |
| document | tag:project/* | any other note that belongs to a project |
| area | folder:02-Areas | an ongoing area of life or work |
| conversation | kind:conversation | a saved Claude conversation |

## Relations

| Relation | Domain | Range | Inverse | Fields | Also from | Description |
| --- | --- | --- | --- | --- | --- | --- |
| works_at | person | company | employs | company, works_at | | where someone works |
| involves | project | person, company | involved_in | involves | section:People | who or what a project involves |
| part_of | document | project | has_part | part_of | tag:project/* | which project a note belongs to |
| about | conversation | project, area, company, person | discussed_in | about, project | | what a conversation is about |
| supervises | person | project | supervised_by | supervises | | who supervises a project |

## Statuses

| Status | Aliases | Meaning |
| --- | --- | --- |
| planned | | not started |
| on-track | active, in-progress | moving as planned |
| at-risk | blocked | needs attention |
| paused | sleeping, on hold | set aside for now |
| completed | done, finished | finished |
| archived | | kept, no longer live |
| cancelled | | dropped |

## Rules

| Rule | Kind | Meaning |
| --- | --- | --- |
| involves_company | derive | involves . works_at (inverse: company_involved_in) |
| person-without-company | warn | a person with no company |
| conversation-without-about | warn | a conversation that is about nothing |
| project-without-status | warn | a project with no status |
| project-status-conflict | warn | a project whose status field and tags disagree |
| document-orphan | warn | a note tagged for a project that has no project note |
| unresolved-object | warn | a relation pointing at something that is not a note |
| range-mismatch | warn | a relation pointing at the wrong kind of note |
`;
