/**
 * Markdown sections as addressable slots.
 *
 * The project workspace stores everything in the project note — goals, the agent
 * prompt, decisions, the inbox, linked people — as `## Heading` sections, so the
 * page is a view over the note and the note stays readable on its own. These
 * helpers are the only place that turns a heading into a slot you can read,
 * replace or append to; every route goes through them so the rules (fence-aware,
 * nested headings belong to their parent, missing section is created at the end)
 * are decided once.
 */

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^(#{1,6})\s+(.*?)\s*$/;

const norm = (s: string) => s.trim().toLowerCase();

interface Found {
  /** Index of the heading line. */
  line: number;
  level: number;
  /** First body line (may equal `end`). */
  start: number;
  /** Exclusive end of the body — the next heading of same-or-higher level, or EOF. */
  end: number;
}

function find(lines: string[], heading: string): Found | null {
  const want = norm(heading);
  let inFence = false;
  let found: Found | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = HEADING.exec(line);
    if (!m) continue;
    const level = m[1]!.length;

    if (found) {
      // A deeper heading is part of this section; same-or-higher ends it.
      if (level <= found.level) return { ...found, end: i };
      continue;
    }
    if (norm(m[2]!) === want) found = { line: i, level, start: i + 1, end: lines.length };
  }
  return found;
}

/** Body of `## Heading`, trimmed of surrounding blank lines. "" when absent. */
export function readSection(content: string, heading: string): string {
  const lines = content.split("\n");
  const at = find(lines, heading);
  if (!at) return "";
  return lines.slice(at.start, at.end).join("\n").replace(/^\s*\n+/, "").replace(/\s+$/, "");
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
 * under it — the page still needs somewhere to write next time.
 */
export function writeSection(content: string, heading: string, body: string, level = 2): string {
  const lines = content.split("\n");
  const at = find(lines, heading);
  const bodyLines = body === "" ? [] : body.split("\n");

  if (!at) {
    const head = content.replace(/\s+$/, "");
    return [head, "", `${"#".repeat(level)} ${heading}`, "", ...bodyLines, ""].join("\n");
  }
  const before = lines.slice(0, at.start);
  const after = lines.slice(at.end);
  return [...before, "", ...bodyLines, "", ...after].join("\n").replace(/\n{3,}/g, "\n\n");
}

/** Append one line to a section (creating it if needed), newest last. */
export function appendToSection(content: string, heading: string, line: string, level = 2): string {
  const existing = readSection(content, heading);
  return writeSection(content, heading, existing === "" ? line : `${existing}\n${line}`, level);
}
