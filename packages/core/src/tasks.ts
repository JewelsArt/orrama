/**
 * Task line editing. Every mutation is a plain text transformation of the note
 * content — the Markdown file is always the source of truth (spec §7): dashboards
 * call these and write the result back through the normal edit path.
 */
import { noteLines, parseNote, spliceNoteLines, TASK_HEAD_RE, TASK_LINE_RE } from "./parse.js";
import { appendToSection } from "./sections.js";
import type { ParsedTask, TaskPriority, TaskState } from "./types.js";

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
  s.replace(TASK_HEAD_RE, "").replace(/\s\^[\w-]+\s*$/, "").replace(/\s+/g, " ").trim();

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
  const line = noteLines(content).lines[task.line]!;
  const next = line.replace(TASK_LINE_RE, (_, pre, cur, post) => `${pre}${status === "done" && cur === "X" ? "X" : MARK[status]}${post}`);
  return spliceNoteLines(content, task.line, task.line + 1, [next]);
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
  const m = TASK_LINE_RE.exec(noteLines(content).lines[task.line]!)!;
  const head = `${m[1]}${m[2]}] `;
  let body = m[3]!.slice(2);
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
  return spliceNoteLines(content, task.line, task.line + 1, [`${head}${body.replace(/\s+$/, "")}${blockSuffix}`]);
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
  const taken = new Set(parseNote(content).tasks.flatMap((t) => (t.blockId ? [t.blockId] : [])));
  let blockId = generateBlockId();
  while (taken.has(blockId)) blockId = generateBlockId();
  const line = `${noteLines(content).lines[task.line]!.replace(/\s\^[\w-]+\s*$/, "").trimEnd()} ^${blockId}`;
  return { content: spliceNoteLines(content, task.line, task.line + 1, [line]), blockId };
}

/**
 * Quick capture (spec §6.5): append a line to a note body, creating a trailing
 * newline politely — in the note's own line ending (COR-012).
 */
export function appendLine(content: string, line: string): string {
  if (content === "") return line + "\n";
  const nl = noteLines(content).eol + "\n";
  return content.endsWith("\n") ? `${content}${line}${nl}` : `${content}${nl}${line}${nl}`;
}

/** The tokens a step's card sets, as the parser reads them (parse.ts): dates, priority, the key-deadline tag. */
const TOKEN = {
  due: /(^|\s)due:\d{4}-\d{2}-\d{2}(?=\s|$)/g,
  start: /(^|\s)start:\d{4}-\d{2}-\d{2}(?=\s|$)/g,
  priority: /(^|\s)!p[123]\b/g,
  key: /(^|\s)#deadline(?![\w/-])/gi,
} as const;
const ANY_TOKEN = /(^|\s)(due:\d{4}-\d{2}-\d{2}(?=\s|$)|start:\d{4}-\d{2}-\d{2}(?=\s|$)|!p[123]\b|#deadline(?![\w/-]))/gi;
const BLOCK_SUFFIX = /\s\^[\w-]+\s*$/;

/** A task line cut into what an edit keeps (`head`: indent, marker, box; `suffix`: the block id) and its `body`. */
function cutLine(line: string): { head: string; mark: string; body: string; suffix: string } {
  const m = TASK_LINE_RE.exec(line)!;
  let body = m[3]!.slice(2);
  const bm = BLOCK_SUFFIX.exec(body);
  const suffix = bm ? body.slice(bm.index) : "";
  if (bm) body = body.slice(0, bm.index);
  return { head: m[1]!, mark: m[2]!, body, suffix };
}

/**
 * A step's words as a person types them: its line without the checkbox, the block id and the
 * tokens its card sets (due, start, priority, `#deadline`). Inline Markdown, links, other tags
 * and an `@name` stay: they are the person's words. What the card's title field edits.
 */
export function taskWords(raw: string): string {
  if (!TASK_LINE_RE.test(raw)) return "";
  return cutLine(raw).body.replace(ANY_TOKEN, "$1").replace(/\s+/g, " ").trim();
}

/** What the card changes on a step. `undefined` leaves a part as it is; `null` removes it. */
export interface TaskEdit {
  /** New words (see taskWords): the tokens and the block id are kept, in their order, after them. */
  words?: string;
  due?: string | null;
  start?: string | null;
  priority?: TaskPriority | null;
  /** The key-deadline tag, `#deadline`. */
  key?: boolean;
  status?: TaskState;
}

/** One token set, cleared or replaced where it stands; a new one goes at the end of the words. */
function setToken(body: string, re: RegExp, value: string | null): string {
  let placed = false;
  const out = body.replace(new RegExp(re.source, re.flags), (_, pre: string) => {
    if (value === null || placed) return "";
    placed = true;
    return `${pre}${value}`;
  });
  if (value === null || placed) return out;
  return `${out.replace(/\s+$/, "")} ${value}`;
}

/**
 * Rewrite one step's line the way a person would: the words, a date, the priority, the
 * key-deadline tag or the box, each on its own, and nothing else on the line or in the note
 * (CRLF kept, the block id last). Returns null when `ref` names no task in `content` as it is
 * now (the caller answers 409), and throws on words that are no step (empty, several lines).
 */
export function editTaskLine(content: string, ref: TaskLineRef, edit: TaskEdit): string | null {
  const task = locateTask(content, ref);
  if (!task) return null;
  const { head, mark, suffix, body: before } = cutLine(noteLines(content).lines[task.line]!);
  let body = before;
  if (edit.words !== undefined) {
    const words = edit.words.replace(/\s+/g, " ").trim();
    if (words === "" || /[\r\n]/.test(edit.words)) throw new Error("a step needs its words, on one line");
    if (words !== taskWords(`- [ ] ${body}`)) {
      const tokens = [...body.matchAll(ANY_TOKEN)].map((m) => m[2]!);
      body = [words, ...tokens].join(" ");
    }
  }
  if (edit.due !== undefined) body = setToken(body, TOKEN.due, edit.due === null ? null : `due:${edit.due}`);
  if (edit.start !== undefined) body = setToken(body, TOKEN.start, edit.start === null ? null : `start:${edit.start}`);
  if (edit.priority !== undefined) body = setToken(body, TOKEN.priority, edit.priority === null ? null : `!p${edit.priority}`);
  // A tag already there stays as it was written (`#Deadline` too).
  if (edit.key !== undefined && edit.key !== new RegExp(TOKEN.key.source, "i").test(body)) body = setToken(body, TOKEN.key, edit.key ? "#deadline" : null);
  const box = edit.status === undefined ? mark : edit.status === "done" && mark === "X" ? "X" : MARK[edit.status];
  if (body === before && box === mark) return content;
  const line = `${head}${box}] ${body.replace(/\s+$/, "")}${suffix}`;
  return spliceNoteLines(content, task.line, task.line + 1, [line]);
}

/**
 * Take a step's line out of its note: the content without it, the step as it was, and the line
 * as it goes elsewhere (`- [ ] words tokens ^id`: no indent, no quote, the box and the rest kept),
 * or null when `ref` names no task. The lines around it keep their bytes.
 */
export function removeTaskLine(content: string, ref: TaskLineRef): { content: string; task: ParsedTask; line: string } | null {
  const task = locateTask(content, ref);
  if (!task) return null;
  const { mark, body, suffix } = cutLine(noteLines(content).lines[task.line]!);
  return { content: spliceNoteLines(content, task.line, task.line + 1, []), task, line: `- [${mark}] ${body.trim()}${suffix}` };
}

/**
 * A step's line (from removeTaskLine) put into a note: last under `## section`, made at the end
 * of the note when it has none, or at the end of the note without a section. Null when the
 * note already holds another step with the line's block id: two lines may not share one.
 */
export function placeTaskLine(content: string, line: string, section?: string): string | null {
  const id = BLOCK_SUFFIX.exec(line)?.[0].trim().slice(1);
  if (id && parseNote(content).tasks.some((t) => t.blockId === id)) return null;
  return section ? appendToSection(content, section, line) : appendLine(content, line);
}
