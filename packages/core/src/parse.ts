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
 * Inline #tag. Must start a word boundary; allows letters, digits, -, _, and / for hierarchy.
 * Excludes pure-numeric "#123" (issue-reference style) and headings ("# Title" has a space).
 */
const TAG_RE = /(^|[\s(])#([A-Za-z][\w-]*(?:\/[\w-]+)*)/g;

const TASK_RE = /^(\s*)- \[( |x|X)\] (.*)$/;
const HEADING_RE = /^(#{1,6}) (.+)$/;
const ASSIGNEE_RE = /(^|\s)@([\w.-]+)/;
const DUE_RE = /(^|\s)due:(\d{4}-\d{2}-\d{2})/;
const START_RE = /(^|\s)start:(\d{4}-\d{2}-\d{2})/;
const PRIORITY_RE = /(^|\s)!p([123])\b/;
const BLOCK_ID_RE = /\s\^([\w-]+)\s*$/;
const FENCE_RE = /^(```|~~~)/;

function normalizeTag(t: string): string {
  return t.replace(/^#/, "").toLowerCase();
}

function parseTaskLine(line: number, raw: string): ParsedTask | null {
  const m = TASK_RE.exec(raw);
  if (!m) return null;
  const indent = m[1]!.length;
  const checked = m[2] !== " ";
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

  const clean = text
    .replace(new RegExp(ASSIGNEE_RE, "g"), "$1")
    .replace(new RegExp(DUE_RE, "g"), "$1")
    .replace(new RegExp(START_RE, "g"), "$1")
    .replace(new RegExp(PRIORITY_RE, "g"), "$1")
    .replace(/\s+/g, " ")
    .trim();

  return { line, checked, text: clean, raw, assignee, start, due, priority, blockId, indent };
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
    tags.push({ tag: normalizeTag(t), line: 0 });
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
