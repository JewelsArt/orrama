import { parseFrontmatter } from "./frontmatter.js";
import type {
  Heading,
  NoteTag,
  ParsedNote,
  ParsedTask,
  TaskPriority,
  WikiLink,
} from "./types.js";

/** [[Target]] | [[Target|alias]] | [[Target#Heading]] | [[Target#Heading|alias]] */
const LINK_RE = /\[\[([^\[\]\|#]+)(?:#([^\[\]\|]+))?(?:\|([^\[\]]+))?\]\]/g;
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

/** `[/]` = in progress, `[b]` = blocked (the Obsidian Tasks / Minimal convention). */
const TASK_RE = /^(\s*)- \[( |x|X|\/|b)\] (.*)$/;
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
  const m = TASK_RE.exec(raw);
  if (!m) return null;
  const indent = m[1]!.length;
  const mark = m[2]!;
  const checked = mark === "x" || mark === "X";
  const status: ParsedTask["status"] = checked ? "done" : mark === "/" ? "in-progress" : mark === "b" ? "blocked" : "todo";
  let text = m[3]!;

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

function frontmatterStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  return [];
}

/** Title = front-matter `title` if present, else derived by the caller from the filename. */
export function parseNote(content: string, fallbackTitle = "Untitled"): ParsedNote {
  const { data, bodyStart } = parseFrontmatter(content);
  const lines = content.split("\n");

  const links: WikiLink[] = [];
  const tags: NoteTag[] = [];
  const tasks: ParsedTask[] = [];
  const headings: Heading[] = [];
  const blockIds = new Set<string>();

  for (const t of frontmatterStrings(data["tags"])) {
    const tag = frontmatterTag(t);
    if (tag) tags.push({ tag, line: 0 });
  }

  // A saved chat: front-matter tags count, its text does not (ParsedNote.kind).
  const conversation = data["type"] === "claude-session" || data["type"] === "conversation";

  const code = codeLines(lines.slice(bodyStart));
  for (let i = bodyStart; i < lines.length; i++) {
    const line = lines[i]!;
    if (code[i - bodyStart]) continue; // no links/tags/tasks inside code blocks

    const hm = HEADING_RE.exec(line);
    if (hm) headings.push({ level: hm[1]!.length, text: hm[2]!.trim(), line: i });
    if (conversation) continue; // headings only: no links, tags or tasks from a transcript

    for (const m of line.matchAll(LINK_RE)) {
      links.push({
        target: m[1]!.trim(),
        heading: m[2]?.trim(),
        alias: m[3]?.trim(),
        raw: m[0],
        line: i,
      });
    }

    for (const m of line.matchAll(MD_LINK_RE)) {
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

    // Strip inline code spans so `#not-a-tag` in code doesn't count.
    const noCode = line.replace(/`[^`]*`/g, "");
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

  const onlyTeams: string[] = [];
  const shareTeams: string[] = [];
  for (const { tag } of tags) {
    if (tag.startsWith("only/") && tag.length > 5) onlyTeams.push(tag.slice(5));
    else if (tag.startsWith("share/") && tag.length > 6) shareTeams.push(tag.slice(6));
  }

  const id = typeof data["id"] === "string" ? (data["id"] as string) : undefined;
  const title = typeof data["title"] === "string" ? (data["title"] as string) : fallbackTitle;
  const aliases = frontmatterStrings(data["aliases"]);

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
