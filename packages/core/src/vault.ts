import { parseNote, titleFromPath } from "./parse.js";
import type {
  AclUser,
  Backlink,
  FolderGrant,
  IndexedNote,
  NoteId,
  ProjectProgress,
  VaultFile,
  VaultTask,
} from "./types.js";
import { filterReadable } from "./acl.js";

function folderOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
}

let counter = 0;
export function generateNoteId(): NoteId {
  // Time-sortable, collision-safe enough for a vault; stable ids live in front-matter.
  counter = (counter + 1) % 1296;
  return `n-${Date.now().toString(36)}${counter.toString(36).padStart(2, "0")}${Math.random()
    .toString(36)
    .slice(2, 6)}`;
}

export interface ProjectDef {
  /** "folder:Engineering" or "tag:project/atlas" */
  kind: "folder" | "tag";
  key: string;
  name: string;
}

/**
 * In-memory index over a set of vault files. Deterministic: rebuilt from Markdown
 * alone it must reproduce every dashboard number (spec §6 "view over the vault").
 */
export class VaultIndex {
  readonly notes = new Map<NoteId, IndexedNote>();
  private byPath = new Map<string, NoteId>();
  private byTitle = new Map<string, NoteId>();

  constructor(files: VaultFile[] = []) {
    for (const f of files) this.upsert(f);
  }

  upsert(file: VaultFile): IndexedNote {
    const old = this.byPath.get(file.path);
    if (old) this.removeById(old);
    const parsed = parseNote(file.content, titleFromPath(file.path));
    const note: IndexedNote = {
      ...parsed,
      id: parsed.id ?? generateNoteId(),
      path: file.path,
      folder: folderOf(file.path),
      content: file.content,
      mtimeMs: file.mtimeMs,
    };
    this.notes.set(note.id, note);
    this.byPath.set(note.path, note.id);
    this.registerTitles(note);
    return note;
  }

  remove(path: string): void {
    const id = this.byPath.get(path);
    if (id) this.removeById(id);
  }

  private removeById(id: NoteId): void {
    const note = this.notes.get(id);
    if (!note) return;
    this.notes.delete(id);
    this.byPath.delete(note.path);
    for (const key of this.linkKeys(note)) {
      if (this.byTitle.get(key.toLowerCase()) === id) this.byTitle.delete(key.toLowerCase());
    }
  }

  /** Every string a link may legitimately use to mean this note. */
  private linkKeys(note: IndexedNote): string[] {
    const noExt = note.path.replace(/\.md$/i, "");
    return [note.title, ...note.aliases, titleFromPath(note.path), noExt, note.path];
  }

  private registerTitles(note: IndexedNote): void {
    for (const key of this.linkKeys(note)) this.byTitle.set(key.toLowerCase(), note.id);
  }

  get(id: NoteId): IndexedNote | undefined {
    return this.notes.get(id);
  }

  getByPath(path: string): IndexedNote | undefined {
    const id = this.byPath.get(path);
    return id ? this.notes.get(id) : undefined;
  }

  /**
   * Resolve a link target to a note by title, alias, filename or vault path —
   * case-insensitively, with or without the `.md`, and tolerant of the `./` and
   * `%20` forms Obsidian writes into markdown-style links.
   */
  resolveLink(target: string): IndexedNote | undefined {
    let key = target.trim();
    if (key.includes("%")) {
      try {
        key = decodeURIComponent(key);
      } catch {
        // leave the raw string: a stray % is not our problem to fix
      }
    }
    key = key.replace(/^\.\//, "").replace(/\/+$/, "");
    const tries = [key, key.replace(/\.md$/i, "")];
    for (const t of tries) {
      const id = this.byTitle.get(t.toLowerCase());
      if (id) return this.notes.get(id);
    }
    return undefined;
  }

  all(): IndexedNote[] {
    return [...this.notes.values()];
  }

  /** Backlinks to a note: every readable note whose links resolve to it. */
  backlinks(id: NoteId, user?: AclUser, grants: FolderGrant[] = []): Backlink[] {
    const out: Backlink[] = [];
    const sources = user ? filterReadable(user, this.all(), grants) : this.all();
    for (const src of sources) {
      if (src.id === id) continue;
      for (const link of src.links) {
        if (this.resolveLink(link.target)?.id === id) {
          const context = src.content.split("\n")[link.line]?.trim() ?? "";
          out.push({ fromId: src.id, fromTitle: src.title, fromPath: src.path, line: link.line, context });
        }
      }
    }
    return out;
  }

  /** tag → note ids, hierarchical tags also indexed under each ancestor segment. */
  tagIndex(user?: AclUser, grants: FolderGrant[] = []): Map<string, Set<NoteId>> {
    const idx = new Map<string, Set<NoteId>>();
    const notes = user ? filterReadable(user, this.all(), grants) : this.all();
    for (const note of notes) {
      for (const { tag } of note.tags) {
        const parts = tag.split("/");
        for (let i = 1; i <= parts.length; i++) {
          const key = parts.slice(0, i).join("/");
          if (!idx.has(key)) idx.set(key, new Set());
          idx.get(key)!.add(note.id);
        }
      }
    }
    return idx;
  }

  /**
   * Project of a note (spec §7.1): nearest ancestor folder that is a project,
   * else its first `project/...` tag. Returns the project display name or null.
   */
  projectOf(note: IndexedNote, projects: ProjectDef[]): string | null {
    const folderProjects = projects.filter((p) => p.kind === "folder");
    let cur = note.folder;
    while (true) {
      const hit = folderProjects.find((p) => p.key === cur);
      if (hit) return hit.name;
      if (cur === "") break;
      const idx = cur.lastIndexOf("/");
      cur = idx === -1 ? "" : cur.slice(0, idx);
    }
    for (const { tag } of note.tags) {
      const hit = projects.find((p) => p.kind === "tag" && p.key === tag);
      if (hit) return hit.name;
    }
    return null;
  }

  /** All tasks across readable notes, with project attribution. */
  tasks(user: AclUser | undefined, grants: FolderGrant[], projects: ProjectDef[]): VaultTask[] {
    const notes = user ? filterReadable(user, this.all(), grants) : this.all();
    const out: VaultTask[] = [];
    for (const note of notes) {
      const project = this.projectOf(note, projects);
      for (const t of note.tasks) {
        out.push({ ...t, noteId: note.id, notePath: note.path, noteTitle: note.title, project });
      }
    }
    return out;
  }

  /** Real, computed progress per project — no manual status (spec §6.2). */
  progress(user: AclUser | undefined, grants: FolderGrant[], projects: ProjectDef[]): ProjectProgress[] {
    const byProject = new Map<string, ProjectProgress>();
    const notesByProject = new Map<string, number>();
    const notes = user ? filterReadable(user, this.all(), grants) : this.all();
    for (const note of notes) {
      const project = this.projectOf(note, projects);
      if (!project) continue;
      const mtime = note.mtimeMs ?? 0;
      notesByProject.set(project, Math.max(notesByProject.get(project) ?? 0, mtime));
    }
    for (const task of this.tasks(user, grants, projects)) {
      if (!task.project) continue;
      let p = byProject.get(task.project);
      if (!p) {
        p = { project: task.project, total: 0, done: 0, assignees: [], lastActivityMs: notesByProject.get(task.project) };
        byProject.set(task.project, p);
      }
      p.total++;
      if (task.checked) p.done++;
      else if (task.assignee && !p.assignees.includes(task.assignee)) p.assignees.push(task.assignee);
    }
    return [...byProject.values()].sort((a, b) => a.project.localeCompare(b.project));
  }

  /**
   * Full-vault search with `tag:` `path:` `task:` `assignee:` filters (spec §8).
   * Plain terms match title/content case-insensitively; ACL-filtered like everything else.
   */
  search(query: string, user?: AclUser, grants: FolderGrant[] = []): IndexedNote[] {
    const notes = user ? filterReadable(user, this.all(), grants) : this.all();
    const terms: string[] = [];
    const filters: { key: string; value: string }[] = [];
    for (const token of query.trim().split(/\s+/).filter(Boolean)) {
      const m = /^(tag|path|task|assignee):(.*)$/.exec(token);
      if (m && m[2]) filters.push({ key: m[1]!, value: m[2].toLowerCase() });
      else terms.push(token.toLowerCase());
    }
    return notes.filter((note) => {
      for (const f of filters) {
        if (f.key === "tag" && !note.tags.some((t) => t.tag === f.value || t.tag.startsWith(f.value + "/"))) return false;
        if (f.key === "path" && !note.path.toLowerCase().includes(f.value)) return false;
        if (f.key === "task" && !note.tasks.some((t) => t.text.toLowerCase().includes(f.value))) return false;
        if (f.key === "assignee" && !note.tasks.some((t) => t.assignee?.toLowerCase() === f.value)) return false;
      }
      const haystack = (note.title + "\n" + note.content).toLowerCase();
      return terms.every((t) => haystack.includes(t));
    });
  }
}
