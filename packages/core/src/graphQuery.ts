/**
 * Questions a model (or a person) asks the knowledge graph, answered compactly
 * and with provenance — so it reads only the note it needs. Pure functions
 * over a built KnowledgeGraph (graph.ts); the server and the MCP only resolve
 * references and shape the transport. Names mirror the tools: vault_schema,
 * find_entities, get_relations, find_path, list_summaries.
 *
 * Every answer is bounded: lists carry a `total` and are cut at a limit, so a
 * big vault cannot turn a question into a transcript.
 */
import type { Entity, Fact, FactVia, KnowledgeGraph } from "./graph.js";
import type { NoteId } from "./types.js";

export interface Brief {
  id: NoteId;
  title: string;
  type: string;
}

const brief = (e: Entity): Brief => ({ id: e.id, title: e.title, type: e.type });
const fold = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();

// ── vault_schema ──────────────────────────────────────────────────────────

export interface VaultSchema {
  notes: number;
  types: { id: string; count: number; description: string }[];
  relations: { id: string; domain: string[]; range: string[]; inverse?: string; count: number; description: string }[];
  derived: { id: string; meaning: string; count: number }[];
  statuses: { id: string; count: number }[];
  mostConnected: (Brief & { connections: number })[];
  warnings: { code: string; count: number }[];
}

export function vaultSchema(g: KnowledgeGraph): VaultSchema {
  const count = (rel: string) => g.facts.filter((f) => f.relation === rel).length;
  const typeCounts = new Map<string, number>();
  const statusCounts = new Map<string, number>();
  for (const e of g.entities.values()) {
    typeCounts.set(e.type, (typeCounts.get(e.type) ?? 0) + 1);
    if (e.type === "project" && e.status) statusCounts.set(e.status, (statusCounts.get(e.status) ?? 0) + 1);
  }
  const degree = new Map<NoteId, number>();
  for (const f of g.facts) if (f.via !== "derived") degree.set(f.subject, (degree.get(f.subject) ?? 0) + 1);
  const warnings = new Map<string, number>();
  for (const w of g.warnings) warnings.set(w.code, (warnings.get(w.code) ?? 0) + 1);
  const statusOrder = g.ontology.statuses.map((s) => s.id);
  return {
    notes: g.entities.size,
    types: [
      ...g.ontology.types.map((t) => ({ id: t.id, count: typeCounts.get(t.id) ?? 0, description: t.description })),
      ...(typeCounts.get("note") ? [{ id: "note", count: typeCounts.get("note")!, description: "any other note" }] : []),
    ],
    relations: g.ontology.relations.map((r) => ({
      id: r.id,
      domain: r.domain,
      range: r.range,
      ...(r.inverse ? { inverse: r.inverse } : {}),
      count: count(r.id),
      description: r.description,
    })),
    derived: g.ontology.rules.filter((r) => r.kind === "derive").map((r) => ({ id: r.id, meaning: r.meaning, count: count(r.id) })),
    statuses: [...statusCounts].map(([id, n]) => ({ id, count: n })).sort((a, b) => statusOrder.indexOf(a.id) - statusOrder.indexOf(b.id)),
    mostConnected: [...degree]
      .sort((a, b) => b[1] - a[1] || (g.entities.get(a[0])!.title < g.entities.get(b[0])!.title ? -1 : 1))
      .slice(0, 10)
      .map(([id, n]) => ({ ...brief(g.entities.get(id)!), connections: n })),
    warnings: [...warnings].map(([code, n]) => ({ code, count: n })).sort((a, b) => b.count - a.count),
  };
}

// ── find_entities ─────────────────────────────────────────────────────────

export interface EntityFilter {
  type?: string;
  status?: string;
  /** Substring of the title or summary. */
  text?: string;
  /** Field equals value (case- and accent-folded); a leading `~` makes the value a substring. */
  where?: Record<string, string>;
  /** Has this relation to that note: { relation: "works_at", to: <id> }. */
  relation?: { relation: string; to: NoteId };
  limit?: number;
}

export interface EntityRow extends Brief {
  status?: string;
  summary: string;
  fields: Record<string, string>;
}

export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;
const clamp = (n: number | undefined, dflt: number, max: number) => Math.max(1, Math.min(max, Math.floor(n ?? dflt)));

export function fieldMatches(have: string | undefined, want: string): boolean {
  if (have === undefined) return false;
  const h = fold(have);
  if (want.startsWith("~")) return h.includes(fold(want.slice(1)));
  return h === fold(want) || h.split(/\s*,\s*/).includes(fold(want));
}

export function findEntities(g: KnowledgeGraph, f: EntityFilter): { total: number; entities: EntityRow[] } {
  const related = f.relation ? new Set(g.facts.filter((x) => x.relation === f.relation!.relation && x.object === f.relation!.to).map((x) => x.subject)) : null;
  const hits = [...g.entities.values()].filter((e) => {
    if (f.type && e.type !== fold(f.type)) return false;
    if (f.status && e.status !== fold(f.status)) return false;
    if (f.text && !fold(`${e.title} ${e.summary}`).includes(fold(f.text))) return false;
    for (const [k, v] of Object.entries(f.where ?? {})) if (!fieldMatches(k === "title" ? e.title : e.fields[fold(k)], v)) return false;
    if (related && !related.has(e.id)) return false;
    return true;
  });
  hits.sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
  const rows = hits.slice(0, clamp(f.limit, DEFAULT_LIMIT, MAX_LIMIT)).map((e): EntityRow => {
    const { description: _d, summary: _s, ...fields } = e.fields; // the summary is its own field
    return { ...brief(e), ...(e.status ? { status: e.status } : {}), summary: e.summary, fields };
  });
  return { total: hits.length, entities: rows };
}

// ── get_relations ─────────────────────────────────────────────────────────

export interface RelatedTo extends Brief {
  via: FactVia;
  /** Where the fact was read: a field, `## People`, `tag project/x`, `line 12`. */
  where: string;
  /** The note that says so. */
  source: { id: NoteId; title: string };
  /** Resolved from a plain string, not a link. */
  text?: true;
  /** For a derived fact: what it went through. */
  through?: { id: NoteId; title: string }[];
}

export interface RelationsAnswer {
  entity: Brief & { status?: string; summary: string; fields: Record<string, string> };
  relations: { relation: string; to: RelatedTo[] }[];
  warnings: string[];
}

export function getRelations(g: KnowledgeGraph, id: NoteId, relation?: string): RelationsAnswer | null {
  const e = g.entities.get(id);
  if (!e) return null;
  const by = new Map<string, RelatedTo[]>();
  for (const f of g.from(id, relation ? fold(relation) : undefined)) {
    const o = g.entities.get(f.object);
    const s = g.entities.get(f.source);
    if (!o || !s) continue;
    const row: RelatedTo = {
      ...brief(o),
      via: f.via,
      where: f.where,
      source: { id: s.id, title: s.title },
      ...(f.text ? { text: true as const } : {}),
      ...(f.chain ? { through: f.chain.map((c) => ({ id: c, title: g.entities.get(c)?.title ?? c })) } : {}),
    };
    (by.get(f.relation) ?? by.set(f.relation, []).get(f.relation)!).push(row);
  }
  for (const rows of by.values()) rows.sort((a, b) => (a.title < b.title ? -1 : 1));
  const { description: _d, ...fields } = e.fields;
  return {
    entity: { ...brief(e), ...(e.status ? { status: e.status } : {}), summary: e.summary, fields },
    relations: [...by].map(([r, to]) => ({ relation: r, to })).sort((a, b) => (a.relation < b.relation ? -1 : 1)),
    warnings: g.warnings.filter((w) => w.note === id).map((w) => w.message),
  };
}

// ── find_path ─────────────────────────────────────────────────────────────

export interface PathStep {
  from: Brief;
  relation: string;
  to: Brief;
  via: FactVia;
  where: string;
}

export const MAX_DEPTH = 6;

/**
 * The shortest typed connections between two notes — never through a derived
 * fact (a shortcut that hides the real chain). Each path is a list of steps;
 * up to `limit` paths of the shortest length.
 */
export function findPath(g: KnowledgeGraph, from: NoteId, to: NoteId, opts: { maxDepth?: number; limit?: number } = {}): { found: boolean; length?: number; paths: PathStep[][] } {
  if (!g.entities.has(from) || !g.entities.has(to) || from === to) return { found: false, paths: [] };
  const maxDepth = clamp(opts.maxDepth, 4, MAX_DEPTH);
  const limit = clamp(opts.limit, 3, 5);
  const adj = new Map<NoteId, Fact[]>();
  for (const f of g.facts) if (f.via !== "derived") (adj.get(f.subject) ?? adj.set(f.subject, []).get(f.subject)!).push(f);

  // BFS by layers, remembering EVERY shortest-way-in so all shortest paths can be walked back.
  const dist = new Map<NoteId, number>([[from, 0]]);
  const parents = new Map<NoteId, Fact[]>();
  let layer = [from];
  for (let d = 1; d <= maxDepth && layer.length && !dist.has(to); d++) {
    const next: NoteId[] = [];
    for (const n of layer) {
      for (const f of adj.get(n) ?? []) {
        const seen = dist.get(f.object);
        if (seen === undefined) {
          dist.set(f.object, d);
          parents.set(f.object, [f]);
          next.push(f.object);
        } else if (seen === d) parents.get(f.object)!.push(f);
      }
    }
    layer = next;
  }
  if (!dist.has(to)) return { found: false, paths: [] };

  const step = (f: Fact): PathStep => ({
    from: brief(g.entities.get(f.subject)!),
    relation: f.relation,
    to: brief(g.entities.get(f.object)!),
    via: f.via,
    where: f.where,
  });
  const out: PathStep[][] = [];
  const walk = (node: NoteId, acc: Fact[]) => {
    if (out.length >= limit) return;
    if (node === from) {
      out.push([...acc].reverse().map(step));
      return;
    }
    for (const f of parents.get(node) ?? []) walk(f.subject, [...acc, f]);
  };
  walk(to, []);
  return { found: true, length: dist.get(to), paths: out };
}

// ── list_summaries ────────────────────────────────────────────────────────

export interface SummaryFilter {
  type?: string;
  status?: string;
  /** Only notes about / related by `about` to this note. */
  about?: NoteId;
  text?: string;
  /** Inclusive ISO dates against the note's `date:` field. */
  from?: string;
  to?: string;
  limit?: number;
}

export interface SummaryRow {
  id: NoteId;
  /** Left out when the list is filtered to one type — every row would repeat it. */
  type?: string;
  title: string;
  date?: string;
  status?: string;
  about?: { id: NoteId; title: string };
  summary: string;
}

const TITLE_MAX = 80;
export const SUMMARY_DEFAULT = 100;
export const SUMMARY_MAX = 200;

export function listSummaries(g: KnowledgeGraph, f: SummaryFilter): { total: number; items: SummaryRow[] } {
  const aboutOf = new Map<NoteId, NoteId>();
  for (const x of g.facts) if (x.relation === "about" && !aboutOf.has(x.subject)) aboutOf.set(x.subject, x.object);
  const hits = [...g.entities.values()].filter((e) => {
    if (f.type && e.type !== fold(f.type)) return false;
    if (f.status && e.status !== fold(f.status)) return false;
    if (f.about && aboutOf.get(e.id) !== f.about) return false;
    if (f.text && !fold(`${e.title} ${e.summary}`).includes(fold(f.text))) return false;
    const date = e.fields["date"];
    if ((f.from || f.to) && (!date || (f.from && date < f.from) || (f.to && date > f.to))) return false;
    return true;
  });
  hits.sort((a, b) => (b.fields["date"] ?? "").localeCompare(a.fields["date"] ?? "") || (a.title < b.title ? -1 : 1));
  const items = hits.slice(0, clamp(f.limit, SUMMARY_DEFAULT, SUMMARY_MAX)).map((e): SummaryRow => {
    const a = aboutOf.get(e.id) ? g.entities.get(aboutOf.get(e.id)!) : undefined;
    return {
      id: e.id,
      ...(f.type ? {} : { type: e.type }),
      title: e.title.length > TITLE_MAX ? `${e.title.slice(0, TITLE_MAX - 1).trimEnd()}…` : e.title,
      ...(e.fields["date"] ? { date: e.fields["date"] } : {}),
      ...(e.status ? { status: e.status } : {}),
      ...(a ? { about: { id: a.id, title: a.title } } : {}),
      summary: e.summary,
    };
  });
  return { total: hits.length, items };
}
