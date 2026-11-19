/**
 * The persona: one note about the person, for introducing them and writing as them (the Me
 * page, ME, Nov 2026). It is found by tag, `#persona`, like every other ledger; its shape is a
 * set of `##` sections the page reads by heading:
 *
 *     ## In short              ### One line / ### 30 seconds / ### 2 minutes, each with
 *                              `EN:` / `FR :` lines (bulleted, bold or plain) or a paragraph
 *     ## Now                   | label | value |
 *     ## Experience            | Period | Role | Organisation | What I did | Lane |
 *     ## Projects              | Project | When | What it is | My part | Outcome | Skills | People | Part of | Outside use |
 *                              (★ before a name marks the strongest)
 *     ## Skills                | Skill | Level | Proof |   (an "Also" row lists the rest)
 *     ## Proof points          | Number | What | (Source) |, then "Words from others:" and
 *                              "Internal only…:" lines
 *     ## People                | Person | Role | How we work together |
 *     ## Voice                 bullets, "**English, work:** …" a register
 *     ## Rules for outside use bullets
 *     ## Interests             a paragraph
 *     ## Check with <name>     bullets: open questions; "A **or** B" are its options,
 *                              "Answer: …" on the line means answered
 *
 * Read leniently: a missing section is empty, a section this does not know is ignored, a row
 * that cannot be read is skipped and named in `unread` (the page says what it couldn't read),
 * and nothing here ever throws on what a person typed. Columns are matched by name, not
 * position, so a hand-edited table still reads.
 *
 * Links between the parts (the online CV's connected graph): a project names its skills,
 * people and the places it was part of with the exact names from the Skills, People and
 * Experience tables; a skill's Proof names projects; a proof point names (or is matched to)
 * the project or place it comes from. `personaGraph` answers "what is this connected to".
 */
import { parseFrontmatter } from "./frontmatter.js";
import { codeLines, noteLines, spliceNoteLines } from "./parse.js";
import { cells, isRule } from "./table.js";
import { monthOf, type Period } from "./personaGraph.js";

export * from "./personaGraph.js";

export const PERSONA_TAG = "persona";


export interface PersonaExperience {
  key: string;
  period: string;
  /** Null when the period could not be read: listed, but not on the timeline. */
  when: Period | null;
  role: string;
  org: string;
  what: string;
  lane: string;
  /** The note it comes from, when the row has a Source column naming one (`[[…]]` or a path). */
  source: string | null;
}

export interface PersonaProject {
  key: string;
  name: string;
  star: boolean;
  period: string;
  when: Period | null;
  what: string;
  part: string;
  outcome: string;
  skills: string[];
  people: string[];
  /** Names from the Experience table's Organisation column, or words of the person's own ("Own time"). */
  partOf: string[];
  outside: string;
  source: string | null;
}

export interface PersonaSkill {
  key: string;
  name: string;
  /** Out of 10; null when the row gives none. */
  level: number | null;
  /** Project names its Proof column gives. */
  proof: string[];
}

export interface PersonaProof {
  key: string;
  number: string;
  what: string;
  /** The project or experience it comes from (`project:…`, `exp:…`), when the note says or the words match one. */
  source: string | null;
}

export interface PersonaPerson {
  key: string;
  name: string;
  role: string;
  how: string;
}

export interface PersonaQuestion {
  key: string;
  /** The bullet as the note has it (without its marker): how an answer finds its line. */
  raw: string;
  /** Its short name ("Target role"), and the rest of it. */
  name: string;
  detail: string;
  options: string[];
  answer: string | null;
}

export interface PersonaVoice {
  label: string | null;
  text: string;
}

export type PitchLength = "line" | "s30" | "min2";

export interface PersonaUnread {
  section: string;
  text: string;
  reason: string;
}

export interface Persona {
  name: string;
  updated: string | null;
  /** By length, then language code (EN, FR…): the text. */
  short: Record<PitchLength, Record<string, string>>;
  now: { label: string; value: string }[];
  experience: PersonaExperience[];
  projects: PersonaProject[];
  skills: PersonaSkill[];
  /** The Skills table's "Also" row, and the lines under the table. */
  skillsAlso: string;
  skillNotes: string[];
  proof: PersonaProof[];
  /** "Words from others: …" under Proof points. */
  proofWords: string;
  /** "Internal only…: …" under Proof points: never quoted outside. */
  proofInternal: string;
  people: PersonaPerson[];
  voice: PersonaVoice[];
  rules: string[];
  interests: string;
  questions: PersonaQuestion[];
  /** The sections the note has, by the names this reads them under. */
  sections: PersonaSection[];
  unread: PersonaUnread[];
}

export const PERSONA_SECTIONS = ["short", "now", "experience", "projects", "skills", "proof", "people", "voice", "rules", "interests", "questions"] as const;
export type PersonaSection = (typeof PERSONA_SECTIONS)[number];

/** Which section a `##` heading is, or null for one this does not read. */
export function sectionOf(heading: string): PersonaSection | null {
  const h = heading.replace(/#+\s*$/, "").trim().toLowerCase();
  if (h === "in short" || h === "short") return "short";
  if (h === "now" || h === "right now") return "now";
  if (h === "experience" || h === "experiences") return "experience";
  if (h === "projects" || h === "work") return "projects";
  if (h === "skills") return "skills";
  if (h === "proof points" || h === "proof") return "proof";
  if (h === "people") return "people";
  if (h === "voice") return "voice";
  if (/^rules\b/.test(h)) return "rules";
  if (h === "interests") return "interests";
  if (/^check with\b/.test(h) || h === "open questions") return "questions";
  return null;
}

/* ---- text ---------------------------------------------------------------------------------- */

/** Markdown inline marks taken out: bold, italics, code, links (their words kept). */
export function plain(s: string): string {
  return s
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, (_m, t: string) => t.split("/").pop()!.replace(/#.*$/, ""))
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?=[^*\w]|$)/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\\\|/g, "|")
    .replace(/\s+/g, " ")
    .trim();
}

const norm = (s: string) => s.normalize("NFC").toLowerCase().replace(/[★*]/g, "").replace(/\s+/g, " ").trim();

/** A short key for a name: letters and digits of any script, joined by dashes. */
function keyOf(name: string, taken: Set<string>): string {
  const base =
    name
      .normalize("NFKD")
      .replace(/\p{M}+/gu, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "item";
  let k = base;
  for (let n = 2; taken.has(k); n++) k = `${base}-${n}`;
  taken.add(k);
  return k;
}

/* ---- periods ------------------------------------------------------------------------------- */

const MONTHS: Record<string, [number, number]> = {};
["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].forEach((m, i) => (MONTHS[m] = [i + 1, i + 1]));
["january", "february", "march", "april", "june", "july", "august", "september", "october", "november", "december"].forEach((m) => (MONTHS[m] = MONTHS[m.slice(0, 3)]!));
MONTHS["sept"] = [9, 9];
MONTHS["spring"] = [3, 5];
MONTHS["summer"] = [6, 8];
MONTHS["autumn"] = [9, 11];
MONTHS["fall"] = [9, 11];
MONTHS["winter"] = [1, 2];

interface Side {
  now?: boolean;
  months?: [number, number];
  year?: number;
}

function side(text: string): Side | null {
  const t = text.trim().toLowerCase().replace(/[.,]/g, "");
  if (/^(now|today|present|ongoing|current)$/.test(t)) return { now: true };
  const m = /^(?:([a-z]+)\s*)?(\d{4})?$/.exec(t);
  if (!m || (!m[1] && !m[2])) return null;
  const months = m[1] ? MONTHS[m[1]] : undefined;
  if (m[1] && !months) return null;
  const year = m[2] ? Number(m[2]) : undefined;
  if (year !== undefined && (year < 1900 || year > 2200)) return null;
  return { months, year };
}

/**
 * A period as people write it: "2023", "May 2026", "Spring 2026", "2021–2022", "Jan–Jun 2025",
 * "Aug 2025 – Jan 2026", "Jul 2026–now". A year alone runs January to December. Null when it
 * cannot be read.
 */
export function parsePeriod(text: string): Period | null {
  const parts = text
    .trim()
    .split(/\s*(?:–|—|−|\bto\b|\buntil\b|-)\s*/i)
    .filter((p) => p.trim() !== "");
  if (parts.length === 0 || parts.length > 2) return null;
  const a = side(parts[0]!);
  const b = parts[1] !== undefined ? side(parts[1]) : null;
  if (!a || a.now || (parts[1] !== undefined && !b)) return null;
  let year = a.year;
  if (year === undefined) {
    if (!b || b.now || b.year === undefined) return null;
    year = b.year;
    // "Nov – Feb 2026": the start is the year before.
    if (a.months && b.months && a.months[0] > b.months[1]) year -= 1;
  }
  const start = monthOf(year, a.months?.[0] ?? 1);
  if (!b) return { start, end: monthOf(year, a.months?.[1] ?? 12) };
  if (b.now) return { start, end: null };
  const endYear = b.year ?? year;
  const end = monthOf(endYear, b.months?.[1] ?? 12);
  return end < start ? null : { start, end };
}

/* ---- the note's parts ---------------------------------------------------------------------- */

interface Block {
  heading: string;
  lines: string[];
}

/** The note's `##` sections, code fences skipped. */
function blocks(content: string): Block[] {
  const { lines } = noteLines(content);
  const code = codeLines(lines);
  const fm = parseFrontmatter(content);
  const out: Block[] = [];
  let cur: Block | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (i < fm.bodyStart) continue;
    // Code is never persona text, and a heading in it is not a section.
    if (code[i]) continue;
    const line = lines[i]!;
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) {
      cur = { heading: h[1]!, lines: [] };
      out.push(cur);
      continue;
    }
    if (/^#\s/.test(line)) {
      cur = null;
      continue;
    }
    cur?.lines.push(line);
  }
  return out;
}

interface Table {
  /** Normalised header names, in the table's own order. */
  cols: string[];
  rows: { cells: string[]; text: string }[];
  /** The lines that are not the table. */
  rest: string[];
}

const headerName = (c: string) => c.toLowerCase().replace(/[^a-z ]/g, "").replace(/\s+/g, " ").trim();

/** The section's first table (header, rule, rows) and the lines around it. */
function tableOf(lines: string[]): Table {
  const t: Table = { cols: [], rows: [], rest: [] };
  let state: "before" | "head" | "rows" | "after" = "before";
  for (const line of lines) {
    const isRow = line.trim().startsWith("|");
    if (state === "before" && isRow) {
      t.cols = cells(line).map(headerName);
      state = "head";
      continue;
    }
    if (state === "head") {
      state = "rows";
      if (isRow && isRule(cells(line))) continue;
    }
    if (state === "rows") {
      if (isRow) {
        t.rows.push({ cells: cells(line), text: line.trim() });
        continue;
      }
      state = "after";
    }
    t.rest.push(line);
  }
  return t;
}

/** The column of `t` called any of `names` (normalised, exact or as a first word), or -1. */
function col(t: Table, ...names: string[]): number {
  for (const n of names) {
    const i = t.cols.indexOf(n);
    if (i >= 0) return i;
  }
  for (const n of names) {
    const i = t.cols.findIndex((c) => c.startsWith(`${n} `));
    if (i >= 0) return i;
  }
  return -1;
}

const cell = (row: string[], i: number) => (i >= 0 ? plain(row[i] ?? "") : "");

/** A Source cell's note: the target of its first `[[link]]`, else its words; null when empty. */
function sourceCell(row: string[], i: number): string | null {
  const raw = i >= 0 ? (row[i] ?? "").trim() : "";
  if (!raw) return null;
  // In a table a link's alias pipe is escaped, `[[Note\|alias]]` (Obsidian): the "\" is not the name's.
  const link = /\[\[([^\]|#]+?)(?:\\?\||#|\]\])/.exec(raw);
  return (link ? link[1]! : plain(raw)).trim() || null;
}

/** Bullet items of a section, as written (marker taken off). */
function bullets(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const m = /^\s*[-*+]\s+(.*\S)\s*$/.exec(line);
    if (m) out.push(m[1]!);
    else if (out.length && /^\s{2,}\S/.test(line)) out[out.length - 1] += ` ${line.trim()}`;
  }
  return out;
}

const paragraphs = (lines: string[]) =>
  lines
    .join("\n")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

/**
 * The known names a list cell mentions. Names hold commas ("AMSIB / HvA, Amsterdam"), so the cell
 * is not split first: every known name it contains is taken, longest first, and what is left,
 * split on commas, is kept as the person's own words.
 */
export function namesIn(text: string, known: readonly string[]): string[] {
  let rest = ` ${plain(text)} `;
  const found: { at: number; name: string }[] = [];
  for (const name of [...known].sort((a, b) => b.length - a.length)) {
    if (!name.trim()) continue;
    const at = rest.toLowerCase().indexOf(name.toLowerCase());
    if (at < 0) continue;
    found.push({ at, name });
    rest = rest.slice(0, at) + " ".repeat(name.length) + rest.slice(at + name.length);
  }
  const extra = rest
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter((s) => s && !/^(and|or|\+\d+)$/i.test(s));
  return [...found.sort((a, b) => a.at - b.at).map((f) => f.name), ...extra];
}

const LANG_LINE = /^\s*(?:[-*+]\s+)?\*{0,2}\s*([A-Za-z]{2})\s*:\s*\*{0,2}\s*(.*)$/;

function shortOf(lines: string[]): Record<PitchLength, Record<string, string>> {
  const out: Record<PitchLength, Record<string, string>> = { line: {}, s30: {}, min2: {} };
  let len: PitchLength | null = null;
  let hint = "EN";
  let lang: string | null = null;
  // A paragraph wrapped over several lines is one paragraph; a blank line starts the next.
  let gap = false;
  const add = (l: PitchLength, code: string, text: string, fresh: boolean) => {
    const t = plain(text);
    if (!t) return;
    const had = out[l][code];
    out[l][code] = had ? `${had}${fresh ? "\n\n" : " "}${t}` : t;
  };
  for (const line of lines) {
    const h = /^###\s+(.+?)\s*$/.exec(line);
    if (h) {
      const name = h[1]!.toLowerCase();
      len = /one line|one-liner|^line\b/.test(name) ? "line" : /\b30\s*s|thirty/.test(name) ? "s30" : /\b2\s*min|two min/.test(name) ? "min2" : null;
      const code = /\(([a-z]{2})\)/i.exec(name);
      hint = code ? code[1]!.toUpperCase() : "EN";
      lang = null;
      gap = false;
      continue;
    }
    if (!len) continue;
    if (!line.trim()) {
      gap = true;
      continue;
    }
    const m = LANG_LINE.exec(line);
    if (m && /^(en|fr|nl|de|es|it|pt)$/i.test(m[1]!)) {
      lang = m[1]!.toUpperCase();
      add(len, lang, m[2]!, true);
      gap = false;
      continue;
    }
    add(len, lang ?? hint, line.replace(/^\s*[-*+]\s+/, ""), gap || /^\s*[-*+]\s/.test(line));
    gap = false;
  }
  return out;
}

const ANSWER = /\s*(?:→|->|—|–)?\s*\**answer(?:ed)?\**\s*(?:\(([^)]*)\))?\s*:\**\s*(.+)$/i;

function questionOf(raw: string, key: string): PersonaQuestion {
  const a = ANSWER.exec(raw);
  const text = plain(a ? raw.slice(0, a.index) : raw);
  const colon = text.indexOf(": ");
  const name = colon > 0 && colon <= 60 ? text.slice(0, colon) : text;
  const detail = colon > 0 && colon <= 60 ? text.slice(colon + 2) : "";
  const parts = (colon > 0 && colon <= 60 ? (a ? raw.slice(0, a.index) : raw).slice(raw.indexOf(": ") + 2) : "").split(/\s*\*\*or\*\*\s*/i);
  const options = parts.length >= 2 ? parts.map((p) => plain(p).replace(/[?.]+$/, "").trim()).filter(Boolean) : [];
  return { key, raw, name, detail, options, answer: a ? plain(a[2]!) : null };
}

/* ---- the whole note ------------------------------------------------------------------------ */

/** Read a persona note. Never throws; what could not be read is in `unread`. */
export function parsePersona(content: string, fallbackName = ""): Persona {
  const fm = parseFrontmatter(content).data;
  const title = typeof fm["title"] === "string" ? fm["title"] : (/^#\s+(.+?)\s*$/m.exec(content)?.[1] ?? "");
  const named = typeof fm["name"] === "string" ? fm["name"].trim() : "";
  const fromTitle = title.replace(/^persona\s*(?:[—–:-]\s*)?/i, "").trim();
  const p: Persona = {
    name: named || fromTitle || fallbackName,
    updated: fm["updated"] instanceof Date ? fm["updated"].toISOString().slice(0, 10) : typeof fm["updated"] === "string" ? fm["updated"] : null,
    short: { line: {}, s30: {}, min2: {} },
    now: [],
    experience: [],
    projects: [],
    skills: [],
    skillsAlso: "",
    skillNotes: [],
    proof: [],
    proofWords: "",
    proofInternal: "",
    people: [],
    voice: [],
    rules: [],
    interests: "",
    questions: [],
    sections: [],
    unread: [],
  };
  const skip = (section: string, text: string, reason: string) => p.unread.push({ section, text, reason });
  const found = new Map<PersonaSection, Block>();
  for (const b of blocks(content)) {
    const s = sectionOf(b.heading);
    if (s && !found.has(s)) found.set(s, b);
  }
  p.sections = PERSONA_SECTIONS.filter((s) => found.has(s));
  const lines = (s: PersonaSection) => found.get(s)?.lines ?? [];
  const heading = (s: PersonaSection) => found.get(s)?.heading ?? s;

  p.short = shortOf(lines("short"));

  // Now: a two-column table, label and value.
  for (const r of tableOf(lines("now")).rows) {
    const [label = "", value = ""] = r.cells.map(plain);
    if (label && value) p.now.push({ label, value });
    else if (label || value) skip(heading("now"), r.text, "a row needs a label and a value");
  }

  const expKeys = new Set<string>();
  {
    const t = tableOf(lines("experience"));
    const c = { period: col(t, "period", "when", "dates"), role: col(t, "role", "title"), org: col(t, "organisation", "organization", "org", "company", "where"), what: col(t, "what i did", "what", "description"), lane: col(t, "lane", "kind", "type"), source: col(t, "source", "from note") };
    for (const r of t.rows) {
      const role = cell(r.cells, c.role);
      const org = cell(r.cells, c.org);
      if (!role && !org) {
        skip(heading("experience"), r.text, "a row needs a role or a place");
        continue;
      }
      const period = cell(r.cells, c.period);
      const when = parsePeriod(period);
      if (!when) skip(heading("experience"), r.text, period ? `the period "${period}" could not be read` : "the row has no period");
      p.experience.push({ key: keyOf(`${org} ${role}`, expKeys), period, when, role, org, what: cell(r.cells, c.what), lane: cell(r.cells, c.lane) || "Other", source: sourceCell(r.cells, c.source) });
    }
  }

  // Skills and people first: a project's cells are matched against their names.
  const skillKeys = new Set<string>();
  const skillRows: { name: string; level: string; proof: string; text: string }[] = [];
  {
    const t = tableOf(lines("skills"));
    const c = { name: col(t, "skill", "name"), level: col(t, "level", "out of"), proof: col(t, "proof", "proved by", "where") };
    for (const r of t.rows) {
      const name = cell(r.cells, c.name);
      if (!name) {
        skip(heading("skills"), r.text, "a row needs a skill");
        continue;
      }
      if (/^also$/i.test(name)) {
        p.skillsAlso = cell(r.cells, c.proof) || cell(r.cells, c.level);
        continue;
      }
      skillRows.push({ name, level: cell(r.cells, c.level), proof: r.cells[c.proof] ?? "", text: r.text });
    }
    p.skillNotes = paragraphs(t.rest).map(plain);
  }
  const personKeys = new Set<string>();
  {
    const t = tableOf(lines("people"));
    const c = { name: col(t, "person", "name", "who"), role: col(t, "role"), how: col(t, "how we work together", "how", "relation", "together") };
    for (const r of t.rows) {
      const name = cell(r.cells, c.name);
      if (!name) {
        skip(heading("people"), r.text, "a row needs a name");
        continue;
      }
      p.people.push({ key: keyOf(name, personKeys), name, role: cell(r.cells, c.role), how: cell(r.cells, c.how) });
    }
  }

  const projectKeys = new Set<string>();
  const orgs = [...new Set(p.experience.map((e) => e.org).filter(Boolean))];
  {
    const t = tableOf(lines("projects"));
    const c = {
      name: col(t, "project", "name"),
      when: col(t, "when", "period", "dates"),
      what: col(t, "what it is", "what"),
      part: col(t, "my part", "part", "role"),
      outcome: col(t, "outcome", "result"),
      skills: col(t, "skills", "built with"),
      people: col(t, "people", "with"),
      partOf: col(t, "part of", "partof", "where"),
      outside: col(t, "outside use", "outside"),
      source: col(t, "source", "from note"),
    };
    const skillNames = skillRows.map((s) => s.name);
    const peopleNames = p.people.map((x) => x.name);
    for (const r of t.rows) {
      const rawName = cell(r.cells, c.name);
      const name = rawName.replace(/^[★*]+\s*/, "").trim();
      if (!name) {
        skip(heading("projects"), r.text, "a row needs a project name");
        continue;
      }
      const period = cell(r.cells, c.when);
      p.projects.push({
        key: keyOf(name, projectKeys),
        name,
        star: /^[★]/.test(rawName) || /^\*\s/.test(rawName),
        period,
        when: parsePeriod(period),
        what: cell(r.cells, c.what),
        part: cell(r.cells, c.part),
        outcome: cell(r.cells, c.outcome),
        skills: c.skills >= 0 ? namesIn(r.cells[c.skills] ?? "", skillNames) : [],
        people: c.people >= 0 ? namesIn(r.cells[c.people] ?? "", peopleNames) : [],
        partOf: c.partOf >= 0 ? namesIn(r.cells[c.partOf] ?? "", orgs) : [],
        outside: cell(r.cells, c.outside),
        source: sourceCell(r.cells, c.source),
      });
    }
  }
  const projectNames = p.projects.map((x) => x.name);
  for (const s of skillRows) {
    const lv = s.level.replace(/\s*\/\s*10$/, "");
    const level = lv === "" ? null : Number(lv.replace(",", "."));
    if (lv !== "" && !(Number.isFinite(level) && level! >= 0 && level! <= 10)) skip(heading("skills"), s.text, `the level "${s.level}" is not a number out of 10`);
    p.skills.push({ key: keyOf(s.name, skillKeys), name: s.name, level: lv !== "" && Number.isFinite(level) && level! >= 0 && level! <= 10 ? level : null, proof: namesIn(s.proof, projectNames).filter((n) => projectNames.includes(n)) });
  }

  {
    const t = tableOf(lines("proof"));
    const c = { number: col(t, "number", "figure", "value"), what: col(t, "what", "meaning", "for"), source: col(t, "source", "from") };
    const keys = new Set<string>();
    for (const r of t.rows) {
      const number = cell(r.cells, c.number);
      const what = cell(r.cells, c.what);
      if (!number || !what) {
        skip(heading("proof"), r.text, "a row needs a number and what it is");
        continue;
      }
      p.proof.push({ key: keyOf(`${number} ${what}`, keys), number, what, source: sourceOf(p, cell(r.cells, c.source), number, what) });
    }
    for (const para of paragraphs(t.rest)) {
      const m = /^\**([^:*]+?)\**\s*:\**\s*([\s\S]+)$/.exec(para);
      if (!m) continue;
      if (/^words from others/i.test(m[1]!)) p.proofWords = plain(m[2]!);
      else if (/^internal only/i.test(m[1]!)) p.proofInternal = plain(m[2]!);
    }
  }

  for (const b of bullets(lines("voice"))) {
    const m = /^\*\*([^*]+?):?\*\*:?\s*(.+)$/.exec(b);
    p.voice.push(m ? { label: m[1]!.replace(/:$/, "").trim(), text: plain(m[2]!) } : { label: null, text: plain(b) });
  }
  p.rules = bullets(lines("rules")).map(plain);
  p.interests = paragraphs(lines("interests")).map(plain).join("\n\n");
  const qKeys = new Set<string>();
  p.questions = bullets(lines("questions")).map((raw) => questionOf(raw, keyOf(plain(raw).slice(0, 40), qKeys)));
  return p;
}

/** The share of a name's longer words found in `text`. */
function overlap(name: string, text: string): number {
  const words = norm(name)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 2 && !["and", "the", "for", "with"].includes(w));
  if (words.length === 0) return 0;
  const t = norm(text);
  return words.filter((w) => t.includes(w)).length / words.length;
}

/** Where a proof point comes from: the Source cell when it names one, else the best match. */
function sourceOf(p: Persona, given: string, number: string, what: string): string | null {
  const things = [
    ...p.projects.map((x) => ({ key: `project:${x.key}`, name: x.name, text: `${x.what} ${x.outcome} ${x.part}` })),
    ...p.experience.map((x) => ({ key: `exp:${x.key}`, name: x.org, text: `${x.role} ${x.what}` })),
  ];
  if (given) {
    const exact = things.find((t) => norm(t.name) === norm(given));
    if (exact) return exact.key;
  }
  // A project is the more precise source: its name is tried before the places'.
  for (const kind of ["project:", "exp:"]) {
    let best: { key: string; score: number } | null = null;
    for (const t of things.filter((x) => x.key.startsWith(kind))) {
      const score = overlap(t.name, `${given} ${what}`);
      if (score >= 0.6 && (!best || score > best.score)) best = { key: t.key, score };
    }
    if (best) return best.key;
  }
  // The number itself, where one row quotes it ("114,000+" in the place's own words).
  const digits = /\d[\d.,]*/.exec(number)?.[0]?.replace(/[.,]$/, "");
  if (digits && digits.length >= 2) {
    const quoting = things.filter((t) => new RegExp(`(^|[^\\d])${digits.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\d]|$)`).test(t.text));
    if (quoting.length === 1) return quoting[0]!.key;
  }
  return null;
}

/**
 * The note's own text for the sections asked (all of them when none is), each under its `##`
 * heading as the note has it: what the agent and MCP's get_persona hand a model. Sections the
 * page does not read are left out, and so is code.
 */
export function personaText(content: string, want?: readonly PersonaSection[]): string {
  const out: string[] = [];
  const seen = new Set<PersonaSection>();
  for (const b of blocks(content)) {
    const s = sectionOf(b.heading);
    if (!s || seen.has(s) || (want && want.length > 0 && !want.includes(s))) continue;
    seen.add(s);
    out.push(`## ${b.heading}\n\n${b.lines.join("\n").trim()}`);
  }
  return out.join("\n\n");
}

/* ---- writing ------------------------------------------------------------------------------- */

/**
 * Write an answer into the open question it answers: the bullet gains "Answer: …" at its end,
 * so the note keeps the question, the answer and its date, and the page stops asking. Null when
 * the section's `index`th bullet is no longer `raw` (the note changed since it was read).
 */
export function answerQuestion(content: string, index: number, raw: string, answer: string, day: string): string | null {
  const { lines } = noteLines(content);
  const code = codeLines(lines);
  let inSection = false;
  let n = -1;
  for (let i = 0; i < lines.length; i++) {
    if (code[i]) continue;
    const h = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[i]!);
    if (h) {
      inSection = h[1]!.length === 2 ? sectionOf(h[2]!) === "questions" : inSection && h[1]!.length > 2;
      continue;
    }
    if (!inSection) continue;
    const m = /^(\s*[-*+]\s+)(.*\S)\s*$/.exec(lines[i]!);
    if (!m) continue;
    n++;
    if (n !== index) continue;
    if (m[2] !== raw) return null;
    const clean = answer.replace(/\s+/g, " ").trim();
    return spliceNoteLines(content, i, i + 1, [`${m[1]}${m[2]} **Answer (${day}):** ${clean}`]);
  }
  return null;
}

/** The numbers a text quotes ("8", "8.6", "114,000+", "10/10", "77 h"), as digits. */
export function numbersIn(text: string): string[] {
  return [...text.matchAll(/\d+(?:[.,]\d+)*/g)].map((m) => m[0].replace(/,(?=\d{3}\b)/g, "").replace(",", "."));
}

/**
 * The numbers in `draft` that the note does not hold anywhere: Orr may only quote numbers that
 * are in the persona (Proof points, mostly). Years and day-of-month counts are numbers too, so
 * the check is against the whole note's text, not only its proof points.
 */
export function unsourcedNumbers(draft: string, note: string): string[] {
  const known = new Set(numbersIn(note));
  return [...new Set(numbersIn(draft).filter((n) => !known.has(n)))];
}

/** A persona note with every heading and nothing in it: "Start from a blank one". */
export function blankPersona(name: string, day: string): string {
  const who = name.trim() || "me";
  return [
    "---",
    `title: ${JSON.stringify(`Persona — ${who}`)}`,
    "tags:",
    "  - persona",
    `updated: ${day}`,
    "---",
    "",
    `# Persona — ${who}`,
    "",
    "What Orrama knows about me, for introducing me and writing as me. Fill in what you like; the Me page shows each part once it has something in it.",
    "",
    "## In short",
    "",
    "### One line",
    "",
    "- **EN:** ",
    "",
    "### 30 seconds",
    "",
    "**EN:** ",
    "",
    "### 2 minutes",
    "",
    "**EN:** ",
    "",
    "## Now",
    "",
    "| | |",
    "|---|---|",
    "| Role | |",
    "| Based in | |",
    "| Languages | |",
    "",
    "## Experience",
    "",
    "| Period | Role | Organisation | What I did | Lane |",
    "|---|---|---|---|---|",
    "",
    "## Projects",
    "",
    "| Project | When | What it is | My part | Outcome | Skills | People | Part of | Outside use |",
    "|---|---|---|---|---|---|---|---|---|",
    "",
    "## Skills",
    "",
    "| Skill | Level | Proof |",
    "|---|---|---|",
    "",
    "## Proof points",
    "",
    "| Number | What |",
    "|---|---|",
    "",
    "## People",
    "",
    "| Person | Role | How we work together |",
    "|---|---|---|",
    "",
    "## Voice",
    "",
    "## Rules for outside use",
    "",
    "## Interests",
    "",
    "## Check with me",
    "",
  ].join("\n");
}
