/**
 * The Orrery's model (structure.md §2.16): the vault as the page draws it, built from what the
 * app already serves. Nothing here is stored or invented; it is the same notes, read four ways:
 *
 *   /api/vault/graph   every readable note and its links, typed relations on the edges
 *   /api/vault/tree    each note's life area (the vault's #vault-categories rules) and age
 *   /api/projects      which notes are projects, their slug, status and steps done
 *   /api/graph/schema  the ontology's words for a relation read backwards (optional)
 *
 * What a file is follows the pages that list them: a project is a note the Projects board shows,
 * a person a #contact note and a company a #company note (as People shows them), a
 * conversation a saved chat. Weekly reviews and templates are told by their folder, tag or name,
 * and stay hidden until the panel's switch shows them.
 *
 * A topic is where notes gather: a project's notes are that project's topic, and any other
 * note's topic is its folder (the first folder below the top one, so `Work/Kade Social/Reports`
 * is "Kade Social"). A conversation sits with what it is about; a project, a person or a
 * company with the topic most of its own notes are in.
 */
import type { GraphData, TreeNote } from "@basalt/schema/responses";
import type { StatusWord } from "../ui/controls.js";

export type Kind = 0 | 1 | 2 | 3 | 4 | 5;
/** project · person · company · note · conversation · review or template */
export const KIND_NAME = ["Project", "Person", "Company", "Note", "Conversation", "Review or template"] as const;

/** The five life areas in the order they go round the circle, each with its colour token. */
export const AREAS = [
  { id: "school", name: "School", v: "--c3" },
  { id: "work", name: "Work", v: "--c1" },
  { id: "tools", name: "Claude & tools", v: "--c4" },
  { id: "personal", name: "Personal", v: "--c2" },
  { id: "knowledge", name: "Knowledge", v: "--c5" },
] as const;

export interface Relation {
  id: string;
  /** Read from the subject: "works at". */
  out: string;
  /** Read from the object: "employs". */
  in: string;
  /** A relation with a meaning (not a plain link): drawn solid, and counts more. */
  typed: boolean;
}

/**
 * The relations the boards name, strongest first: when two files are joined twice, the stronger
 * meaning is the one drawn. Their words are the boards' (`part_of` read backwards is "its
 * notes"). A relation the ontology adds later takes its inverse from the schema.
 */
const KNOWN: Relation[] = [
  { id: "works_at", out: "works at", in: "employs", typed: true },
  { id: "supervises", out: "supervises", in: "supervised by", typed: true },
  { id: "involves", out: "involves", in: "involved in", typed: true },
  { id: "about", out: "about", in: "discussed in", typed: true },
  { id: "part_of", out: "part of", in: "its notes", typed: true },
];
const LINKS: Relation = { id: "links", out: "links to", in: "linked from", typed: false };

/** How a node's relations are grouped in the panel and in Steps, in this order. */
export const GROUP_ORDER = [
  "supervised by",
  "supervises",
  "works at",
  "employs",
  "involves",
  "involved in",
  "part of",
  "its notes",
  "about",
  "discussed in",
  "links to",
  "linked from",
];

export interface ONode {
  i: number;
  id: string;
  name: string;
  path: string;
  /** The last part of the address that names it: its file name as a slug. */
  slug: string;
  t: Kind;
  area: number;
  cl: number;
  deg: number;
  /** Days since it was last changed. */
  days: number;
  /** How dark its dot is: 0 the best-linked few, 2 most of the vault. */
  tone: 0 | 1 | 2;
  description: string;
  /** Projects: its board slug, status and steps. */
  project?: { slug: string; status: StatusWord | null; done: number; total: number };
}

export interface Topic {
  id: number;
  area: number;
  name: string;
  slug: string;
  /** Notes and conversations in it. */
  n: number;
}

export interface Model {
  nodes: ONode[];
  topics: Topic[];
  areaTopics: number[][];
  /** Edges, undirected and deduplicated: subject, object, relation index into `rels`. */
  ea: Int32Array;
  eb: Int32Array;
  er: Uint16Array;
  rels: Relation[];
  /** Per node, the edges touching it. */
  adj: number[][];
  /** Files of each kind. */
  counts: number[];
  /** Files in each area. */
  areaCount: number[];
}

export interface ProjectRow {
  slug: string;
  noteId: string | null;
  status: string | null;
  done: number;
  total: number;
}

export interface SchemaRelations {
  relations: { id: string; inverse?: string }[];
}

/** A file name as an address part: "Ines Vermaat.md" → "ines-vermaat". */
export function slugOf(pathOrName: string): string {
  const base = pathOrName.split("/").pop()!.replace(/\.md$/i, "");
  const s = base
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return s || "note";
}

const REVIEW_DIR = /^(_?templates?|reviews?|weekly reviews?)$/i;
const REVIEW_TAG = /^(templates?|reviews?|weekly-review|weekly-reviews|weekly)$/i;
const REVIEW_TITLE = /^(weekly review\b|template\b)/i;

/** A weekly review or a template: kept off the map until "Show reviews and templates". */
export function isReviewOrTemplate(n: { path: string; title: string; tags: readonly string[] }): boolean {
  const dirs = n.path.split("/").slice(0, -1);
  return dirs.some((d) => REVIEW_DIR.test(d)) || n.tags.some((t) => REVIEW_TAG.test(t)) || REVIEW_TITLE.test(n.title.trim());
}

/** The ontology's status words, from what a project note's `status:` says. */
export function statusWord(raw: string | null | undefined): StatusWord | null {
  const s = (raw ?? "").trim().toLowerCase().replace(/[-_]/g, " ");
  if (!s) return null;
  if (["on track", "active", "in progress", "ongoing"].includes(s)) return "on track";
  if (["at risk", "blocked", "late"].includes(s)) return "at risk";
  if (["paused", "sleeping", "asleep", "on hold", "someday"].includes(s)) return "paused";
  if (["planned", "not started", "todo", "idea"].includes(s)) return "planned";
  if (["completed", "complete", "done", "finished", "shipped", "delivered"].includes(s)) return "completed";
  if (s === "archived") return "archived";
  if (["cancelled", "canceled", "dropped", "abandoned"].includes(s)) return "cancelled";
  return null;
}

/** A folder's name as words: "03-Knowledge" → "Knowledge". */
const folderWords = (s: string) => s.replace(/^\d+[-_ .]*/, "").trim() || s;

/** The topic a note's folder gives it: the first folder below the top one, else the top one. */
export function folderTopic(path: string): string {
  const dirs = path.split("/").slice(0, -1);
  if (dirs.length === 0) return "";
  return folderWords(dirs.length > 1 ? dirs[1]! : dirs[0]!);
}

const DAY = 86_400_000;

export function buildModel(
  graph: GraphData,
  tree: readonly Pick<TreeNote, "id" | "path" | "category" | "mtimeMs">[],
  projects: readonly ProjectRow[],
  schema?: SchemaRelations | null,
  now = Date.now(),
): Model {
  const treeById = new Map(tree.map((n) => [n.id, n]));
  const projectByNote = new Map<string, ProjectRow>();
  for (const p of projects) if (p.noteId) projectByNote.set(p.noteId, p);
  const projectByTag = new Map<string, string>(); // "project/<slug>" → note id
  for (const p of projects) if (p.noteId) projectByTag.set(`project/${p.slug}`, p.noteId);

  // relations: the known ones, then any the edges carry, then plain links last
  const rels: Relation[] = [...KNOWN];
  const relIx = new Map(rels.map((r, k) => [r.id, k]));
  const inverses = new Map((schema?.relations ?? []).map((r) => [r.id, r.inverse]));
  for (const e of graph.edges) {
    if (!e.relation || relIx.has(e.relation)) continue;
    const words = (s: string) => s.replace(/_/g, " ");
    const inv = inverses.get(e.relation);
    relIx.set(e.relation, rels.length);
    rels.push({ id: e.relation, out: words(e.relation), in: inv ? words(inv) : `${words(e.relation)} (from)`, typed: true });
  }
  const LINK = rels.length;
  rels.push(LINKS);

  // the files
  const nodes: ONode[] = graph.nodes.map((g, i) => {
    const t0 = treeById.get(g.id);
    const path = t0?.path ?? `${g.folder ? `${g.folder}/` : ""}${g.title}.md`;
    const pr = projectByNote.get(g.id);
    const t: Kind = pr
      ? 0
      : g.tags.includes("contact")
        ? 1
        : g.tags.includes("company")
          ? 2
          : g.kind === "conversation"
            ? 4
            : isReviewOrTemplate({ path, title: g.title, tags: g.tags })
              ? 5
              : 3;
    const areaIx = AREAS.findIndex((a) => a.id === t0?.category);
    const node: ONode = {
      i,
      id: g.id,
      name: g.title,
      path,
      slug: pr ? pr.slug : slugOf(path),
      t,
      area: areaIx < 0 ? 3 : areaIx, // nothing matching is Personal, as the server says
      cl: -1,
      deg: 0,
      days: t0 ? Math.max(0, Math.floor((now - t0.mtimeMs) / DAY)) : 0,
      tone: 2,
      description: g.description,
    };
    if (pr) node.project = { slug: pr.slug, status: statusWord(pr.status), done: pr.done, total: pr.total };
    return node;
  });
  const ix = new Map(nodes.map((n) => [n.id, n.i]));

  // the edges: one per pair, the strongest meaning wins (and its direction)
  const ea: number[] = [];
  const eb: number[] = [];
  const er: number[] = [];
  const seen = new Map<string, number>();
  for (const e of graph.edges) {
    const a = ix.get(e.from);
    const b = ix.get(e.to);
    if (a === undefined || b === undefined || a === b) continue;
    const r = e.relation ? relIx.get(e.relation)! : LINK;
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    const at = seen.get(key);
    if (at !== undefined) {
      if (r < er[at]!) {
        er[at] = r;
        ea[at] = a;
        eb[at] = b;
      }
      continue;
    }
    seen.set(key, ea.length);
    ea.push(a);
    eb.push(b);
    er.push(r);
    nodes[a]!.deg++;
    nodes[b]!.deg++;
  }
  const adj: number[][] = nodes.map(() => []);
  for (let k = 0; k < ea.length; k++) {
    adj[ea[k]!]!.push(k);
    adj[eb[k]!]!.push(k);
  }
  const other = (e: number, i: number) => (ea[e] === i ? eb[e]! : ea[e]!);

  // conversations sit in the area of what they are about
  const aboutIx = relIx.get("about")!;
  for (const n of nodes) {
    if (n.t !== 4) continue;
    const about = adj[n.i]!.find((e) => er[e] === aboutIx && ea[e] === n.i);
    if (about !== undefined) n.area = nodes[other(about, n.i)]!.area;
  }

  // topics: per area, a project's notes, else the folder
  const topics: Topic[] = [];
  const areaTopics: number[][] = AREAS.map(() => []);
  const topicIx = new Map<string, number>();
  const topicOf = (area: number, name: string) => {
    const key = `${area}\0${name.toLowerCase()}`;
    let id = topicIx.get(key);
    if (id === undefined) {
      id = topics.length;
      topicIx.set(key, id);
      topics.push({ id, area, name, slug: slugOf(name), n: 0 });
      areaTopics[area]!.push(id);
    }
    return id;
  };
  const tagsOf = new Map(graph.nodes.map((g) => [g.id, g.tags]));
  const ownTopic = (n: ONode): string => {
    if (n.t === 0) return n.name;
    for (const tag of tagsOf.get(n.id) ?? []) {
      const pid = projectByTag.get(tag);
      if (pid !== undefined && ix.has(pid)) return nodes[ix.get(pid)!]!.name;
    }
    return folderTopic(n.path) || AREAS[n.area]!.name;
  };
  for (const n of nodes) if (n.t === 3 || n.t === 5) n.cl = topicOf(n.area, ownTopic(n));
  // the topic most of a file's own notes are in, if any
  const vote = (n: ONode, kinds: (t: Kind) => boolean): number => {
    const votes = new Map<number, number>();
    for (const e of adj[n.i]!) {
      const o = nodes[other(e, n.i)]!;
      if (o.cl >= 0 && o.area === n.area && kinds(o.t)) votes.set(o.cl, (votes.get(o.cl) ?? 0) + 1);
    }
    let best = -1;
    let bestN = 0;
    for (const [cl, c] of votes) if (c > bestN || (c === bestN && cl < best)) (best = cl), (bestN = c);
    return best;
  };
  // a project keeps its own topic when its notes are there; people and companies go where most
  // of their notes are
  for (const n of nodes) {
    if (n.cl >= 0 || n.t === 4) continue;
    const own = n.t === 0 ? topicIx.get(`${n.area}\0${n.name.toLowerCase()}`) : undefined;
    n.cl = own ?? vote(n, (t) => t === 3);
  }
  // conversations take the topic of what they are about
  for (const n of nodes) {
    if (n.t !== 4) continue;
    const about = adj[n.i]!.find((e) => er[e] === aboutIx && ea[e] === n.i);
    const target = about !== undefined ? nodes[other(about, n.i)]! : null;
    if (target && target.cl >= 0 && topics[target.cl]!.area === n.area) n.cl = target.cl;
    else n.cl = vote(n, (t) => t === 3);
  }
  // what is left has nothing to go by but its own folder
  for (const n of nodes) if (n.cl < 0) n.cl = topicOf(n.area, ownTopic(n));
  for (const n of nodes) if (n.t === 3 || n.t === 4) topics[n.cl]!.n++;

  // how dark each dot is: by rank within its kind, so most of the vault stays a light texture
  for (const t of [0, 1, 2, 3, 4, 5] as Kind[]) {
    const ofKind = nodes.filter((n) => n.t === t).sort((a, b) => b.deg - a.deg || a.i - b.i);
    const top = t === 3 ? 0.04 : 0.1;
    const mid = t === 3 ? 0.2 : 0.35;
    ofKind.forEach((n, k) => {
      const f = k / Math.max(1, ofKind.length);
      n.tone = f < top ? 0 : f < mid ? 1 : 2;
    });
  }

  const counts = [0, 0, 0, 0, 0, 0];
  const areaCount = AREAS.map(() => 0);
  for (const n of nodes) {
    counts[n.t]!++;
    areaCount[n.area]!++;
  }
  return { nodes, topics, areaTopics, ea: Int32Array.from(ea), eb: Int32Array.from(eb), er: Uint16Array.from(er), rels, adj, counts, areaCount };
}

/** The other end of edge `e` from node `i`. */
export const otherEnd = (m: Model, e: number, i: number): number => (m.ea[e] === i ? m.eb[e]! : m.ea[e]!);

/** What edge `e` is, read from node `i`: "works at" from the person, "employs" from the company. */
export const groupOf = (m: Model, i: number, e: number): string => (m.ea[e] === i ? m.rels[m.er[e]!]!.out : m.rels[m.er[e]!]!.in);

/** A node's relations grouped in words, in the boards' order, best-linked first in each group. */
export function relationGroups(m: Model, i: number, keep: (j: number) => boolean = () => true): { name: string; items: number[] }[] {
  const g = new Map<string, number[]>();
  for (const e of m.adj[i]!) {
    const o = otherEnd(m, e, i);
    if (!keep(o)) continue;
    const name = groupOf(m, i, e);
    (g.get(name) ?? g.set(name, []).get(name)!).push(o);
  }
  const rank = (s: string) => {
    const k = GROUP_ORDER.indexOf(s);
    return k < 0 ? GROUP_ORDER.length : k;
  };
  return [...g.entries()]
    .sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]))
    .map(([name, items]) => ({ name, items: items.sort((a, b) => m.nodes[b]!.deg - m.nodes[a]!.deg || a - b) }));
}

/** A cheap fingerprint of the data, so a refetch that changed nothing changes nothing. */
export function signature(m: Model): string {
  let h = 0;
  const mix = (s: string) => {
    for (let k = 0; k < s.length; k++) h = (Math.imul(h, 31) + s.charCodeAt(k)) | 0;
  };
  for (const n of m.nodes) mix(`${n.id}|${n.name}|${n.t}|${n.area}|${n.cl}|${n.project?.status ?? ""}|${n.project?.done ?? ""};`);
  for (let k = 0; k < m.ea.length; k++) mix(`${m.ea[k]},${m.eb[k]},${m.er[k]};`);
  return `${m.nodes.length}:${m.ea.length}:${h}`;
}
