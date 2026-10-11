/**
 * Markdown sections as addressable slots.
 *
 * The project workspace stores everything in the project note — goals, the agent
 * prompt, decisions, the inbox, linked people — as `## Heading` sections, so the
 * page is a view over the note and the note stays readable on its own. These
 * helpers are the only place that turns a heading into a slot you can read,
 * replace or append to; every route goes through them so the rules are decided
 * once: a slot is a heading of its own level (`##` by default — a `### Goals`
 * inside another section is not the project's Goals) with an optional closing
 * `##`; fences hide headings; deeper headings belong to their parent; a
 * missing section is created at the end. A write replaces the slot's body
 * between its first and last non-blank line and touches no other byte —
 * not the blank lines around it, not the rest of the note (COR-007, COR-008).
 */

import { codeLines, noteLines, spliceNoteLines } from "./parse.js";

const HEADING = /^(#{1,6})\s+(.*?)\s*$/;
/** A closed ATX heading's trailing `#`s: `## Goals ##` is "Goals". */
const CLOSING = /(?:^|\s+)#+$/;

const norm = (s: string) => s.replace(CLOSING, "").trim().toLowerCase();

interface Found {
  /** Index of the heading line. */
  line: number;
  level: number;
  /** First body line (may equal `end`). */
  start: number;
  /** Exclusive end of the body — the next heading of same-or-higher level, or EOF. */
  end: number;
}

function find(lines: string[], heading: string, level: number): Found | null {
  const want = norm(heading);
  const code = codeLines(lines);
  let found: Found | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (code[i]) continue;
    const m = HEADING.exec(line);
    if (!m) continue;
    const at = m[1]!.length;

    if (found) {
      // A deeper heading is part of this section; same-or-higher ends it.
      if (at <= found.level) return { ...found, end: i };
      continue;
    }
    if (at === level && norm(m[2]!) === want) found = { line: i, level, start: i + 1, end: lines.length };
  }
  return found;
}

/** The slot's text: from its first to its last non-blank line ([s, e)); s === e when empty. */
function bodyOf(lines: string[], at: Found): { s: number; e: number } {
  let s = at.start;
  let e = at.end;
  while (s < e && lines[s]!.trim() === "") s++;
  while (e > s && lines[e - 1]!.trim() === "") e--;
  return { s, e };
}

/** Body of `## Heading`, without the blank lines around it. "" when absent. */
export function readSection(content: string, heading: string, level = 2): string {
  const { lines } = noteLines(content);
  const at = find(lines, heading, level);
  if (!at) return "";
  const { s, e } = bodyOf(lines, at);
  return lines.slice(s, e).join("\n");
}

/** Every `- ` / `* ` / `- [ ]` item of a section, as trimmed text (markers stripped). */
export function readSectionItems(content: string, heading: string): string[] {
  return readSection(content, heading)
    .split("\n")
    .map((l) => l.replace(/^\s*[-*]\s+(\[[ xX/b]\]\s+)?/, "").trim())
    .filter((l) => l !== "");
}

/**
 * Replace a section's body, creating the section at the end of the note when it
 * does not exist yet. An empty body leaves the heading in place with nothing
 * under it — the page still needs somewhere to write next time. Writing back
 * what `readSection` returned is byte-identical.
 */
export function writeSection(content: string, heading: string, body: string, level = 2): string {
  // Lines are read without CRLF's "\r" and written in the note's own ending (COR-012).
  const { lines, eol } = noteLines(content);
  const at = find(lines, heading, level);
  const bodyLines = body === "" ? [] : body.split(/\r?\n/);

  if (!at) {
    const head = content.replace(/\s+$/, "");
    return [head, "", `${"#".repeat(level)} ${heading}`, "", ...bodyLines, ""].join(`${eol}\n`);
  }
  const { s, e } = bodyOf(lines, at);
  if (s < e && bodyLines.length > 0) return spliceNoteLines(content, s, e, bodyLines);
  // Nothing there before, or nothing after: the heading, a blank line, the body, a blank line.
  const pad = bodyLines.length > 0 ? ["", ...bodyLines, ""] : [""];
  return spliceNoteLines(content, at.start, at.end, pad);
}

/** Append one line to a section (creating it if needed), newest last. */
export function appendToSection(content: string, heading: string, line: string, level = 2): string {
  const existing = readSection(content, heading, level);
  return writeSection(content, heading, existing === "" ? line : `${existing}\n${line}`, level);
}
