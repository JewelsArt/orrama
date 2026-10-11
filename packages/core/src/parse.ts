import { parseFrontmatter } from "./frontmatter.js";
import type {
  Heading,
  NoteTag,
  ParsedNote,
  ParsedTask,
  TaskPriority,
  WikiLink,
} from "./types.js";

/**
 * [[Target]] | [[Target|alias]] | [[Target#Heading]] | [[Target#Heading|alias]],
 * and the alias pipe escaped as `\|`, which is how a link is written inside a
 * table — the target used to keep the backslash and resolve to nothing (audit
 * COR-015).
 */
const LINK_RE = /\[\[([^\[\]\|#]+?)(?:#([^\[\]\|]+?))?(?:\\?\|([^\[\]]+))?\]\]/g;
/**
 * A line without its inline code spans: a run of backticks, then anything up
 * to the next run of the same length (CommonMark); a run with no partner is
 * text. What is inside is code, not links or tags (COR-015). One pass over
 * the runs, not a backtracking regex: a long line of unmatched runs of
 * growing length is note text, and note text is untrusted.
 */
function stripCodeSpans(line: string): string {
  if (!line.includes("`")) return line;
  const runs = [...line.matchAll(/`+/g)].map((m) => ({ at: m.index, len: m[0].length }));
  const partner = new Array<number>(runs.length).fill(-1);
  const nextOfLen = new Map<number, number>();
  for (let i = runs.length - 1; i >= 0; i--) {
    partner[i] = nextOfLen.get(runs[i]!.len) ?? -1;
    nextOfLen.set(runs[i]!.len, i);
  }
  let out = "";
  let pos = 0;
  for (let i = 0; i < runs.length; i++) {
    const j = partner[i]!;
    if (j < 0) continue;
    out += line.slice(pos, runs[i]!.at);
    pos = runs[j]!.at + runs[j]!.len;
    i = j;
  }
  return out + line.slice(pos);
}
/**
 * Markdown-style links to other notes — `[text](Some Note.md)`, which Obsidian
 * treats as a link like any other. Skipped: anything with a scheme (http:,
 * mailto:) and anything that is not a .md target, so images and PDFs stay out
 * of the note graph.
 */
const MD_LINK_RE = /(!?)\[([^\]]*)\]\((<[^>]+>|[^)\s]+)(?:\s+"[^"]*")?\)/g;

/**
 * The tag grammar — one for inline `#tags`, front-matter `tags:` and the
 * editor's chips (apps/web livePreview.ts imports TAG_RE). A letter first, of
 * any script, then letters, accents, digits, `_` and `-`, with `/` between
 * segments. Any script because the ASCII-only version read `#réunion` as `r`
 * and `#été` as no tag at all. A letter first because that keeps `#0a0a0a` (a
 * colour), `#123` (an issue) and `# Title` (a heading) out.
 */
const TAG_BODY = String.raw`\p{L}[\p{L}\p{M}\p{N}_-]*(?:\/[\p{L}\p{M}\p{N}_-]+)*`;
/**
 * Not a colour: 3, 4, 6 or 8 hex digits with at least one digit among them
 * (`#d93025`, `#c9a84c`, `#f00`). A letter first was not enough — those start
 * with a letter. All-letter hex (`#ffffff`, `#cafe`) stays a tag, as in
 * Obsidian, since it is also a word.
 */
const NOT_COLOUR = String.raw`(?!(?=[0-9a-fA-F]*[0-9])(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\p{L}\p{M}\p{N}_\/-]))`;
/** Inline #tag: starts a line, or follows a space or "(". */
export const TAG_RE = new RegExp(String.raw`(^|[\s(])#${NOT_COLOUR}(${TAG_BODY})`, "gu");
const WHOLE_TAG = new RegExp(`^${NOT_COLOUR}${TAG_BODY}$`, "u");

/**
 * A task line, the one grammar for the parser and the task edits (tasks.ts):
 * `$1` everything up to the box's `[` — any blockquote/callout `>`s, the
 * indent, the list marker (`-`, `*`, `+`, `1.` or `1)`) and its spaces —
 * `$2` the mark, `$3` `] ` and the text. Every checkbox Obsidian draws is a
 * task (audit COR-014): only `- [ ]` used to be, so a numbered checklist or a
 * callout's tasks never reached the Dashboard. Edits rewrite `$2` or the
 * text, never `$1`, so a line keeps its marker and its quote.
 *
 * `[/]` = in progress, `[b]` = blocked (the Obsidian Tasks / Minimal convention).
 */
export const TASK_LINE_RE = /^((?:[ \t]*>)*[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\[)( |x|X|\/|b)(\] .*)$/;
/** A task line's head through its box, `- [ ] ` to `> 1. [x] `: what is left is the task's words. */
export const TASK_HEAD_RE = /^(?:[ \t]*>)*[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\[[ xX/b]\]\s*/;
/** `#deadline` on a task line: a key deadline (see ParsedTask.key). Still indexed as a tag. */
const KEY_DEADLINE_RE = /(^|\s)#deadline(?![\w/-])/i;
const HEADING_RE = /^(#{1,6}) (.+)$/;
const ASSIGNEE_RE = /(^|\s)@([\w.-]+)/;
const DUE_RE = /(^|\s)due:(\d{4}-\d{2}-\d{2})/;
const START_RE = /(^|\s)start:(\d{4}-\d{2}-\d{2})/;
const PRIORITY_RE = /(^|\s)!p([123])\b/;
const BLOCK_ID_RE = /\s\^([\w-]+)\s*$/;
/** A fence line: its indent, its run of ` or ~ (three or more), and what follows. */
const FENCE_RE = /^([ \t]*)(`{3,}|~{3,})(.*)$/;

/**
 * A note's lines without CRLF's "\r" (`lines`), each line's own "\r" beside
 * it (`cr`), and the "\r" new lines take — the note's first line break's
 * (`eol`). Line i is line i of `content.split("\n")`, as every line index in
 * the index counts. Every line regex here is anchored with `$`, and `.` does
 * not match "\r": a CRLF note read raw had no tasks and no headings, and its
 * task edits answered "not a task" (audit COR-012).
 */
export function noteLines(content: string): { lines: string[]; cr: string[]; eol: string } {
  const raw = content.split("\n");
  const nl = content.indexOf("\n");
  return {
    lines: raw.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l)),
    cr: raw.map((l) => (l.endsWith("\r") ? "\r" : "")),
    eol: nl > 0 && content[nl - 1] === "\r" ? "\r" : "",
  };
}

/**
 * `content` with lines [start, end) replaced by `insert` (lines without
 * terminators). Every other line keeps its own ending, byte for byte; the new
 * ones take the note's, so a CRLF note stays CRLF and an LF one LF (a section
 * write used to put LF lines into a CRLF file).
 */
export function spliceNoteLines(content: string, start: number, end: number, insert: readonly string[]): string {
  const { lines, cr, eol } = noteLines(content);
  // A line that was the last, with no ending, gains one when lines follow it.
  if (start >= lines.length && insert.length > 0) cr[lines.length - 1] = eol;
  const outLines = [...lines.slice(0, start), ...insert.map((l) => l.replace(/\r$/, "")), ...lines.slice(end)];
  const outCr = [...cr.slice(0, start), ...insert.map(() => eol), ...cr.slice(end)];
  return outLines.map((l, i) => (i === outLines.length - 1 ? l : l + outCr[i])).join("\n");
}

/** Leading whitespace as columns, a tab counting four. */
const indentOf = (ws: string) => [...ws].reduce((n, c) => n + (c === "\t" ? 4 : 1), 0);

/**
 * Which lines are code: each fence line and everything between, the way
 * CommonMark and Obsidian read them (audit COR-013). A fence closes only on a
 * line of its own character, at least as long as the opening run, with
 * nothing but spaces after it — a `~~~` block showing a ``` example, or a
 * ```` block wrapping a ``` one, is one block. A backtick fence's info string
 * cannot hold a backtick, so a one-line ```js``` is inline code, not a fence.
 * An unclosed fence runs to the end of the note.
 *
 * One exception to CommonMark, for lists: a fence indented four or more is
 * indented code in a paragraph's place but a fence inside a list item, and
 * this reader does not track list items. Such a line opens a fence only when
 * a line that would close it follows, so an indented ``` on its own never
 * swallows the rest of the note (and an `#only/<team>` in it, ACL-006).
 *
 * The one implementation for parse.ts and sections.ts: a fence the parser
 * skips is a fence the section helpers skip.
 */
export function codeLines(lines: readonly string[]): boolean[] {
  const out = new Array<boolean>(lines.length).fill(false);
  const closes = (line: string, char: string, len: number) => {
    const m = FENCE_RE.exec(line.replace(/\r$/, ""));
    return !!m && m[2]![0] === char && m[2]!.length >= len && m[3]!.trim() === "";
  };
  // Per character, the shortest run already known to have no closing line
  // after some earlier line — so no later one of at least that run has one
  // either, and a note of many indented openers is read once, not once each.
  const unclosed: Record<string, number> = {};
  for (let i = 0; i < lines.length; i++) {
    const m = FENCE_RE.exec(lines[i]!.replace(/\r$/, ""));
    if (!m) continue;
    const run = m[2]!;
    const char = run[0]!;
    if (char === "`" && m[3]!.includes("`")) continue;
    const indented = indentOf(m[1]!) >= 4;
    if (indented && run.length >= (unclosed[char] ?? Infinity)) continue;
    let end = i + 1;
    while (end < lines.length && !closes(lines[end]!, char, run.length)) end++;
    if (end === lines.length && indented) {
      unclosed[char] = Math.min(unclosed[char] ?? Infinity, run.length);
      continue;
    }
    for (let j = i; j <= end && j < lines.length; j++) out[j] = true;
    i = end;
  }
  return out;
}

/** Case-folded, and NFC so an accent typed as one character or as two is one tag. */
function normalizeTag(t: string): string {
  return t.trim().replace(/^#/, "").normalize("NFC").toLowerCase();
}

/**
 * A tag that reads as a path escape is not a tag.
 *
 * The tag grammar has no `.` or backslash, so a tag that passes it cannot be one —
 * but a malformed `only/…` front-matter tag is kept outside the grammar
 * (frontmatterTag), and a `project/<slug>` tag becomes a directory name in
 * routes/projects.ts. `routes/projects.ts` validates the slug itself; this is
 * the other end of the same hole, so a crafted tag never enters the index.
 */
const UNSAFE_TAG = /(^|\/)\.\.?(\/|$)|\\/;

/**
 * A front-matter tag, held to the inline grammar — they used to be taken as
 * written, so `tags: [my tag]` indexed a tag with a space in it, which no
 * `#tag` can ever be. Outside the grammar it is dropped, with one exception:
 * an `only/…` tag stays. A malformed one names no team, so it restricts the
 * note to owners; dropping it would open the note to every folder grant.
 */
function frontmatterTag(raw: string): string | null {
  const tag = normalizeTag(raw);
  if (!tag || UNSAFE_TAG.test(tag)) return null;
  if (WHOLE_TAG.test(tag)) return tag;
  return tag.startsWith("only/") ? tag : null;
}

/**
 * Inline Markdown off a task's display text: `**bold**`, `*em*`, `_em_`,
 * `~~struck~~`, `==highlight==`, `` `code` `` keep their words, `[[Note|alias]]`
 * becomes the alias (or the note name), `[text](url)` becomes the text.
 *
 * `text` is what every surface prints — Dashboard, Planning, Overview, the AI
 * plan — and none of them renders Markdown, so a thesis question written as
 * `**Does the Paris office…**` showed up with its asterisks. The source line is
 * untouched in `raw`; nothing writes `text` back to a file.
 *
 * Underscores only count as emphasis at word edges, so `snake_case_name` and a
 * `file_v2_final.pdf` survive.
 */
export function stripInlineMarkdown(s: string): string {
  return s
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, "$2")
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, "$1")
    .replace(/==(?=\S)(.+?)(?<=\S)==/g, "$1")
    .replace(/(^|[^\w*])\*(?=\S)([^*]+?)(?<=\S)\*(?![\w*])/g, "$1$2")
    .replace(/(^|[^\w_])_(?=\S)([^_]+?)(?<=\S)_(?![\w_])/g, "$1$2");
}

function parseTaskLine(line: number, raw: string): ParsedTask | null {
  const m = TASK_LINE_RE.exec(raw);
  if (!m) return null;
  // The list's own indent: a quote marker and the one space after it are not indent.
  const indent = /^[^-*+\d]*/.exec(m[1]!)![0].replace(/>[ \t]?/g, "").length;
  const mark = m[2]!;
  const checked = mark === "x" || mark === "X";
  const status: ParsedTask["status"] = checked ? "done" : mark === "/" ? "in-progress" : mark === "b" ? "blocked" : "todo";
  let text = m[3]!.slice(2);

  let blockId: string | undefined;
  const bm = BLOCK_ID_RE.exec(text);
  if (bm) {
    blockId = bm[1];
    text = text.slice(0, bm.index);
  }

  let assignee: string | undefined;
  const am = ASSIGNEE_RE.exec(text);
  if (am) assignee = am[2];

  let due: string | undefined;
  const dm = DUE_RE.exec(text);
  if (dm) due = dm[2];

  let start: string | undefined;
  const sm = START_RE.exec(text);
  if (sm) start = sm[2];

  let priority: TaskPriority | undefined;
  const pm = PRIORITY_RE.exec(text);
  if (pm) priority = Number(pm[2]) as TaskPriority;

  const key = KEY_DEADLINE_RE.test(text);
  const clean = stripInlineMarkdown(text)
    .replace(new RegExp(KEY_DEADLINE_RE, "gi"), "$1")
    .replace(new RegExp(ASSIGNEE_RE, "g"), "$1")
    .replace(new RegExp(DUE_RE, "g"), "$1")
    .replace(new RegExp(START_RE, "g"), "$1")
    .replace(new RegExp(PRIORITY_RE, "g"), "$1")
    .replace(/\s+/g, " ")
    .trim();

  return { line, checked, status, text: clean, raw, assignee, start, due, priority, blockId, indent, ...(key ? { key } : {}) };
}

/**
 * A markdown link target, `%20`-decoded — or as written when it is not valid
 * percent-encoding. `growth%.png` or `Budget 100% final.md` used to throw
 * URIError out of parseNote, and a note that throws is skipped at boot, left
 * stale by the watcher and refused on save (audit COR-002). parseNote must
 * never throw on user text.
 */
function decodeTarget(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * A front-matter list as Obsidian reads it (audit COR-018): a YAML list, or a
 * string of items split on `split` — `tags: project/thesis, active` is two
 * tags, as `tags: project/thesis active` is. Taking the string whole made it
 * one tag that failed the grammar, and the note lost every tag: its project,
 * its ledger, its `#only/<team>`.
 */
function frontmatterList(value: unknown, split: RegExp): string[] {
  if (typeof value === "string") return value.split(split).map((s) => s.trim()).filter(Boolean);
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  return [];
}

/** `tags:` and the singular `tag:`, both of which Obsidian reads. */
const frontmatterTags = (data: Record<string, unknown>) => [...frontmatterList(data["tags"], /[,\s]+/), ...frontmatterList(data["tag"], /[,\s]+/)];
/** `aliases:` and `alias:`; a string splits on commas only, since an alias has spaces. */
const frontmatterAliases = (data: Record<string, unknown>) => [...frontmatterList(data["aliases"], /,/), ...frontmatterList(data["alias"], /,/)];

/**
 * The team an `#only/` restriction names when it cannot be read: no team has
 * this slug (slugs are `[a-z0-9-]`), so the note is for owners only.
 */
export const OWNERS_ONLY = "(unreadable)";

/** `only/<team>` anywhere in a front-matter block's text, not inside a longer word or path. */
const RAW_ONLY_RE = /(?<![\p{L}\p{N}_\/.-])#?only\/([^\s,\[\]{}'"#|]*)/giu;

/**
 * The `#only/` teams a front-matter block names when YAML cannot parse it
 * (audit ACL-006). One unquoted colon — `title: Q3 Review: Ops`, which
 * Obsidian tolerates — empties the parsed data, and a restriction read only
 * from the parsed tags fell back to the folder grant: readable by everyone the
 * folder lets in. So the raw text is read for `only/<team>` instead, and a
 * mention whose team cannot be made out restricts the note to owners. Never
 * `share/`: a share widens who reads, and a block that does not parse is no
 * ground for that.
 */
function onlyTeamsOfRaw(raw: string): string[] {
  const teams: string[] = [];
  for (const m of raw.matchAll(RAW_ONLY_RE)) {
    const team = normalizeTag(m[1]!);
    teams.push(team && WHOLE_TAG.test(team) ? team : OWNERS_ONLY);
  }
  return teams;
}

/** Title = front-matter `title` if present, else derived by the caller from the filename. */
export function parseNote(content: string, fallbackTitle = "Untitled"): ParsedNote {
  const { data, bodyStart, raw, malformed } = parseFrontmatter(content);
  const { lines } = noteLines(content);

  const links: WikiLink[] = [];
  const tags: NoteTag[] = [];
  const tasks: ParsedTask[] = [];
  const headings: Heading[] = [];
  const blockIds = new Set<string>();

  for (const t of frontmatterTags(data)) {
    const tag = frontmatterTag(t);
    if (tag) tags.push({ tag, line: 0 });
  }

  // A saved chat: front-matter tags count, its text does not (ParsedNote.kind).
  const conversation = data["type"] === "claude-session" || data["type"] === "conversation";

  const code = codeLines(lines.slice(bodyStart));
  for (let i = bodyStart; i < lines.length; i++) {
    const line = lines[i]!;
    if (code[i - bodyStart]) continue; // no links/tags/tasks inside code blocks
    // Nor inside inline code: `[[example]]` and `#not-a-tag` are code (COR-015).
    const noCode = stripCodeSpans(line);

    const hm = HEADING_RE.exec(line);
    if (hm) headings.push({ level: hm[1]!.length, text: hm[2]!.trim(), line: i });
    if (conversation) continue; // headings only: no links, tags or tasks from a transcript

    for (const m of noCode.matchAll(LINK_RE)) {
      links.push({
        target: m[1]!.trim(),
        heading: m[2]?.trim(),
        alias: m[3]?.trim(),
        raw: m[0],
        line: i,
      });
    }

    for (const m of noCode.matchAll(MD_LINK_RE)) {
      const raw = m[3]!.replace(/^<|>$/g, "").trim();
      if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("#")) continue; // external or in-page
      const [pathPart, heading] = raw.split("#");
      let target = decodeTarget(pathPart ?? "").trim();
      if (!target.toLowerCase().endsWith(".md")) continue;
      target = target.replace(/\.md$/i, "").replace(/^\.\//, "");
      if (target === "") continue;
      links.push({
        target,
        heading: heading?.trim(),
        alias: m[2]?.trim() || undefined,
        raw: m[0],
        line: i,
      });
    }

    for (const m of noCode.matchAll(TAG_RE)) {
      tags.push({ tag: normalizeTag(m[2]!), line: i });
    }

    const task = parseTaskLine(i, line);
    if (task) {
      // A block id is one task. A line copied with its `^t-…` (Obsidian's
      // duplicate line) is a task of its own, addressed by its text until it
      // is promoted and given its own id (COR-009); the first line keeps it.
      if (task.blockId !== undefined) {
        if (blockIds.has(task.blockId)) delete task.blockId;
        else blockIds.add(task.blockId);
      }
      tasks.push(task);
    }
  }

  const onlyTeams: string[] = malformed ? onlyTeamsOfRaw(raw) : [];
  const shareTeams: string[] = [];
  for (const { tag } of tags) {
    // A front-matter `only/` naming no team still restricts: to owners.
    if (tag.startsWith("only/")) onlyTeams.push(tag.slice(5) || OWNERS_ONLY);
    else if (tag.startsWith("share/") && tag.length > 6) shareTeams.push(tag.slice(6));
  }

  const id = typeof data["id"] === "string" ? (data["id"] as string) : undefined;
  const title = typeof data["title"] === "string" ? (data["title"] as string) : fallbackTitle;
  const aliases = frontmatterAliases(data);

  return {
    id,
    title,
    aliases,
    frontmatter: data,
    bodyStart,
    links,
    tags,
    tasks,
    headings,
    onlyTeams: [...new Set(onlyTeams)],
    shareTeams: [...new Set(shareTeams)],
    kind: conversation ? "conversation" : "note",
  };
}

/** Derive a display title from a vault path: "Team/Roadmap 2026.md" → "Roadmap 2026". */
export function titleFromPath(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.md$/i, "");
}
