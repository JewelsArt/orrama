/**
 * Task line editing. Every mutation is a plain text transformation of the note
 * content — the Markdown file is always the source of truth (spec §7): dashboards
 * call these and write the result back through the normal edit path.
 */

const TASK_LINE_RE = /^(\s*- \[)( |x|X)(\] .*)$/;

export interface TaskLineRef {
  /** 0-based line index; used when the task has no block id. */
  line?: number;
  /** Stable block id (without ^) — preferred, survives line moves. */
  blockId?: string;
}

function findTaskLine(lines: string[], ref: TaskLineRef): number {
  if (ref.blockId) {
    const suffix = `^${ref.blockId}`;
    const idx = lines.findIndex((l) => TASK_LINE_RE.test(l) && l.trimEnd().endsWith(suffix));
    if (idx !== -1) return idx;
  }
  if (ref.line !== undefined && lines[ref.line] !== undefined && TASK_LINE_RE.test(lines[ref.line]!)) {
    return ref.line;
  }
  return -1;
}

/** Check/uncheck a task. Returns null if the referenced line is gone (caller orphans the task object). */
export function setTaskChecked(content: string, ref: TaskLineRef, checked: boolean): string | null {
  const lines = content.split("\n");
  const idx = findTaskLine(lines, ref);
  if (idx === -1) return null;
  lines[idx] = lines[idx]!.replace(TASK_LINE_RE, (_, pre, _cur, post) => `${pre}${checked ? "x" : " "}${post}`);
  return lines.join("\n");
}

export function generateBlockId(): string {
  return `t-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Promote a checkbox: append a stable block id to the line (spec §7.2).
 * Returns the new content and the id, or null if the line is not a task.
 */
export function promoteTaskLine(
  content: string,
  line: number,
): { content: string; blockId: string } | null {
  const lines = content.split("\n");
  const raw = lines[line];
  if (raw === undefined || !TASK_LINE_RE.test(raw)) return null;
  const existing = /\s\^([\w-]+)\s*$/.exec(raw);
  if (existing) return { content, blockId: existing[1]! };
  const blockId = generateBlockId();
  lines[line] = `${raw.trimEnd()} ^${blockId}`;
  return { content: lines.join("\n"), blockId };
}

/** Quick capture (spec §6.5): append a line to a note body, creating a trailing newline politely. */
export function appendLine(content: string, line: string): string {
  if (content === "") return line + "\n";
  return content.endsWith("\n") ? `${content}${line}\n` : `${content}\n${line}\n`;
}
