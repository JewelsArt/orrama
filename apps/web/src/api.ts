/** Tiny typed fetch client. The server is the permission gate — the UI just renders. */

export interface Team {
  id: string;
  slug: string;
  name: string;
  color: string;
  icon: string;
  total?: number;
  done?: number;
}

/** Theme + palette, stored on the account so every device shows the same app. */
export interface Appearance {
  theme?: string;
  vision?: string;
  profiles?: { id: string; name: string; colors: string[] }[];
}

export interface Me {
  id: string;
  email: string;
  username: string;
  displayName: string;
  isOwner: boolean;
  avatar: string;
  appearance: Appearance | null;
  teams: Team[];
}

export interface TreeNote {
  id: string;
  path: string;
  folder: string;
  title: string;
  hash: string;
  mtimeMs?: number;
  tags: string[];
  openTasks: number;
}

export interface NoteLink {
  target: string;
  heading?: string;
  alias?: string;
  raw: string;
  line: number;
  targetId: string | null;
  locked: boolean;
}

export interface NoteDetail {
  id: string;
  path: string;
  title: string;
  content: string;
  hash: string;
  tags: { tag: string; line: number }[];
  tasks: TaskLine[];
  links: NoteLink[];
  backlinks: { fromId: string; fromTitle: string; fromPath: string; line: number; context: string }[];
  canEdit: boolean;
}

export interface TaskLine {
  line: number;
  checked: boolean;
  text: string;
  raw: string;
  assignee?: string;
  start?: string;
  due?: string;
  priority?: number;
  blockId?: string;
  indent: number;
}

export interface TaskObject {
  id: string;
  noteId: string;
  blockId: string;
  status: "todo" | "in-progress" | "done" | "blocked" | "orphaned";
  assigneeId: string | null;
  due: string | null;
  description: string;
}

export interface DashboardTask extends TaskLine {
  noteId: string;
  notePath: string;
  noteTitle: string;
  project: string | null;
  object: TaskObject | null;
}

export interface DashboardData {
  team: Team;
  projects: {
    project: string;
    projectId: string | null;
    slug: string | null;
    /** Front-matter lifecycle: "", planning, on-track, at-risk, blocked, sleeping, cancelled, done. */
    status: string;
    total: number;
    done: number;
    assignees: string[];
    lastActivityMs?: number;
    domain: "personal" | "professional" | "academic" | null;
    tasks: DashboardTask[];
  }[];
  members: {
    id: string;
    username: string;
    displayName: string;
    avatar: string;
    openTasks: number;
    inProgress: { text: string; noteId: string; project: string | null }[];
    assigned: { text: string; noteId: string; due?: string; priority?: number }[];
    lastEdit: { id: string; title: string; at: number } | null;
  }[];
  orphaned: { id: string; noteId: string; blockId: string; updatedAt: number }[];
}

let token = localStorage.getItem("basalt-token") ?? "";

export function setToken(t: string) {
  token = t;
  localStorage.setItem("basalt-token", t);
}

export function clearToken() {
  token = "";
  localStorage.removeItem("basalt-token");
}

export async function api<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, data.error ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

/** Same auth as api(), but for bytes: project documents are behind the bearer
 *  token, so a plain <a href> would 401. */
export async function apiBlob(url: string): Promise<Blob> {
  const res = await fetch(url, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new ApiError(res.status, res.statusText);
  return res.blob();
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
