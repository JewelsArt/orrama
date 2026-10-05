/**
 * The vault as a knowledge graph: typed entities and subject–relation–object
 * facts, read off the notes under the vault's own ontology (ontology.ts).
 *
 * A pure index. Nothing is stored: every fact is recomputed from the Markdown,
 * so deleting the database and re-indexing brings the whole graph back, and
 * Obsidian keeps working on the same files. Every fact carries its provenance
 * (the note it was read from, and the field, section, tag or line), so a model
 * that is told "Ruben works at Scooperz" can be shown where.
 *
 * Where relations are read from:
 *  - front matter — `company: "[[Scooperz]]"`; a plain string is resolved by
 *    title too (flagged `text`), a list is several objects;
 *  - Dataview inline fields in the body — `supervises:: [[Internship Defense]]`;
 *  - a section the ontology names — `section:People` reads the `## People` links;
 *  - a tag family — `tag:project/*` makes a note part of the project note
 *    carrying the same `project/<key>`.
 * A saved conversation counts by its front matter only (its text is a
 * transcript, see ParsedNote.kind).
 *
 * Then: inverses (written once, visible from both ends), derived relations
 * (`involves . works_at`), and constraint warnings. Objects resolve with the
 * ordinary link rules, so a note renamed keeps its facts.
 *
 * ACL: `readable` restricts BOTH ends. A fact whose subject or object the
 * caller cannot read does not exist for them — never confirm existence (§5.4).
 */
import { describeNote } from "./describe.js";
import { readSection } from "./sections.js";
import { FALLBACK_TYPE, typeOfNote, type Ontology, type RelationDef } from "./ontology.js";
import type { IndexedNote, NoteId } from "./types.js";
import type { VaultIndex } from "./vault.js";

export interface Entity {
  id: NoteId;
  title: string;
  path: string;
  type: string;
  /** Canonical status (the ontology's vocabulary), when the note has one. */
  status?: string;
  /** One line about the note (describeNote): its own `description:`, else extractive. */
  summary: string;
  /** The note's scalar front-matter fields, as text — `deadline`, `location`, `role`… */
  fields: Record<string, string>;
}

export type FactVia = "field" | "inline" | "section" | "tag" | "inverse" | "derived";

export interface Fact {
  subject: NoteId;
  relation: string;
  object: NoteId;
  via: FactVia;
  /** The note the fact was read from. */
  source: NoteId;
  /** Where in it: the field name, `## People`, `tag project/x`, `line 12`. */
  where: string;
  /** Resolved from a plain string, not a `[[link]]` — works until the note is linked properly. */
  text?: true;
  /** For a derived fact: the notes it went through. */
  chain?: NoteId[];
}

export type WarningCode =
  | "person-without-company"
  | "conversation-without-about"
  | "project-without-status"
  | "project-status-conflict"
  | "document-orphan"
  | "unresolved-object"
  | "range-mismatch";

export interface GraphWarning {
  code: WarningCode;
  note: NoteId;
  message: string;
}

export interface BuildOptions {
  /** Only these notes exist (the caller's ACL). Default: all. */
  readable?: (note: IndexedNote) => boolean;
}

export class KnowledgeGraph {
  constructor(
    readonly ontology: Ontology,
    readonly entities: Map<NoteId, Entity>,
    readonly facts: Fact[],
    readonly warnings: GraphWarning[],
  ) {}

  /** Facts with this note as subject (inverses included), optionally one relation. */
  from(id: NoteId, relation?: string): Fact[] {
    return this.facts.filter((f) => f.subject === id && (!relation || f.relation === relation));
  }
}

const LINK_RE = /\[\[([^\[\]|#]+)(?:#[^\[\]|]*)?(?:\|[^\[\]]*)?\]\]/g;
const INLINE_RE = /^\s*([A-Za-z_][\w-]*)::\s*(.+?)\s*$/;
const FENCE_RE = /^(```|~~~)/;
const RESERVED_FIELDS = new Set(["id", "title", "tags", "aliases", "type"]);
const lower = (s: string) => s.toLowerCase();

/** Strings and nested lists of strings, flattened — `[[X]]` unquoted in YAML is a list in a list. */
function flatStrings(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (typeof v === "number") return [String(v)];
  if (Array.isArray(v)) return v.flatMap(flatStrings);
  return [];
}

/** The note names in a value: its `[[links]]`, else the whole string as written. */
function targetsIn(value: string): { target: string; text: boolean }[] {
  const links = [...value.matchAll(LINK_RE)].map((m) => ({ target: m[1]!.trim(), text: false }));
  if (links.length) return links;
  const t = value.trim();
  return t ? [{ target: t, text: true }] : [];
}

export function buildGraph(index: VaultIndex, ontology: Ontology, opts: BuildOptions = {}): KnowledgeGraph {
  const notes = index.all().filter((n) => !opts.readable || opts.readable(n));
  const visible = new Set(notes.map((n) => n.id));
  const warnings: GraphWarning[] = [];
  const rule = (code: WarningCode) => ontology.rules.some((r) => r.kind === "warn" && r.id === code);
  const warn = (code: WarningCode, note: IndexedNote, message: string) => {
    if (rule(code)) warnings.push({ code, note: note.id, message });
  };

  // ── entities ──────────────────────────────────────────────────────────
  const entities = new Map<NoteId, Entity>();
  const statusOf = (alias: string): string | undefined =>
    ontology.statuses.find((s) => s.id === alias || s.aliases.includes(alias))?.id;
  for (const n of notes) {
    const type = typeOfNote(n, ontology);
    const fields: Record<string, string> = {};
    for (const [k, v] of Object.entries(n.frontmatter)) {
      if (RESERVED_FIELDS.has(lower(k))) continue;
      const s = flatStrings(v).join(", ").trim();
      if (s) fields[lower(k)] = s;
    }
    const entity: Entity = { id: n.id, title: n.title, path: n.path, type, summary: describeNote(n), fields };

    if (type === "project" || "status" in fields) {
      const declared = fields["status"] ? lower(fields["status"]) : undefined;
      const fromField = declared ? (statusOf(declared) ?? declared) : undefined;
      const fromTags = [...new Set(n.tags.map((t) => statusOf(t.tag)).filter((s): s is string => !!s))];
      // Table order, not tag order, decides between two tags: the vocabulary is the ontology's.
      fromTags.sort((a, b) => ontology.statuses.findIndex((s) => s.id === a) - ontology.statuses.findIndex((s) => s.id === b));
      const status = fromField ?? fromTags[0];
      if (status) entity.status = status;
      if (type === "project") {
        if (!status) warn("project-without-status", n, `${n.title} has no status`);
        else if (fromTags.some((t) => t !== status)) {
          warn("project-status-conflict", n, `${n.title}: status ${fromField ? `field says ${fromField}` : "tags say " + fromTags[0]}, tags say ${fromTags.filter((t) => t !== status).join(", ")}`);
        }
      }
    }
    entities.set(n.id, entity);
  }

  // The project note a `project/<key>` tag points at: the conventional
  // 04-Projects/<slug>.md first, else the lowest path — a fixed choice, so
  // facts never flip with indexing order (cf. projectNoteFor in the server).
  const projectByKey = new Map<string, IndexedNote>();
  for (const n of notes) {
    if (entities.get(n.id)!.type !== "project") continue;
    for (const { tag } of n.tags) {
      if (!tag.startsWith("project/")) continue;
      const cur = projectByKey.get(tag);
      const conv = (x: IndexedNote) => x.path === `04-Projects/${tag.slice(8)}.md`;
      if (!cur || (conv(n) && !conv(cur)) || (conv(n) === conv(cur) && n.path < cur.path)) projectByKey.set(tag, n);
    }
  }

  // ── facts ─────────────────────────────────────────────────────────────
  const facts: Fact[] = [];
  const seen = new Set<string>();
  const add = (f: Fact): boolean => {
    const key = `${f.subject}\0${f.relation}\0${f.object}`;
    if (seen.has(key) || f.subject === f.object) return false;
    seen.add(key);
    facts.push(f);
    return true;
  };
  const typeOf = (id: NoteId) => entities.get(id)?.type ?? FALLBACK_TYPE;

  const assert = (rel: RelationDef, src: IndexedNote, target: string, text: boolean, via: FactVia, where: string) => {
    if (!rel.domain.includes(typeOf(src.id))) {
      return; // a field of the same name on another kind of note is not this relation
    }
    const obj = index.resolveLink(target);
    if (!obj || !visible.has(obj.id)) {
      warn("unresolved-object", src, `${src.title}: ${rel.id} → "${target}" is not a note`);
      return;
    }
    if (!rel.range.includes(typeOf(obj.id))) {
      warn("range-mismatch", src, `${src.title}: ${rel.id} → ${obj.title} is a ${typeOf(obj.id)}, expected ${rel.range.join(" or ")}`);
      return;
    }
    add({ subject: src.id, relation: rel.id, object: obj.id, via, source: src.id, where, ...(text ? { text: true as const } : {}) });
  };

  for (const n of notes) {
    for (const rel of ontology.relations) {
      // front matter
      for (const [k, v] of Object.entries(n.frontmatter)) {
        if (!rel.fields.includes(lower(k))) continue;
        for (const s of flatStrings(v)) for (const t of targetsIn(s)) assert(rel, n, t.target, t.text, "field", k);
      }
      if (n.kind === "conversation") continue;
      // inline fields
      const lines = n.content.split("\n");
      let fenced = false;
      for (let i = n.bodyStart; i < lines.length; i++) {
        const line = lines[i]!;
        if (FENCE_RE.test(line.trimStart())) fenced = !fenced;
        if (fenced) continue;
        const m = INLINE_RE.exec(line);
        if (!m || !rel.fields.includes(lower(m[1]!))) continue;
        for (const t of targetsIn(m[2]!)) assert(rel, n, t.target, t.text, "inline", `line ${i + 1}`);
      }
      // sections
      for (const src of rel.also) {
        if (src.startsWith("section:")) {
          const heading = src.slice(8).trim();
          for (const m of readSection(n.content, heading).matchAll(LINK_RE)) assert(rel, n, m[1]!.trim(), false, "section", `## ${heading}`);
        } else if (src.endsWith("/*") && src.startsWith("tag:")) {
          const family = src.slice(4, -2);
          if (!rel.domain.includes(typeOf(n.id))) continue;
          for (const { tag } of n.tags) {
            if (!tag.startsWith(`${family}/`)) continue;
            const project = projectByKey.get(tag);
            if (project) assert(rel, n, project.path, false, "tag", `tag ${tag}`);
            else if (typeOf(n.id) === "document") warn("document-orphan", n, `${n.title} is tagged ${tag} but no project note carries it`);
          }
        }
      }
    }
  }

  // ── inverses ──────────────────────────────────────────────────────────
  for (const f of [...facts]) {
    const inverse = ontology.relations.find((r) => r.id === f.relation)?.inverse;
    if (inverse) add({ ...f, subject: f.object, object: f.subject, relation: inverse, via: "inverse" });
  }

  // ── derived relations: `a . b` composes two relations (graph, then rule order) ──
  for (const r of ontology.rules) {
    if (r.kind !== "derive") continue;
    const m = /^\s*([\w-]+)\s*\.\s*([\w-]+)\s*(?:\(\s*inverse:\s*([\w-]+)\s*\))?\s*$/.exec(r.meaning);
    if (!m) continue;
    const [, a, b, inv] = m;
    const bySubject = new Map<NoteId, Fact[]>();
    for (const f of facts) if (f.relation === b) (bySubject.get(f.subject) ?? bySubject.set(f.subject, []).get(f.subject)!).push(f);
    for (const f1 of facts.filter((f) => f.relation === a)) {
      for (const f2 of bySubject.get(f1.object) ?? []) {
        const d: Fact = { subject: f1.subject, relation: r.id, object: f2.object, via: "derived", source: f1.source, where: f1.where, chain: [f1.object] };
        if (add(d) && inv) add({ ...d, subject: d.object, object: d.subject, relation: inv });
      }
    }
  }

  // ── constraints that read the finished graph ──────────────────────────
  for (const n of notes) {
    const type = typeOf(n.id);
    const has = (rel: string) => facts.some((f) => f.subject === n.id && f.relation === rel);
    if (type === "person" && !has("works_at")) warn("person-without-company", n, `${n.title} has no company`);
    if (type === "conversation" && !has("about")) warn("conversation-without-about", n, `${n.title} is about nothing`);
  }

  return new KnowledgeGraph(ontology, entities, facts, warnings);
}
