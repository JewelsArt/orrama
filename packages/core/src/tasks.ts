/**
 * Task line editing. Every mutation is a plain text transformation of the note
 * content — the Markdown file is always the source of truth (spec §7): dashboards
 * call these and write the result back through the normal edit path.
 */
import { parseNote } from "./parse.js";
import type { ParsedTask, TaskState } from "./types.js";

const TASK_LINE_RE = /^(\s*- \[)( |x|X|\/|b)(\] .*)$/;
const MARK: Record<TaskState, string> = { todo: " ", "in-progress": "/", blocked: "b", done: "x" };

/**
 * Which task an edit means (audit COR-001). A promoted task is its block id.
 * Any other task is its text, as the caller saw it, with the line it saw it on
 * as a hint. A line index alone names nothing: the note can move under the
 * caller (an Obsidian edit, a decision appended above) and the edit would land
 * on whatever task slid into that line.
 */
export interface TaskLineRef {
  /** Stable block id (without ^): the task's identity once promoted. Never falls back to the line. */
  blockId?: string;
  /**
   * The task as the caller saw it: its raw line, or its display text
   * (`ParsedTask.raw` or `.text`). The checkbox mark and a trailing block id are
   * ignored, so a task ticked or promoted since is still the same task.
   */
  text?: string;
  /** 0-based line index the caller saw the task on: a hint that picks between identical tasks. */
  line?: number;
}

/** A task line's words: no indent, checkbox, trailing block id or extra spaces. */
const words = (s: string) =>
  s.replace(/^\s*- \[[ xX/b]\]\s*/, "").replace(/\s\^[\w-]+\s*$/, "").replace(/\s+/g, " ").trim();

function sameTask(t: ParsedTask, text: string): boolean {
  const w = words(text);
  return w !== "" && (w === words(t.raw) || w === t.text);
}

/**
 * The task `ref` names in `content`, read with the same parser the index uses
 * (code fences, front matter and transcripts included), or null when it is
 * gone or cannot be told apart from another.
 */
export function locateTask(content: string, ref: TaskLineRef): ParsedTask | null {
  const tasks = parseNote(content).tasks;
  if (ref.blockId) {
    const t = tasks.find((x) => x.blockId === ref.blockId);
    if (!t) return null;
    // The id belongs to its first line (COR-009). A caller pointing at a later
    // copy of that line by its text meant the copy: refuse rather than guess.
    if (ref.line !== undefined && ref.line !== t.line && ref.text !== undefined) {
      const there = tasks.find((x) => x.line === ref.line);
      if (there && sameTask(there, ref.text) && !sameTask(t, ref.text)) return null;
    }
    return t;
  }
  if (ref.text === undefined) return null;
  const at = ref.line === undefined ? undefined : tasks.find((x) => x.line === ref.line);
  if (at && sameTask(at, ref.text)) return at;
  const matches = tasks.filter((x) => sameTask(x, ref.text!));
  return matches.length === 1 ? matches[0]! : null;
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
  const task = locateTask(content, ref);
  if (!task) return null;
  const lines = content.split("\n");
  const idx = task.line;
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
  const task = locateTask(content, ref);
  if (!task) return null;
  const lines = content.split("\n");
  const idx = task.line;
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
 * Returns the new content and the id, or null if `ref` names no task. A line
 * that carries a copy of another line's id (COR-009) gets an id of its own.
 */
export function promoteTaskLine(
  content: string,
  ref: TaskLineRef,
): { content: string; blockId: string } | null {
  const task = locateTask(content, ref);
  if (!task) return null;
  if (task.blockId) return { content, blockId: task.blockId };
  const lines = content.split("\n");
  const taken = new Set(parseNote(content).tasks.flatMap((t) => (t.blockId ? [t.blockId] : [])));
  let blockId = generateBlockId();
  while (taken.has(blockId)) blockId = generateBlockId();
  lines[task.line] = `${lines[task.line]!.replace(/\s\^[\w-]+\s*$/, "").trimEnd()} ^${blockId}`;
  return { content: lines.join("\n"), blockId };
}

/** Quick capture (spec §6.5): append a line to a note body, creating a trailing newline politely. */
export function appendLine(content: string, line: string): string {
  if (content === "") return line + "\n";
  return content.endsWith("\n") ? `${content}${line}\n` : `${content}\n${line}\n`;
}
