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
/** Inline #tag: starts a line, or follows a space or "(". */
export const TAG_RE = new RegExp(String.raw`(^|[\s(])#(${TAG_BODY})`, "gu");
const WHOLE_TAG = new RegExp(`^${TAG_BODY}$`, "u");

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
const FENCE_RE = /^(```|~~~)/;

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

  for (const t of frontmatterStrings(data["tags"])) {
    const tag = frontmatterTag(t);
    if (tag) tags.push({ tag, line: 0 });
  }

  let inFence = false;
  for (let i = bodyStart; i < lines.length; i++) {
    const line = lines[i]!;
    if (FENCE_RE.test(line.trimStart())) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue; // no links/tags/tasks inside code blocks

    const hm = HEADING_RE.exec(line);
    if (hm) headings.push({ level: hm[1]!.length, text: hm[2]!.trim(), line: i });

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
      let target = decodeURIComponent(pathPart ?? "").trim();
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
    if (task) tasks.push(task);
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
  };
}

/** Derive a display title from a vault path: "Team/Roadmap 2026.md" → "Roadmap 2026". */
export function titleFromPath(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.md$/i, "");
}
