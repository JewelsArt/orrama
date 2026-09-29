/**
 * Task line editing. Every mutation is a plain text transformation of the note
 * content — the Markdown file is always the source of truth (spec §7): dashboards
 * call these and write the result back through the normal edit path.
 */
import type { TaskState } from "./types.js";

const TASK_LINE_RE = /^(\s*- \[)( |x|X|\/|b)(\] .*)$/;
const MARK: Record<TaskState, string> = { todo: " ", "in-progress": "/", blocked: "b", done: "x" };

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
  return setTaskStatus(content, ref, checked ? "done" : "todo");
}

/**
 * Write a task's state into its checkbox: `[ ]`, `[/]`, `[b]` or `[x]`. An `[X]`
 * asked to be done again is left as it is. Returns null if the line is gone.
 */
export function setTaskStatus(content: string, ref: TaskLineRef, status: TaskState): string | null {
  const lines = content.split("\n");
  const idx = findTaskLine(lines, ref);
  if (idx === -1) return null;
  lines[idx] = lines[idx]!.replace(TASK_LINE_RE, (_, pre, cur, post) => `${pre}${status === "done" && cur === "X" ? "X" : MARK[status]}${post}`);
  return lines.join("\n");
}

export interface TaskDates {
  /** undefined = leave as-is, null = remove the token. */
  start?: string | null;
  due?: string | null;
}

/**
 * Rewrite the `start:`/`due:` tokens on a task line (Gantt drag/resize edits).
 * Tokens sit before the trailing block id so `^t-…` stays a line suffix.
 * Returns null if the referenced line is gone.
 */
export function setTaskDates(content: string, ref: TaskLineRef, dates: TaskDates): string | null {
  const lines = content.split("\n");
  const idx = findTaskLine(lines, ref);
  if (idx === -1) return null;
  const m = /^(\s*- \[(?: |x|X|\/|b)\] )(.*)$/.exec(lines[idx]!)!;
  let body = m[2]!;
  let blockSuffix = "";
  const bm = /\s\^[\w-]+\s*$/.exec(body);
  if (bm) {
    blockSuffix = body.slice(bm.index);
    body = body.slice(0, bm.index);
  }
  const rewrite = (text: string, token: "start" | "due", value: string | null | undefined): string => {
    if (value === undefined) return text;
    // Drop the token with its preceding space so neighbours don't end up double-spaced.
    const stripped = text.replace(new RegExp(`(^|\\s)${token}:\\d{4}-\\d{2}-\\d{2}(?=\\s|$)`, "g"), "").trim();
    return value === null ? stripped : `${stripped} ${token}:${value}`;
  };
  body = rewrite(rewrite(body, "start", dates.start), "due", dates.due);
  lines[idx] = `${m[1]}${body.replace(/\s+$/, "")}${blockSuffix}`;
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
