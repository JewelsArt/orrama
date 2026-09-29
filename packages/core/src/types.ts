/** Core domain types shared by desktop, web, and server. */

export type NoteId = string;
export type TeamId = string;
export type UserId = string;

export type Role = "viewer" | "editor" | "admin";

/** Workspace-level owner sits above all teams; modeled separately from per-team roles. */
export interface AclUser {
  id: UserId;
  /** Usernames are what `@mention` task assignees match against. */
  username: string;
  teams: TeamId[];
  isOwner: boolean;
}

/** A folder permission grant: (team, folder, role). Folder is a vault-relative path, "" = vault root. */
export interface FolderGrant {
  team: TeamId;
  folder: string;
  role: Role;
}

export interface WikiLink {
  /** Target note title as written (without alias/heading). */
  target: string;
  heading?: string;
  alias?: string;
  /** Raw text as written, e.g. "[[Note#H|alias]]". */
  raw: string;
  line: number;
}

export interface NoteTag {
  /** Normalized without '#', e.g. "project/atlas". */
  tag: string;
  line: number; // 0 = front-matter
}

export type TaskPriority = 1 | 2 | 3;

/**
 * Where a task stands, read off its checkbox: `[ ]` todo, `[/]` in progress,
 * `[b]` blocked, `[x]` done. The file is the only truth — the two middle states
 * used to live in the database alone and died with it (audit B10).
 */
export type TaskState = "todo" | "in-progress" | "blocked" | "done";

export interface ParsedTask {
  /** Line index in the note body (0-based over the full file). */
  line: number;
  /** True for `[x]` only — `[/]` and `[b]` are open work. */
  checked: boolean;
  status: TaskState;
  /** Task text with metadata tokens stripped. */
  text: string;
  /** Raw line content. */
  raw: string;
  assignee?: string;
  start?: string; // ISO date — bar start on the Gantt view
  due?: string; // ISO date
  priority?: TaskPriority;
  /**
   * A key deadline: the line carries `#deadline`. Priority cannot say this —
   * a thesis block marks nearly every task !p1 — so the calendar and the
   * dashboard draw these on their own, and first.
   */
  key?: boolean;
  /** Stable block id if promoted, without '^', e.g. "t-a1b2c3". */
  blockId?: string;
  indent: number;
}

export interface Heading {
  level: number;
  text: string;
  line: number;
}

export interface ParsedNote {
  /** Stable note id from front-matter (may be absent until assigned). */
  id?: NoteId;
  title: string;
  aliases: string[];
  frontmatter: Record<string, unknown>;
  /** Body start line (after front-matter). */
  bodyStart: number;
  links: WikiLink[];
  tags: NoteTag[];
  tasks: ParsedTask[];
  headings: Heading[];
  /** Reserved security namespaces extracted from tags. */
  onlyTeams: TeamId[];
  shareTeams: TeamId[];
}

export interface VaultFile {
  /** Vault-relative path, POSIX separators, e.g. "Engineering/Roadmap.md". */
  path: string;
  content: string;
  mtimeMs?: number;
}

export interface IndexedNote extends ParsedNote {
  id: NoteId;
  path: string;
  folder: string;
  content: string;
  mtimeMs?: number;
}

export interface Backlink {
  fromId: NoteId;
  fromTitle: string;
  fromPath: string;
  line: number;
  context: string;
}

/** A task with its note + project context, as surfaced on dashboards. */
export interface VaultTask extends ParsedTask {
  noteId: NoteId;
  notePath: string;
  noteTitle: string;
  project: string | null;
}

export interface ProjectProgress {
  project: string;
  total: number;
  done: number;
  /** Usernames with open tasks in this project. */
  assignees: string[];
  lastActivityMs?: number;
}
