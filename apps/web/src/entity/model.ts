/**
 * The entity pages' words and groupings (structure.md §2.6), pure so the pages and their tests
 * agree: which relations a page lists and in what words (both directions, the strongest word
 * once per note), who someone works with, the path that says how you know them, what of the
 * mail, the calendar and the steps involves them, a saved conversation as speaker turns, and
 * which collection a document address names.
 *
 * Nothing is invented: without an ontology the graph has no relations, and the page lists the
 * plain links it has (who mentions this note, what it links to) instead.
 */

export interface Brief {
  id: string;
  title: string;
  type: string;
}

/** What a relation says, read from the page's own thing: Ines "supervises" the thesis. */
const WORD: Record<string, string> = {
  supervises: "supervises",
  supervised_by: "supervised by",
  works_at: "works at",
  employs: "employs",
  involves: "involves",
  involved_in: "involved in",
  company_involved_in: "involved in",
  involves_company: "involves",
  about: "about",
  discussed_in: "discussed in",
  part_of: "part of",
  has_part: "has",
};
export const relationWord = (relation: string): string => WORD[relation] ?? relation.replace(/_/g, " ");

/** Strongest first: a note said under one relation is not repeated under a weaker one. */
const ORDER = ["supervises", "supervised_by", "works_at", "employs", "involves", "involved_in", "involves_company", "company_involved_in", "about", "part_of", "has_part", "discussed_in"];

export interface Group {
  /** The relation id, or `mentioned_in`, `works_with`, `links_to` for what is not a typed relation. */
  key: string;
  word: string;
  items: (Brief & { note?: string })[];
}

/**
 * The relations a page lists, in words: typed relations strongest first (each note under its
 * strongest word only), then who works with them, then the notes that mention this one and are
 * not already said, then (only without typed relations) what this note links to.
 */
export function relationGroups(input: {
  relations: Map<string, Brief[]>;
  mentions?: Brief[];
  worksWith?: (Brief & { note?: string })[];
  links?: Brief[];
}): Group[] {
  const said = new Set<string>();
  const out: Group[] = [];
  const rank = (r: string) => (ORDER.indexOf(r) + 1 || ORDER.length + 1);
  const keys = [...input.relations.keys()].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : 1));
  for (const key of keys) {
    // Two relations can say the same word (involved_in, company_involved_in): one group.
    const word = relationWord(key);
    const items = input.relations.get(key)!.filter((b) => !said.has(b.id));
    items.forEach((b) => said.add(b.id));
    if (items.length === 0) continue;
    const same = out.find((g) => g.word === word);
    if (same) same.items.push(...items);
    else out.push({ key, word, items });
  }
  const ww = (input.worksWith ?? []).filter((b) => !said.has(b.id));
  ww.forEach((b) => said.add(b.id));
  if (ww.length) out.push({ key: "works_with", word: "works with", items: ww });
  const mentions = (input.mentions ?? []).filter((b) => !said.has(b.id));
  mentions.forEach((b) => said.add(b.id));
  if (mentions.length) out.push({ key: "mentioned_in", word: "mentioned in", items: mentions });
  const typed = keys.length > 0;
  const links = typed ? [] : (input.links ?? []).filter((b) => !said.has(b.id));
  if (links.length) out.push({ key: "links_to", word: "links to", items: links });
  return out;
}

/** The relations a person or company has to projects, as the People context sends them. */
const ON_PROJECT = new Set(["supervises", "involved_in", "company_involved_in"]);

export interface ContextEntry {
  id: string;
  relations: { relation: string; to: Brief[] }[];
}

/**
 * Who someone works with: the other people on a project they are on (supervising or involved),
 * "both on Graduation thesis". People only; companies are said by `employs`.
 */
export function worksWith(id: string, entries: ContextEntry[], personTitle: (id: string) => string | undefined): (Brief & { note: string })[] {
  const projectsOf = (e: ContextEntry) => e.relations.filter((r) => ON_PROJECT.has(r.relation)).flatMap((r) => r.to.filter((t) => t.type === "project"));
  const me = entries.find((e) => e.id === id);
  if (!me) return [];
  const mine = new Map(projectsOf(me).map((p) => [p.id, p.title]));
  if (mine.size === 0) return [];
  const out: (Brief & { note: string })[] = [];
  for (const e of entries) {
    const title = e.id === id ? undefined : personTitle(e.id);
    if (!title) continue;
    const shared = [...new Set(projectsOf(e).filter((p) => mine.has(p.id)).map((p) => p.title))];
    if (shared.length === 0) continue;
    out.push({ id: e.id, title, type: "person", note: `both on ${shared.join(" and ")}` });
  }
  return out.sort((a, b) => a.title.localeCompare(b.title));
}

/** The person note that is you: the one with your account's address, else your name. */
export function youOf<T extends { id: string; name: string; email: string }>(contacts: T[], me: { email: string; displayName: string }): T | undefined {
  const fold = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").trim().toLowerCase();
  return contacts.find((c) => c.email && fold(c.email) === fold(me.email)) ?? contacts.find((c) => me.displayName && fold(c.name) === fold(me.displayName));
}

export interface PathStep {
  from: Brief;
  relation: string;
  to: Brief;
}

/** "How you know them" is said only for a short path that is not a direct one (§2.6). */
export function pathWorthSaying(steps: PathStep[] | undefined): boolean {
  return !!steps && steps.length >= 2 && steps.length <= 4;
}

/* ---- activity ------------------------------------------------------------------------------ */

const fold = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Does this text name them? Their whole name, as words ("Ines Vermaat", "[[Ines Vermaat]]"),
 * never a first name alone: "Lunch with Ines" could be anyone called Ines.
 */
export function names(text: string, name: string): boolean {
  const n = fold(name.trim());
  if (n.split(/\s+/).length < 2 && n.length < 4) return false;
  return new RegExp(`(^|[^\\p{L}])${escape(n)}($|[^\\p{L}])`, "u").test(fold(text));
}

/** An e-mail address's domain, folded: "Ines@Westerdok.nl" → "westerdok.nl". */
export const domainOf = (address: string): string => fold(address.trim()).split("@")[1] ?? "";

/** A website as a bare domain: "https://www.kade.example/jobs" → "kade.example". */
export const siteDomain = (url: string): string =>
  fold(url.trim())
    .replace(/^[a-z]+:\/\//, "")
    .replace(/^www\./, "")
    .split(/[/?#]/)[0] ?? "";

/** Mail domains everyone uses: a company is never "gmail.com". */
const PUBLIC_MAIL = new Set(["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "icloud.com", "me.com", "yahoo.com", "proton.me", "protonmail.com", "example.com"]);

/** The domains a company's mail comes from: its website's, and its people's addresses'. */
export function companyDomains(company: { website: string }, people: { email: string }[]): Set<string> {
  const out = new Set<string>();
  const site = siteDomain(company.website);
  if (site) out.add(site);
  for (const p of people) {
    const d = domainOf(p.email);
    if (d) out.add(d);
  }
  for (const d of [...out]) if (PUBLIC_MAIL.has(d)) out.delete(d);
  return out;
}


/* ---- what is going on with them ----------------------------------------------------------- */

export interface Who {
  /** Whole names that stand for them in a title: a person's name, a company's name. */
  names: string[];
  /** Exact addresses their mail comes from. */
  addresses: string[];
  /** Domains their mail comes from (a company). */
  domains: Set<string>;
}

export interface InboxItem {
  uid: number;
  from: string;
  fromName: string;
  subject: string;
  date: string | null;
  seen: boolean;
}
interface ActTask {
  text: string;
  status: string;
  due?: string;
}
interface ActEvent {
  title: string;
  date: string;
  startMin: number;
}

const foldAddr = (s: string) => s.trim().toLowerCase();

/** The rows that involve them, newest mail first, then events by date, then steps by due date. */
export function activityOf<T extends ActTask, E extends ActEvent, M extends InboxItem>(src: { tasks: T[] | null; events: E[] | null; mail: M[] | null }, who: Who) {
  const addrs = new Set(who.addresses.map(foldAddr).filter(Boolean));
  const named = (t: string) => who.names.some((n) => n && names(t, n));
  const mail = (src.mail ?? [])
    .filter((m) => addrs.has(foldAddr(m.from)) || (who.domains.size > 0 && who.domains.has(domainOf(m.from))))
    .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""))
    .slice(0, 3);
  const events = (src.events ?? [])
    .filter((e) => named(e.title))
    .sort((a, b) => a.date.localeCompare(b.date) || a.startMin - b.startMin)
    .slice(0, 3);
  const tasks = (src.tasks ?? [])
    .filter((t) => t.status !== "done" && named(t.text))
    .sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999"))
    .slice(0, 4);
  return { mail, events, tasks };
}

/* ---- a conversation, as speaker turns --------------------------------------------------- */

export interface Turn {
  speaker: string;
  text: string;
}

/**
 * A saved conversation's turns (`**Jules:** …` up to the next speaker), never shown as the raw
 * `**Jules:**` markup (§2.6). The header lines a transcript starts with (`**Date:**`,
 * `**Session:**`, `**Working dir:**`) are facts, not turns; text before the first speaker is
 * left out. A note with no speakers has no turns, and the page shows it as a note.
 */
const HEADER = /^(date|session|working dir|model|project|cwd)$/i;
const SPEAKER = /^\*\*([^*:]{1,40}):\*\*\s?(.*)$/;

export function turnsOf(body: string): Turn[] {
  const out: Turn[] = [];
  let cur: Turn | null = null;
  let fence = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const m = fence ? null : SPEAKER.exec(line.trim());
    if (m && !HEADER.test(m[1]!.trim())) {
      cur = { speaker: m[1]!.trim(), text: m[2] ?? "" };
      out.push(cur);
    } else if (m && HEADER.test(m[1]!.trim())) {
      continue;
    } else if (cur) {
      cur.text += `\n${line}`;
    }
  }
  return out.map((t) => ({ speaker: t.speaker, text: t.text.trim() }));
}

/** The words in a conversation, for its length. */
export const wordsIn = (turns: Turn[]): number => turns.reduce((n, t) => n + (t.text.match(/\S+/g)?.length ?? 0), 0);

/* ---- documents ----------------------------------------------------------------------------- */

export type DocumentAt =
  /** A file in a project's files folder: read through that project's routes. */
  | { kind: "project-file"; slug: string; name: string; base: string }
  /** A statement or payslip in the finance files folder. */
  | { kind: "finance-file"; name: string; base: string }
  /** A note (a `document` in the ontology: one that belongs to a project). */
  | { kind: "note"; path: string };

/** What a `/documents/<path>` address names. */
export function documentAt(path: string): DocumentAt {
  const p = path.replace(/^\/+/, "");
  const proj = /^04-Projects\/([^/]+)\/files\/([^/]+)$/.exec(p);
  if (proj) return { kind: "project-file", slug: proj[1]!, name: proj[2]!, base: `/api/projects/${encodeURIComponent(proj[1]!)}/files` };
  const fin = /^02-Areas\/finance\/files\/([^/]+)$/.exec(p);
  if (fin) return { kind: "finance-file", name: fin[1]!, base: "/api/finance/files" };
  return { kind: "note", path: /\.md$/i.test(p) ? p : `${p}.md` };
}

/** "12.4 KB": a file's size in words. */
export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** "PDF", "Word document": a file's type from its name. */
export function fileType(name: string): string {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  const known: Record<string, string> = {
    pdf: "PDF",
    docx: "Word document",
    xlsx: "Spreadsheet",
    xlsm: "Spreadsheet",
    pptx: "Presentation",
    csv: "CSV",
    txt: "Text",
    md: "Markdown",
    json: "JSON",
    png: "Image",
    jpg: "Image",
    jpeg: "Image",
    gif: "Image",
    webp: "Image",
  };
  return known[ext] ?? (ext ? ext.toUpperCase() : "File");
}
