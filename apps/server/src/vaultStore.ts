/**
 * The server's vault service: real Markdown files in a real folder tree on disk
 * (admins can rsync/git-backup it), an in-memory VaultIndex over them, and a
 * Y.Doc per note whose update log lives in SQLite for history + CRDT merge.
 * Every read surface goes through @basalt/core ACL — implemented once, used everywhere.
 */
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import { and, desc, eq, ne } from "drizzle-orm";
import * as Y from "yjs";
import {
  VaultIndex,
  canEdit,
  canRead,
  filterReadable,
  generateNoteId,
  parseFrontmatter,
  parseNote,
  titleFromPath,
  updateFrontmatter,
  validateEdit,
  type AclUser,
  type EditValidation,
  type FolderGrant,
  type IndexedNote,
  type ProjectDef,
} from "@basalt/core";
import { createNoteDoc, docContent, docFromUpdates, encodeStateB64, mergeText, SpliceMismatchError, updateDocContent } from "@basalt/sync";
import { tables, type Db } from "./db.js";
import { vaultDir } from "./env.js";
import { carriedId, chooseIdOwner } from "./noteIds.js";
import { writeFileAtomic } from "./atomicWrite.js";

/** How long after a folder appears it is read again (lookAgainLater). The
 *  gap it covers is microseconds wide; this is margin for a busy event loop. */
const NEW_FOLDER_LOOK_AGAIN_MS = 1000;

export const hash = (s: string) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);

export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export interface NoteChangedEvent {
  noteId: string;
  path: string;
  authorId: string | null;
}

/** One vault file as boot reads it, before anything is indexed. */
interface BootFile {
  abs: string;
  rel: string;
  content: string;
  id: string | undefined;
  birthtimeMs: number;
  mtimeMs: number;
}

export class VaultStore {
  index = new VaultIndex();
  /** Live-sync bus: "note-changed" (NoteChangedEvent) fired on every mutation. */
  readonly events = new EventEmitter();
  /**
   * noteId → Y.Doc, least recently used first. It was an unbounded Map: every
   * note ever opened or written kept its doc in memory for the life of the
   * process. An evicted doc is rebuilt from its (compacted) log on next use,
   * reconciled with the file — see doc().
   */
  private docs = new Map<string, Y.Doc>();
  private readonly docCacheSize: number;
  private root = vaultDir();
  /** Where the vault lives on disk. Read-only on purpose: mutations still go
   *  through write/move so the ACL and the index stay in the loop. Project
   *  documents (non-.md, so outside resolvePath) are laid out against this. */
  get vaultRoot(): string {
    return this.root;
  }
  /**
   * Paths this process has just written, mapped to the exact bytes it wrote, so
   * the watcher can recognise its own echo.
   *
   * This used to be a bare Set of paths, suppressed for a second after a write —
   * which silently DISCARDED any external edit landing inside that window, and
   * discarded it for good: nothing re-read the file afterwards, so the index
   * kept a stale copy indefinitely. Adding a subscription through the app and
   * then correcting a number in Obsidian a moment later did exactly that.
   * Comparing content instead of racing a clock means our own write is skipped
   * precisely when the file still holds what we put there, and a real edit is
   * never dropped no matter how fast it follows.
   */
  private inFlightWrites = new Map<string, string>();
  private watchTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
  private watcher: FSWatcher | null = null;
  /**
   * Settles once the watcher is attached to every folder. load() returns
   * before that: chokidar walks the tree asynchronously, and a file written
   * in between raised no event at all — an Obsidian save in the first moments
   * after a restart was never indexed. buildServer() waits on this.
   */
  watching: Promise<void> = Promise.resolve();

  /** Cheap content fingerprint for the echo check above. */
  private static digest(content: string): string {
    return crypto.createHash("sha1").update(content).digest("hex");
  }

  /** Remember what we just wrote so the watcher can ignore the resulting event.
   *  The timer only bounds memory: correctness comes from the digest. */
  private markWritten(relPath: string, content: string): void {
    this.inFlightWrites.set(relPath, VaultStore.digest(content));
    setTimeout(() => this.inFlightWrites.delete(relPath), 5000);
  }

  constructor(
    private db: Db,
    opts: { docCacheSize?: number } = {},
  ) {
    this.docCacheSize = Math.max(1, opts.docCacheSize ?? (Number(process.env.BASALT_DOC_CACHE) || 256));
  }

  /** Keep a doc, evicting the least recently used past the cap. */
  private cacheDoc(noteId: string, doc: Y.Doc): void {
    this.docs.delete(noteId);
    this.docs.set(noteId, doc);
    while (this.docs.size > this.docCacheSize) {
      const [oldest, old] = this.docs.entries().next().value as [string, Y.Doc];
      this.docs.delete(oldest);
      old.destroy();
    }
  }

  /** How many docs are held in memory (tests watch the cap). */
  get cachedDocs(): number {
    return this.docs.size;
  }

  /** Scan the vault folder, assign missing front-matter ids, hydrate index + notes table. */
  load(): void {
    fs.mkdirSync(this.root, { recursive: true });
    const entries = (dir: string): fs.Dirent[] => {
      try {
        return fs.readdirSync(dir, { withFileTypes: true });
      } catch (err) {
        // Same reason as the per-file guard below: a folder we cannot read
        // must cost that folder, not the whole boot.
        console.error(`[vault] ${path.relative(this.root, dir) || "."}: folder skipped at boot — ${err instanceof Error ? err.message : String(err)}`);
        return [];
      }
    };
    const walk = (dir: string): string[] =>
      entries(dir).flatMap((e) => {
        if (e.name.startsWith(".")) return [];
        if (dir === this.root && e.name === "CLAUDE.md") return [];
        const full = path.join(dir, e.name);
        if (e.isDirectory()) return walk(full);
        return e.name.toLowerCase().endsWith(".md") ? [full] : [];
      });
    // One file must not be able to stop the server booting. Under launchd's
    // KeepAlive a throw here is not an error page, it is a crash loop: the
    // agent restarts, meets the same file, and the whole app is down until
    // someone edits the database by hand. Skip it, loudly, and boot.
    const skip = (rel: string, err: unknown) =>
      console.error(`[vault] ${rel}: skipped at boot — ${err instanceof Error ? err.message : String(err)}`);
    // Read everything first: which of two files carrying one id keeps it is
    // decided over the whole vault, not by whichever the walk reached last.
    const files: BootFile[] = [];
    for (const abs of walk(this.root)) {
      const rel = path.relative(this.root, abs).split(path.sep).join("/");
      try {
        const content = fs.readFileSync(abs, "utf8");
        const stat = fs.statSync(abs);
        files.push({ abs, rel, content, id: carriedId(content), birthtimeMs: stat.birthtimeMs, mtimeMs: stat.mtimeMs });
      } catch (err) {
        skip(rel, err);
      }
    }
    const reassigned = this.settleDuplicateIds(files);
    for (const f of files) {
      try {
        this.loadOne(f, reassigned.get(f.rel));
      } catch (err) {
        skip(f.rel, err);
      }
    }

    const watcher = chokidar.watch(this.root, {
      ignored: (filePath: string, stats?: fs.Stats) => {
        const basename = path.basename(filePath);
        if (basename.startsWith(".")) return true;
        if (filePath === path.join(this.root, "CLAUDE.md")) return true;
        return false;
      },
      ignoreInitial: true,
    }).on("all", (event, absPath) => {
      if (event === "addDir") return this.lookAgainLater(absPath);
      if (!absPath.toLowerCase().endsWith(".md")) return;
      const relPath = path.relative(this.root, absPath).split(path.sep).join("/");
      // No early return on "we wrote this": whether it is our echo is decided in
      // handleExternalChange, by comparing the bytes on disk with what we wrote.
      this.settleLater(event, relPath, absPath);
    });
    // A note created and deleted in one breath — Basalt writes it, something
    // outside removes it a moment later — can reach chokidar as one coalesced
    // fs event: by the time chokidar looks, the file is gone, so it reports
    // neither "add" nor "unlink", and the note stayed in the index. The raw
    // event still names the file; if the index holds it and it is gone, settle
    // it the same way an unlink would be.
    watcher.on("raw", (_event: string, evPath: unknown, details: unknown) => {
      const watched = (details as { watchedPath?: unknown } | undefined)?.watchedPath;
      if (typeof evPath !== "string" || !evPath || typeof watched !== "string") return;
      // A folder's watcher names a child; a file's watcher names the file itself.
      const absPath = path.basename(watched) === evPath ? watched : path.resolve(watched, evPath);
      if (!absPath.toLowerCase().endsWith(".md") || path.basename(absPath).startsWith(".")) return;
      const relPath = path.relative(this.root, absPath).split(path.sep).join("/");
      if (relPath.startsWith("..") || !this.index.getByPath(relPath) || fs.existsSync(absPath)) return;
      this.settleLater("unlink", relPath, absPath);
    });
    // Without a listener, chokidar's "error" (EACCES on a folder or file the
    // server may not read) is thrown inside its own walk: an unhandled
    // rejection, which ends a Node process — under launchd's KeepAlive, a
    // crash loop, from the folder load() had already skipped politely. It
    // also left "ready" unfired, so boot waited forever.
    watcher.on("error", (err) => {
      console.error(`[vault] watcher: ${err instanceof Error ? err.message : String(err)} — that path is not watched`);
    });
    this.watcher = watcher;
    this.watching = new Promise((resolve) => watcher.once("ready", () => resolve()));
  }

  /** Debounce the watcher's events per path: the last one settles it, 300ms on. */
  private settleLater(event: string, relPath: string, absPath: string): void {
    const pending = this.watchTimeouts.get(relPath);
    if (pending) clearTimeout(pending);
    this.watchTimeouts.set(relPath, setTimeout(() => {
      this.watchTimeouts.delete(relPath);
      this.handleExternalChange(event, relPath, absPath);
    }, 300));
  }

  /**
   * A second look at a folder that just appeared. chokidar reads a new folder
   * and only then attaches fs.watch to it (`_handleDir` in its handler.js), so
   * a note — or a subfolder — that lands between the two raises no event and
   * stays unindexed until something else in that folder changes. On Linux
   * (inotify reports nothing from before the watch) that is a real miss; on
   * macOS FSEvents happens to deliver it. By the time this runs the watch is
   * attached: a note the index does not have is taken in, a subfolder chokidar
   * never saw is handed to it and looked at the same way.
   */
  private lookAgainLater(absDir: string): void {
    const key = `dir:${absDir}`;
    const pending = this.watchTimeouts.get(key);
    if (pending) clearTimeout(pending);
    this.watchTimeouts.set(key, setTimeout(() => {
      this.watchTimeouts.delete(key);
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(absDir, { withFileTypes: true });
      } catch {
        return; // gone again, or unreadable — chokidar reports those itself
      }
      const known = new Set(this.watcher?.getWatched()[absDir] ?? []);
      for (const e of entries) {
        if (e.name.startsWith(".")) continue;
        const abs = path.join(absDir, e.name);
        if (e.isDirectory()) {
          // add() is an initial add to chokidar: with ignoreInitial it reports
          // nothing inside, so this folder gets its own second look.
          if (!known.has(e.name)) {
            this.watcher?.add(abs);
            this.lookAgainLater(abs);
          }
          continue;
        }
        if (!e.isFile() || !e.name.toLowerCase().endsWith(".md")) continue;
        const rel = path.relative(this.root, abs).split(path.sep).join("/");
        if (this.index.getByPath(rel) || this.watchTimeouts.has(rel)) continue;
        this.handleExternalChange("add", rel, abs);
      }
    }, NEW_FOLDER_LOOK_AGAIN_MS));
  }

  /**
   * Boot: of several files carrying one id, which keeps it (noteIds.ts), and
   * what each of the others is given instead — the id the notes table has
   * for its own path, when no file claims that id (a note overwritten by a
   * copy of another keeps being itself), else a fresh one.
   */
  private settleDuplicateIds(files: BootFile[]): Map<string, { id: string; owner: string }> {
    const byId = new Map<string, BootFile[]>();
    for (const f of files) if (f.id) byId.set(f.id, [...(byId.get(f.id) ?? []), f]);
    const out = new Map<string, { id: string; owner: string }>();
    const taken = new Set(byId.keys());
    for (const [id, group] of byId) {
      if (group.length < 2) continue;
      const known = this.db.select({ path: tables.notes.path }).from(tables.notes).where(eq(tables.notes.id, id)).get()?.path;
      const owner = chooseIdOwner(group, known);
      for (const f of group) {
        if (f === owner) continue;
        const own = this.db.select({ id: tables.notes.id }).from(tables.notes).where(eq(tables.notes.path, f.rel)).get()?.id;
        const next = own && !taken.has(own) ? own : generateNoteId();
        taken.add(next);
        out.set(f.rel, { id: next, owner: owner.rel });
      }
    }
    return out;
  }

  /**
   * A copy's content with its own id stamped in, logged loudly — or null when
   * it cannot be stamped. (Front matter that does not parse carries no id, so
   * a file here always has some; the check is the backstop.)
   */
  private restamp(rel: string, content: string, id: string, ownerPath: string, next: string): string | null {
    const stamped = updateFrontmatter(content, (d) => ({ ...d, id: next }));
    if (carriedId(stamped) !== next) {
      console.error(`[vault] ${rel}: carries note id ${id}, which belongs to ${ownerPath}, and its front matter could not be given a new one — not indexed. Change or remove its id: line.`);
      return null;
    }
    console.warn(`[vault] ${rel}: carries note id ${id}, which belongs to ${ownerPath} (a copy made outside Basalt?) — gave it its own id ${next}.`);
    return stamped;
  }

  /**
   * The note the index holds under `id`, when it lives at another path and
   * its file is still there with that id — i.e. `rel` holding the same id is
   * a copy. When that file is gone or says otherwise, `rel` is the same note
   * renamed outside Basalt (its unlink not processed yet), and keeps the id.
   */
  private ownerElsewhere(id: string, rel: string): IndexedNote | undefined {
    const holder = this.index.get(id);
    if (!holder || holder.path === rel) return undefined;
    try {
      return carriedId(fs.readFileSync(path.join(this.root, holder.path), "utf8")) === id ? holder : undefined;
    } catch {
      return undefined;
    }
  }

  /** Index one file at boot, stamping an id if it has none, or its own if it
   *  carried another file's (settleDuplicateIds). */
  private loadOne(file: BootFile, reassign: { id: string; owner: string } | undefined): void {
    const { abs, rel } = file;
    let content = file.content;
    if (reassign) {
      const stamped = this.restamp(rel, content, file.id!, reassign.owner, reassign.id);
      if (stamped === null) return;
      content = stamped;
      writeFileAtomic(abs, content);
    }
    const parsed = parseNote(content, titleFromPath(rel));
    if (!parsed.id) {
      // Stamping an id means rewriting the file from its parsed front matter.
      // If that front matter did not parse, the rewrite would serialise an
      // empty object over the user's real metadata — title, tags, aliases,
      // deadline, and any #only/<team> restriction, which would WIDEN who can
      // read the note. Index it as it is and say so; a missing id costs
      // rename-safety for one note, which is recoverable. The metadata is not.
      if (parseFrontmatter(content).malformed) {
        console.warn(`[vault] ${rel}: front matter does not parse — indexed without stamping an id. Fix the YAML (an unquoted colon is the usual cause).`);
      } else {
        content = updateFrontmatter(content, (d) => ({ id: generateNoteId(), ...d }));
        writeFileAtomic(abs, content);
      }
    }
    const mtimeMs = fs.statSync(abs).mtimeMs;
    const note = this.index.upsert({ path: rel, content, mtimeMs });
    this.syncNoteRow(note);
    this.syncProjectRow(note);
  }

  /** Stop watching the vault. Called when the app closes, before the database
   *  is: "closed" tells listeners holding timers to drop them (webhooks.ts). */
  async close(): Promise<void> {
    for (const t of this.watchTimeouts.values()) clearTimeout(t);
    this.watchTimeouts.clear();
    await this.watcher?.close();
    this.watcher = null;
    this.events.emit("closed");
  }

  private handleExternalChange(event: string, relPath: string, absPath: string): void {
    if (event === "add" || event === "change") {
      try {
        // Gone again by the time the debounce settled: it is an unlink now,
        // whatever the event said (and a "raw" settle may have been replaced
        // by chokidar's own "add" for the same path).
        if (!fs.existsSync(absPath)) return this.forget(relPath);
        const content = fs.readFileSync(absPath, "utf8");

        // Our own write coming back round: the file still holds exactly what we
        // put there, so there is nothing to learn from it. Anything else is a
        // real edit — Obsidian, an editor, a script — and must be indexed even
        // if it lands microseconds after one of our writes.
        if (this.inFlightWrites.get(relPath) === VaultStore.digest(content)) {
          this.inFlightWrites.delete(relPath);
          return;
        }

        this.ingest(relPath, absPath, content);
      } catch (err) {
        console.error("Error handling external change", err);
      }
    } else if (event === "unlink") {
      // A save that replaces the file (ours are atomic: temp file, then rename;
      // some editors do the same) can reach us as unlink + add, and the two
      // share one debounce, so the unlink may be the one that fires. The file
      // is still there: it changed, it did not go.
      if (fs.existsSync(absPath)) return this.handleExternalChange("change", relPath, absPath);
      this.forget(relPath);
    }
  }

  /** The file at `relPath` is gone from disk: drop its note from the index. */
  private forget(relPath: string): void {
    const existing = this.index.getByPath(relPath);
    if (!existing) return;
    this.index.remove(relPath);
    this.db.update(tables.notes).set({ deleted: true, mtimeMs: Date.now() }).where(eq(tables.notes.id, existing.id)).run();
    this.db.update(tables.taskObjects).set({ status: "orphaned", updatedAt: Date.now() }).where(eq(tables.taskObjects.noteId, existing.id)).run();
    this.events.emit("note-removed", { noteId: existing.id, path: relPath });
  }

  /**
   * Take a file's current bytes into the index, the note's Y.Doc and its
   * history, as an edit by nobody in particular (Obsidian, an editor, a
   * script). The watcher calls this once its 300ms debounce settles; `write()`
   * calls it too when it finds the disk ahead of the index, so an edit is
   * recorded the same way whichever of the two notices it first.
   */
  private ingest(relPath: string, absPath: string, content: string): void {
    const parsed = parseNote(content, titleFromPath(relPath));
    const owner = parsed.id ? this.ownerElsewhere(parsed.id, relPath) : undefined;
    if (owner) {
      // A copy of another note. It becomes a note of its own; if this path
      // already was one (`cp A.md B.md` over B), it stays that note.
      const own = this.index.getByPath(relPath)?.id;
      const stamped = this.restamp(relPath, content, parsed.id!, owner.path, own ?? generateNoteId());
      if (stamped === null) return;
      content = stamped;
      this.markWritten(relPath, content);
      writeFileAtomic(absPath, content);
    } else if (!parsed.id) {
      // Same rule as load(): never rewrite a note whose front matter we
      // could not read. This path fires on every watcher event, so without
      // the guard one bad note is re-stamped — and re-flattened — forever.
      if (parseFrontmatter(content).malformed) {
        console.warn(`[vault] ${relPath}: front matter does not parse — indexed without stamping an id.`);
      } else {
        content = updateFrontmatter(content, (d) => ({ id: generateNoteId(), ...d }));
        this.markWritten(relPath, content);
        writeFileAtomic(absPath, content);
      }
    }
    
    const existing = this.index.getByPath(relPath);
    const mtimeMs = fs.statSync(absPath).mtimeMs;
    const note = this.index.upsert({ path: relPath, content, mtimeMs });

    if (existing && existing.id !== note.id) {
      // The file at this path now says it is a different note (its id was
      // edited, or it was replaced by a renamed note). The edit belongs to the
      // old note's history as it always did.
      const doc = this.doc(existing.id);
      const update = this.splice(existing.id, doc, content);
      if (update) this.logUpdate(existing.id, update, null);
    } else {
      this.recordContent(note.id, content, null);
    }

    this.syncNoteRow(note);
    this.syncProjectRow(note);
    this.reconcileTaskObjects(note);
    this.events.emit("note-changed", { noteId: note.id, path: note.path, authorId: null } satisfies NoteChangedEvent);
  }

  /**
   * Mirror an indexed note into the `notes` table (nothing reads it back; it
   * is a record of the vault, keyed by note id, with `path` unique).
   *
   * The index is the truth about which note lives at a path, so a row holding
   * this path under ANOTHER id gives way first. Without that, deleting a note
   * in Obsidian (the row is kept, flagged deleted) and making a new one with
   * the same name hit the unique path: the watcher logged an error, and the
   * next boot threw out of load() — which launchd's KeepAlive turned into a
   * crash loop. The same happened after a note was renamed over another.
   */
  private syncNoteRow(note: IndexedNote): void {
    this.db
      .delete(tables.notes)
      .where(and(eq(tables.notes.path, note.path), ne(tables.notes.id, note.id)))
      .run();
    this.db
      .insert(tables.notes)
      .values({
        id: note.id,
        path: note.path,
        title: note.title,
        contentHash: this.noteHash(note),
        mtimeMs: Math.round(note.mtimeMs ?? Date.now()),
        deleted: false,
      })
      .onConflictDoUpdate({
        target: tables.notes.id,
        set: { path: note.path, title: note.title, contentHash: this.noteHash(note), mtimeMs: Math.round(note.mtimeMs ?? Date.now()), deleted: false },
      })
      .run();
  }

  /**
   * Auto-register a project for each **front-matter** `project/<slug>` tag on the
   * note — so tagging a note is all it takes to put it on the board (the same way
   * every other surface is derived from the Markdown). Insert-if-absent: an
   * existing row's name/domain/team/hidden overrides are preserved, and a project
   * the owner removed (hidden=1) is never resurrected. Body mentions of
   * "project/…" (line ≠ 0) are ignored.
   */
  private syncProjectRow(note: IndexedNote): void {
    const keys = note.tags.filter((t) => t.line === 0 && /^project\/[a-z0-9][\w-]*$/i.test(t.tag)).map((t) => t.tag);
    for (const key of keys) {
      const existing = this.db.select().from(tables.projects).where(eq(tables.projects.key, key)).get();
      if (existing) continue;
      const domain = typeof note.frontmatter?.["domain"] === "string" ? (note.frontmatter["domain"] as string) : null;
      this.db
        .insert(tables.projects)
        .values({ id: `p-${crypto.randomUUID().slice(0, 8)}`, kind: "tag", key, name: note.title, teamId: null, domain, hidden: null })
        .run();
    }
  }

  doc(noteId: string): Y.Doc {
    let doc = this.docs.get(noteId);
    if (doc) {
      this.cacheDoc(noteId, doc); // most recently used
      return doc;
    }
    const log = this.db
      .select()
      .from(tables.ydocUpdates)
      .where(eq(tables.ydocUpdates.noteId, noteId))
      .orderBy(tables.ydocUpdates.id)
      .all();
    const note = this.index.get(noteId);
    if (log.length > 0) {
      doc = docFromUpdates(log.map((r) => r.update));
      // Disk may have moved ahead of the log (edited outside Basalt) — reconcile.
      if (note && docContent(doc) !== note.content) {
        const u = this.splice(noteId, doc, note.content);
        if (u) this.logUpdate(noteId, u, null);
      }
    } else {
      doc = createNoteDoc(note?.content ?? "");
      this.logUpdate(noteId, encodeStateB64(doc), null);
    }
    this.cacheDoc(noteId, doc);
    return doc;
  }

  /**
   * `updateDocContent`, forgetting the doc if the splice does not land as
   * asked (it throws rather than leave a doc that reads otherwise — audit
   * STO-001). The bad splice is never logged, so the doc is rebuilt clean
   * from the log next time it is needed.
   */
  private splice(noteId: string, doc: Y.Doc, content: string, origin?: unknown): string | null {
    try {
      return updateDocContent(doc, content, origin);
    } catch (err) {
      if (this.docs.get(noteId) === doc) this.docs.delete(noteId);
      doc.destroy();
      throw err;
    }
  }

  private logUpdate(noteId: string, update: string, authorId: string | null): void {
    this.db.insert(tables.ydocUpdates).values({ noteId, update, authorId, createdAt: Date.now() }).run();
  }

  /**
   * Bring a note's doc to `content` and record the change. Only a note with
   * no doc and no history starts a new doc. Starting one for a note that had
   * history — a note renamed outside Basalt, or deleted and put back — logged
   * a second, independent doc under the same id, and every replay after that
   * held the whole note twice.
   */
  private recordContent(noteId: string, content: string, authorId: string | null): void {
    const known =
      this.docs.has(noteId) ||
      !!this.db.select({ id: tables.ydocUpdates.id }).from(tables.ydocUpdates).where(eq(tables.ydocUpdates.noteId, noteId)).limit(1).get();
    if (!known) {
      const doc = createNoteDoc(content);
      this.cacheDoc(noteId, doc);
      this.logUpdate(noteId, encodeStateB64(doc), authorId);
      return;
    }
    const doc = this.doc(noteId);
    const update = this.splice(noteId, doc, content, authorId ?? undefined);
    if (update) this.logUpdate(noteId, update, authorId);
  }

  // ---- ACL plumbing -------------------------------------------------------

  aclUser(userId: string): AclUser {
    const user = this.db.select().from(tables.users).where(eq(tables.users.id, userId)).get();
    if (!user) throw new HttpError(401, "unknown user");
    const teamRows = this.db
      .select({ slug: tables.teams.slug })
      .from(tables.memberships)
      .innerJoin(tables.teams, eq(tables.memberships.teamId, tables.teams.id))
      .where(eq(tables.memberships.userId, userId))
      .all();
    return { id: user.id, username: user.username, teams: teamRows.map((t) => t.slug), isOwner: user.isOwner };
  }

  /**
   * aclUser for code that must not throw: event listeners. A listener that
   * throws throws INTO the emitter — store.write() — so one deleted account
   * with a webhook or an open socket made every note save a 500, after the
   * file was already written.
   */
  aclUserOrNull(userId: string): AclUser | null {
    try {
      return this.aclUser(userId);
    } catch {
      return null;
    }
  }

  grants(): FolderGrant[] {
    return this.db
      .select({ team: tables.teams.slug, folder: tables.folderGrants.folder, role: tables.folderGrants.role })
      .from(tables.folderGrants)
      .innerJoin(tables.teams, eq(tables.folderGrants.teamId, tables.teams.id))
      .all() as FolderGrant[];
  }

  projects(): ProjectDef[] {
    return this.db
      .select()
      .from(tables.projects)
      .all()
      .filter((p) => !p.hidden)
      .map((p) => ({ kind: p.kind, key: p.key, name: p.name }));
  }

  /**
   * A note's content hash, computed once per indexed version. The index hands
   * out a NEW object on every upsert, so keying on the object is the
   * invalidation. /api/vault/tree used to sha256 every note on every request.
   */
  private hashes = new WeakMap<IndexedNote, string>();
  noteHash(note: IndexedNote): string {
    let h = this.hashes.get(note);
    if (h === undefined) {
      h = hash(note.content);
      this.hashes.set(note, h);
    }
    return h;
  }

  readable(user: AclUser): IndexedNote[] {
    return filterReadable(user, this.index.all(), this.grants());
  }

  /** The vault's own CLAUDE.md (root, excluded from the index) — the "who I am /
   *  how to help me" doc, injected into the agent's system prompt as grounding. */
  vaultGuide(): string | null {
    try {
      const abs = path.join(this.root, "CLAUDE.md");
      if (!fs.existsSync(abs)) return null;
      return fs.readFileSync(abs, "utf8").slice(0, 8000);
    } catch {
      return null;
    }
  }

  requireReadable(user: AclUser, noteId: string): IndexedNote {
    const note = this.index.get(noteId);
    // 404 (not 403) for invisible notes: no existence confirmation (§5.4).
    if (!note || !canRead(user, note, this.grants())) throw new HttpError(404, "note not found");
    return note;
  }

  /**
   * For changes that live only in the DB — task status, assignee, dates, time
   * blocks. The file path already goes through `write()`, which checks edit;
   * these never touch the file, so read was all they asked for, and a `#share`
   * viewer (read-only by design) could reassign tasks and delete other people's
   * blocks (audit, high). 404 when unreadable, 403 when read-only.
   */
  requireEditable(user: AclUser, noteId: string): IndexedNote {
    const note = this.requireReadable(user, noteId);
    if (!canEdit(user, note, this.grants())) throw new HttpError(403, "no edit access to this note");
    return note;
  }

  // ---- Mutations (all server-enforced per §5.3) ---------------------------

  /**
   * Canonicalise a vault-relative path BEFORE anything derives a folder from it.
   * The folder the ACL judges must be the folder the bytes actually land in: with
   * a raw string, `Personal/<me>/../../Secret/x.md` reads as the caller's own
   * personal vault (canEdit → true) and then writes into `Secret/`. Escapes are
   * rejected here too — a bare `startsWith(root)` would accept a sibling
   * directory that merely shares the prefix (`../vault-evil/x.md`).
   *
   * Callers must use the returned `rel`/`abs`, never the string they passed in.
   */
  private resolvePath(input: string): { rel: string; abs: string } {
    const abs = path.resolve(this.root, input);
    const rel = path.relative(this.root, abs).split(path.sep).join("/");
    if (rel === "" || rel === ".." || rel.startsWith("../") || path.isAbsolute(rel)) {
      throw new HttpError(400, "invalid path");
    }
    if (!rel.toLowerCase().endsWith(".md")) throw new HttpError(400, "only .md files live in the vault");
    return { rel, abs };
  }

  /** Create or update a note. Returns the updated note. */
  write(user: AclUser, inputPath: string, content: string, baseHash?: string, baseContent?: string): IndexedNote {
    const { rel: relPath, abs } = this.resolvePath(inputPath);
    const grants = this.grants();
    let existing = this.index.getByPath(relPath);

    // The disk can be AHEAD of the index. The watcher waits 300ms for a burst of
    // saves to settle, and every route that edits a note — a checkbox toggle, a
    // decision logged, a project status — builds its new text from the index.
    // Writing that over the file erased whatever Obsidian had saved in the
    // meantime, and for good: our own write then matched the watcher's pending
    // event, which no-oped. So look first. An edit found there is recorded
    // exactly as the watcher would record it, and the caller's change is merged
    // on top, against the text the caller actually started from.
    if (existing) {
      const before = existing.content;
      if (fs.existsSync(abs)) {
        const onDisk = fs.readFileSync(abs, "utf8");
        if (onDisk !== before) {
          this.ingest(relPath, abs, onDisk);
          existing = this.index.getByPath(relPath);
        }
      }
      // Which text did the caller start from? Merge against THAT, so its edit
      // and everyone else's since both survive (packages/sync/src/merge.ts).
      //   - baseContent sent: the editor says so outright (NoteSync does).
      //   - no hash, or the hash of what we held before looking at the disk:
      //     every server route, and an editor that was up to date.
      //   - a stale hash and no text: nothing to merge against. Writing it
      //     anyway is how a stale editor erased other people's edits (audit
      //     B5), so refuse; every current client sends its base text. What
      //     is left sending this is a page loaded before that change.
      let base: string;
      if (baseContent !== undefined) {
        if (baseHash !== undefined && hash(baseContent) !== baseHash) throw new HttpError(400, "baseContent does not match baseHash");
        base = baseContent;
      } else if (baseHash === undefined || baseHash === hash(before)) {
        base = before;
      } else {
        throw new HttpError(409, "This note changed since it was opened. Reload it to keep editing.");
      }
      if (existing && base !== existing.content) content = mergeText(base, content, existing.content);
    }
    const after = parseNote(content, titleFromPath(relPath));
    const folder = relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : "";
    const afterAcl = { folder, onlyTeams: after.onlyTeams, shareTeams: after.shareTeams };

    let verdict: EditValidation;
    if (existing) {
      verdict = validateEdit(user, existing, afterAcl, grants);
    } else {
      // Creation: same rules with an empty-tag "before" in the target folder.
      verdict = validateEdit(user, { folder, onlyTeams: [], shareTeams: [] }, afterAcl, grants);
    }
    if (!verdict.ok) throw new HttpError(403, verdict.message);

    // Guarantee a stable id in front-matter (ids make renames link-safe, §10).
    let finalContent = content;
    const keepId = existing?.id;
    const parsedId = after.id;
    if (!parsedId) {
      finalContent = updateFrontmatter(content, (d) => ({ id: keepId ?? generateNoteId(), ...d }));
    } else if (keepId && parsedId !== keepId) {
      finalContent = updateFrontmatter(content, (d) => ({ ...d, id: keepId }));
    } else if (!keepId) {
      // A new note carrying another note's id — content pasted whole, or the
      // agent's write_note given a note to copy — is a copy, same as on disk.
      const owner = this.ownerElsewhere(parsedId, relPath);
      if (owner) {
        const stamped = this.restamp(relPath, content, parsedId, owner.path, generateNoteId());
        if (stamped === null) throw new HttpError(400, "this note carries another note's id");
        finalContent = stamped;
      }
    }

    if (existing) {
      const doc = this.doc(existing.id);
      // By here `content` already carries everyone's edits (merged above), so
      // one splice onto the live doc records it faithfully.
      let update: string | null;
      try {
        update = this.splice(existing.id, doc, finalContent, user.id);
      } catch (err) {
        // Nothing has been written yet, and nothing will be: refusing the
        // save is recoverable, damaged text in the vault is not.
        if (err instanceof SpliceMismatchError) throw new HttpError(500, "This edit could not be recorded exactly, so nothing was saved.");
        throw err;
      }
      if (update) this.logUpdate(existing.id, update, user.id);
      finalContent = docContent(doc);
    }

    fs.mkdirSync(path.dirname(abs), { recursive: true });
    this.markWritten(relPath, finalContent);
    writeFileAtomic(abs, finalContent);
    const note = this.index.upsert({ path: relPath, content: finalContent, mtimeMs: Date.now() });
    if (!existing) this.recordContent(note.id, finalContent, user.id);
    this.syncNoteRow(note);
    this.syncProjectRow(note);
    this.reconcileTaskObjects(note);
    this.events.emit("note-changed", { noteId: note.id, path: note.path, authorId: user.id } satisfies NoteChangedEvent);
    return note;
  }

  /** Rename/move: metadata operation, note id is stable so links never break (§10). */
  move(user: AclUser, inputFrom: string, inputTo: string): IndexedNote {
    // Both ends are canonicalised first, for the same reason as write(): the
    // destination folder the ACL judges must be where the file actually lands.
    const { rel: fromPath, abs: absFrom } = this.resolvePath(inputFrom);
    const { rel: toPath, abs: absTo } = this.resolvePath(inputTo);
    const note = this.index.getByPath(fromPath);
    if (!note || !canRead(user, note, this.grants())) throw new HttpError(404, "note not found");
    // fs.renameSync REPLACES an existing destination. Moving onto a note that
    // exists destroyed it on disk and then failed half-way (500), leaving the
    // index and the notes table disagreeing about the path — which stopped the
    // next boot. Checked on disk as well as in the index: the file may not
    // have been indexed yet, or may not be a note we can see.
    if (toPath !== fromPath && (this.index.getByPath(toPath) || fs.existsSync(absTo))) {
      throw new HttpError(409, "a note already exists at that path");
    }
    const toFolder = toPath.includes("/") ? toPath.slice(0, toPath.lastIndexOf("/")) : "";
    if (
      !canEdit(user, note, this.grants()) ||
      !canEdit(user, { folder: toFolder, onlyTeams: note.onlyTeams, shareTeams: note.shareTeams }, this.grants())
    ) {
      throw new HttpError(403, "need edit access to both source and destination folders");
    }
    fs.mkdirSync(path.dirname(absTo), { recursive: true });
    // A rename produces unlink+add; the destination arrives holding the note's
    // own bytes, so the digest recognises it. The source path is simply gone.
    this.markWritten(fromPath, note.content);
    this.markWritten(toPath, note.content);
    fs.renameSync(absFrom, absTo);
    this.index.remove(fromPath);
    const moved = this.index.upsert({ path: toPath, content: note.content, mtimeMs: Date.now() });
    this.syncNoteRow(moved);
    this.events.emit("note-changed", { noteId: moved.id, path: moved.path, authorId: user.id } satisfies NoteChangedEvent);
    return moved;
  }

  /**
   * Bring every task object in line with its file. Boot indexes notes without
   * reconciling, so an edit made while the server was down (a box ticked in
   * Obsidian, a `[/]` cleared) would otherwise wait for the note's next change.
   */
  reconcileAll(): void {
    for (const note of this.index.all()) this.reconcileTaskObjects(note);
  }

  /** Keep promoted task objects bound to their lines; orphan them when lines vanish (§7.2). */
  private reconcileTaskObjects(note: IndexedNote): void {
    const objects = this.db.select().from(tables.taskObjects).where(eq(tables.taskObjects.noteId, note.id)).all();
    if (objects.length === 0) return;
    const byBlock = new Map(note.tasks.filter((t) => t.blockId).map((t) => [t.blockId!, t]));
    for (const obj of objects) {
      const line = byBlock.get(obj.blockId);
      if (!line) {
        if (obj.status !== "orphaned") {
          this.db
            .update(tables.taskObjects)
            .set({ status: "orphaned", updatedAt: Date.now() })
            .where(eq(tables.taskObjects.id, obj.id))
            .run();
        }
      } else {
        // Two-way binding, file wins (§7.2): the checkbox IS the status — `[ ]`,
        // `[/]`, `[b]`, `[x]` — and a line that came back un-orphans its object.
        const fileStatus = line.status;
        if (fileStatus !== obj.status) {
          this.db
            .update(tables.taskObjects)
            .set({ status: fileStatus, updatedAt: Date.now() })
            .where(eq(tables.taskObjects.id, obj.id))
            .run();
        }
      }
    }
  }

  /**
   * The task object for a promoted line, created if it has none. Its fields
   * start from the line itself (status, due, assignee) — the file is the truth.
   */
  ensureTaskObject(noteId: string, blockId: string) {
    const found = this.taskObjectByBlock(noteId, blockId);
    if (found) return found;
    const parsed = this.index.get(noteId)?.tasks.find((t) => t.blockId === blockId);
    const assignee = parsed?.assignee ? this.db.select().from(tables.users).where(eq(tables.users.username, parsed.assignee)).get() : undefined;
    const now = Date.now();
    const fresh = {
      id: `task-${crypto.randomUUID().slice(0, 8)}`,
      noteId,
      blockId,
      status: parsed?.status ?? ("todo" as const),
      assigneeId: assignee?.id ?? null,
      due: parsed?.due ?? null,
      plannedDate: null,
      description: "",
      createdAt: now,
      updatedAt: now,
    };
    this.db.insert(tables.taskObjects).values(fresh).run();
    return fresh;
  }

  taskObjectByBlock(noteId: string, blockId: string) {
    return this.db
      .select()
      .from(tables.taskObjects)
      .where(and(eq(tables.taskObjects.noteId, noteId), eq(tables.taskObjects.blockId, blockId)))
      .get();
  }

  /** Most recent edit per user, for "who's working on what" (presence = edits, not surveillance). */
  lastEdits(): Map<string, { noteId: string; at: number }> {
    const rows = this.db
      .select()
      .from(tables.ydocUpdates)
      .orderBy(desc(tables.ydocUpdates.id))
      .limit(500)
      .all();
    const out = new Map<string, { noteId: string; at: number }>();
    for (const r of rows) {
      if (r.authorId && !out.has(r.authorId)) out.set(r.authorId, { noteId: r.noteId, at: r.createdAt });
    }
    return out;
  }
}
