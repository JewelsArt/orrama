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
/** Lower-case, accents off: "Résumé" and "resume" are the same search. */
const fold = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
const WORD_RE = /[\p{L}\p{N}]+/gu;

export class VaultIndex {
  readonly notes = new Map<NoteId, IndexedNote>();
  private byPath = new Map<string, NoteId>();
  /** Per note, folded once at index time for search: see `search`. */
  private searchText = new Map<NoteId, { title: string; text: string; words: Map<string, number>; length: number }>();
  /** How many notes contain each folded word — the idf half of the ranking. */
  private docFreq = new Map<string, number>();
  /**
   * Link key (lower-cased) → every note it can name, with how strongly (see
   * linkKeys). It was one note per key, last writer wins: a copy whose
   * `title:` matched another note's filename took over every link to that
   * note, re-indexing either one flipped them back and forth, and removing
   * the one holding the key left the link to the other unresolved.
   */
  private byKey = new Map<string, Map<NoteId, number>>();

  constructor(files: VaultFile[] = []) {
    for (const f of files) this.upsert(f);
  }

  upsert(file: VaultFile): IndexedNote {
    const old = this.byPath.get(file.path);
    if (old) this.removeById(old);
    const parsed = parseNote(file.content, titleFromPath(file.path));
    const id = parsed.id ?? generateNoteId();
    // One id, one path. The same id arriving at another path is that note,
    // moved: its old path goes with it. Keeping both left the old path
    // pointing at the id while the id pointed at the new file, so deleting
    // either file removed the note that was still there. Two files that
    // really are different notes are the store's to tell apart — it gives the
    // copy its own id before it gets here (vaultStore.ts, claimId).
    if (this.notes.has(id)) this.removeById(id);
    const note: IndexedNote = {
      ...parsed,
      id,
      path: file.path,
      folder: folderOf(file.path),
      content: file.content,
      mtimeMs: file.mtimeMs,
    };
    this.notes.set(note.id, note);
    this.byPath.set(note.path, note.id);
    this.registerTitles(note);
    const text = fold(`${note.title}\n${note.content}`);
    const words = new Map<string, number>();
    for (const w of text.match(WORD_RE) ?? []) words.set(w, (words.get(w) ?? 0) + 1);
    for (const w of words.keys()) this.docFreq.set(w, (this.docFreq.get(w) ?? 0) + 1);
    this.searchText.set(note.id, { title: fold(note.title), text, words, length: [...words.values()].reduce((a, b) => a + b, 0) });
    return note;
  }

  remove(path: string): void {
    const id = this.byPath.get(path);
    if (id) this.removeById(id);
  }

  private removeById(id: NoteId): void {
    const note = this.notes.get(id);
    if (!note) return;
    for (const w of this.searchText.get(id)?.words.keys() ?? []) {
      const n = (this.docFreq.get(w) ?? 1) - 1;
      if (n > 0) this.docFreq.set(w, n);
      else this.docFreq.delete(w);
    }
    this.searchText.delete(id);
    this.notes.delete(id);
    this.byPath.delete(note.path);
    for (const [key] of this.linkKeys(note)) {
      const holders = this.byKey.get(key);
      holders?.delete(id);
      if (holders?.size === 0) this.byKey.delete(key);
    }
  }

  /**
   * Every string a link may legitimately use to mean this note, lower-cased,
   * with its rank — lower is stronger: the vault path, then the filename (what
   * Obsidian resolves a link by), then the title, then an alias. A string
   * that is several of these for one note keeps its strongest.
   */
  private linkKeys(note: IndexedNote): Map<string, number> {
    const keys = new Map<string, number>();
    const add = (k: string, rank: number) => {
      const key = k.toLowerCase();
      keys.set(key, Math.min(rank, keys.get(key) ?? rank));
    };
    add(note.path, 0);
    add(note.path.replace(/\.md$/i, ""), 0);
    add(titleFromPath(note.path), 1);
    add(note.title, 2);
    for (const a of note.aliases) add(a, 3);
    return keys;
  }

  private registerTitles(note: IndexedNote): void {
    for (const [key, rank] of this.linkKeys(note)) {
      let holders = this.byKey.get(key);
      if (!holders) this.byKey.set(key, (holders = new Map()));
      holders.set(note.id, rank);
    }
  }

  /**
   * The note a key names: the strongest rank wins; within a rank, the
   * greatest path in code-unit order. That tie-break is arbitrary but fixed —
   * it is what the boot walk used to leave in place (on the real vault in Sep
   * 2026, [[Scooperz]] stays Contacts/Companies/Scooperz.md, not the agent
   * note in 07-Claude/agents/) — and it no longer depends on which note
   * happened to be indexed last.
   */
  private byLinkKey(key: string): IndexedNote | undefined {
    let best: IndexedNote | undefined;
    let bestRank = Infinity;
    for (const [id, rank] of this.byKey.get(key) ?? []) {
      const note = this.notes.get(id);
      if (!note) continue;
      if (rank < bestRank || (rank === bestRank && best && note.path > best.path)) {
        best = note;
        bestRank = rank;
      }
    }
    return best;
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
      const note = this.byLinkKey(t.toLowerCase());
      if (note) return note;
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
      else terms.push(fold(token));
    }
    const hits = notes.filter((note) => {
      for (const f of filters) {
        if (f.key === "tag" && !note.tags.some((t) => t.tag === f.value || t.tag.startsWith(f.value + "/"))) return false;
        if (f.key === "path" && !note.path.toLowerCase().includes(f.value)) return false;
        if (f.key === "task" && !note.tasks.some((t) => t.text.toLowerCase().includes(f.value))) return false;
        if (f.key === "assignee" && !note.tasks.some((t) => t.assignee?.toLowerCase() === f.value)) return false;
      }
      // Still "every term is in the note" — a substring, so mid-word matches
      // keep working — but against text folded ONCE at index time.
      const text = this.searchText.get(note.id)?.text ?? "";
      return terms.every((t) => text.includes(t));
    });
    if (terms.length === 0) return hits;
    return this.rank(hits, terms);
  }

  /**
   * Best first: a term in the title outweighs any number of mentions, then a
   * BM25-style score over whole words starting with each term. Unranked, the
   * route's first-50 cut kept whatever came first in index order — a note with
   * the word in its title could be dropped behind 50 passing mentions.
   */
  private rank(hits: IndexedNote[], terms: string[]): IndexedNote[] {
    const n = this.notes.size;
    const avg = [...this.searchText.values()].reduce((a, s) => a + s.length, 0) / Math.max(1, this.searchText.size);
    const prefixDf = new Map<string, number>();
    const df = (term: string) => {
      let v = prefixDf.get(term);
      if (v === undefined) {
        v = 0;
        for (const [w, c] of this.docFreq) if (w.startsWith(term)) v = Math.max(v, c);
        prefixDf.set(term, v);
      }
      return v;
    };
    const score = (note: IndexedNote) => {
      const st = this.searchText.get(note.id)!;
      let total = 0;
      for (const term of terms) {
        if (st.title.includes(term)) total += 100;
        let tf = 0;
        for (const [w, c] of st.words) if (w.startsWith(term)) tf += c;
        const idf = Math.log(1 + (n - df(term) + 0.5) / (df(term) + 0.5));
        total += (idf * tf * 2.2) / (tf + 1.2 * (0.25 + (0.75 * st.length) / Math.max(1, avg)));
      }
      return total;
    };
    return hits
      .map((note) => ({ note, s: score(note) }))
      .sort((a, b) => b.s - a.s || (b.note.mtimeMs ?? 0) - (a.note.mtimeMs ?? 0))
      .map((x) => x.note);
  }

}
