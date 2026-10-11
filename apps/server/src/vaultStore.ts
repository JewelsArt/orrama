/**
 * The server's vault service: real Markdown files in a real folder tree on disk
 * (admins can rsync/git-backup it), an in-memory VaultIndex over them, and a
 * Y.Doc per note whose update log lives in SQLite for history + CRDT merge.
 * Every read surface goes through @basalt/core ACL — implemented once, used everywhere.
 */
import crypto from "node:crypto";
import { isUtf8 } from "node:buffer";
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
  parseNote,
  projectName,
  projectNoteFor,
  projectSlugOf,
  stampId,
  titleFromPath,
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
import { AmbiguousPathError, linksIntoVault, listedExactly, onDisk, sameFile, throughVaultLink } from "./diskPath.js";

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

/** A caller's own check on one write: throws (an HttpError) to refuse it. `path` is canonical, `content` already merged. */
export type WriteGuard = (w: { path: string; before: IndexedNote | null; content: string }) => void;

/**
 * A vault file's text, and whether its bytes really are UTF-8. Decoding
 * anything else as UTF-8 replaces every invalid byte with U+FFFD; writing that
 * back (an id stamp on first sight) destroyed every accent in a Windows-1252
 * note and turned a UTF-16 one into NUL-riddled mojibake (audit STO-011). Such
 * a note is read — searchable, linkable — and never written.
 */
function readNote(abs: string): { content: string; utf8: boolean } {
  const buf = fs.readFileSync(abs);
  return { content: buf.toString("utf8"), utf8: isUtf8(buf) };
}

/** Whether a path is a folder once links are followed (false if it is gone). */
function isFolder(abs: string): boolean {
  try {
    return fs.statSync(abs).isDirectory();
  } catch {
    return false;
  }
}

const NOT_UTF8 = "is not UTF-8 text, so Basalt reads it but will not write to it. Save it as UTF-8 to edit it here.";

/** One vault file as boot reads it, before anything is indexed. */
interface BootFile {
  abs: string;
  rel: string;
  content: string;
  utf8: boolean;
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
  /** The vault folder with links resolved; set by load(). */
  private realRoot = this.root;
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
    // A folder linked in from elsewhere is part of the vault (audit STO-010):
    // Obsidian follows it, the watcher follows it and resolvePath writes
    // through it, and a walk that took only real directories (a symlink's
    // Dirent is not one) dropped its notes at every restart. A link back into
    // the vault is a second name for notes it already has and is skipped
    // (linksIntoVault); each real folder is walked once besides.
    this.realRoot = fs.realpathSync(this.root);
    const walked = new Set<string>();
    const walk = (dir: string): string[] => {
      let real: string;
      try {
        real = fs.realpathSync(dir);
      } catch {
        return [];
      }
      if (walked.has(real)) return [];
      walked.add(real);
      return entries(dir).flatMap((e) => {
        if (e.name.startsWith(".")) return [];
        if (dir === this.root && e.name === "CLAUDE.md") return [];
        const full = path.join(dir, e.name);
        if (e.isSymbolicLink() && linksIntoVault(this.realRoot, full)) return [];
        if (e.isDirectory() || (e.isSymbolicLink() && isFolder(full))) return walk(full);
        return e.name.toLowerCase().endsWith(".md") ? [full] : [];
      });
    };
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
        const { content, utf8 } = readNote(abs);
        const stat = fs.statSync(abs);
        files.push({ abs, rel, content, utf8, id: carriedId(content), birthtimeMs: stat.birthtimeMs, mtimeMs: stat.mtimeMs });
      } catch (err) {
        skip(rel, err);
      }
    }
    const reassigned = this.settleDuplicateIds(files);
    const fallback = this.bootIds(files, reassigned);
    for (const f of files) {
      try {
        this.loadOne(f, reassigned.get(f.rel), fallback.get(f.rel)!);
      } catch (err) {
        skip(f.rel, err);
      }
    }

    const watcher = chokidar.watch(this.root, {
      ignored: (filePath: string, stats?: fs.Stats) => {
        const basename = path.basename(filePath);
        if (basename.startsWith(".")) return true;
        if (filePath === path.join(this.root, "CLAUDE.md")) return true;
        return linksIntoVault(this.realRoot, filePath);
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
      if (relPath.startsWith("..") || !this.index.getByPath(relPath) || listedExactly(this.root, relPath)) return;
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
   * Boot: the id each file that carries none is indexed under — stamped into
   * it when it can be, kept in the index alone when it cannot (front matter
   * that does not parse, a numeric `id:`, a file that is not UTF-8). The
   * notes table's id for the path when no file claims it, so such a note is
   * the same note across restarts (audit STO-003); otherwise a fresh one.
   */
  private bootIds(files: BootFile[], reassigned: Map<string, { id: string; owner: string }>): Map<string, string> {
    const taken = new Set<string>([...files.flatMap((f) => (f.id ? [f.id] : [])), ...[...reassigned.values()].map((r) => r.id)]);
    const out = new Map<string, string>();
    for (const f of files) {
      if (f.id) continue;
      const known = this.db.select({ id: tables.notes.id }).from(tables.notes).where(eq(tables.notes.path, f.rel)).get()?.id;
      const id = known && !taken.has(known) ? known : generateNoteId();
      taken.add(id);
      out.set(f.rel, id);
    }
    return out;
  }

  /**
   * A copy's content with its own id stamped in, logged loudly — or null when
   * it cannot be stamped (stampId says why; the file is left as it is).
   */
  private restamp(rel: string, content: string, id: string, ownerPath: string, next: string): string | null {
    const stamped = stampId(content, next);
    if (!stamped.ok) {
      console.error(`[vault] ${rel}: carries note id ${id}, which belongs to ${ownerPath}, and cannot be given a new one: ${stamped.reason} — not indexed. Change or remove its id: line.`);
      return null;
    }
    console.warn(`[vault] ${rel}: carries note id ${id}, which belongs to ${ownerPath} (a copy made outside Basalt?) — gave it its own id ${next}.`);
    return stamped.content;
  }

  /**
   * Content with `id` stamped in, when that changes nothing else in the file
   * — or the content as it is, logged, when it would (front matter that does
   * not parse or is not a mapping, a user's own non-text `id:`, bytes that are
   * not UTF-8). Never rewrite what was not parsed (audit STO-002/003/011).
   */
  private stampOrKeep(rel: string, content: string, utf8: boolean, id: string): { content: string; stamped: boolean } {
    if (!utf8) {
      console.warn(`[vault] ${rel}: ${NOT_UTF8}`);
      return { content, stamped: false };
    }
    const s = stampId(content, id);
    if (s.ok) return { content: s.content, stamped: true };
    console.warn(`[vault] ${rel}: indexed without stamping an id — ${s.reason}. Its id is kept by path until it can be.`);
    return { content, stamped: false };
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
    const holderAbs = path.join(this.root, holder.path);
    // On a case-insensitive volume the holder's old spelling still opens a
    // file after a case-only rename — THIS file. Reading it "confirmed" a copy,
    // and restamping each spelling as a copy of the other ran forever (audit
    // STO-012). The holder is elsewhere only if the directory still lists its
    // name and that name is another file (a second name for the same file is
    // sameNameElsewhere's case).
    if (!listedExactly(this.root, holder.path) || sameFile(holderAbs, path.join(this.root, rel))) return undefined;
    try {
      return carriedId(fs.readFileSync(holderAbs, "utf8")) === id ? holder : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * The note the index holds under `id` when `rel` is a second name for the
   * very same file — two links to one folder, a hard link — and the first
   * name is still there. One file is one note: the second name is left out,
   * or each event would move the note from one name to the other.
   */
  private sameNameElsewhere(id: string, rel: string): IndexedNote | undefined {
    const holder = this.index.get(id);
    if (!holder || holder.path === rel) return undefined;
    return listedExactly(this.root, holder.path) && sameFile(path.join(this.root, holder.path), path.join(this.root, rel)) ? holder : undefined;
  }

  /** Index one file at boot, stamping an id if it has none, or its own if it
   *  carried another file's (settleDuplicateIds). */
  private loadOne(file: BootFile, reassign: { id: string; owner: string } | undefined, fallbackId: string | undefined): void {
    const { abs, rel } = file;
    let content = file.content;
    if (reassign) {
      if (!file.utf8) {
        console.error(`[vault] ${rel}: carries note id ${file.id}, which belongs to ${reassign.owner}, and ${NOT_UTF8} Not indexed.`);
        return;
      }
      const stamped = this.restamp(rel, content, file.id!, reassign.owner, reassign.id);
      if (stamped === null) return;
      content = stamped;
      writeFileAtomic(abs, content);
    }
    const parsed = parseNote(content, titleFromPath(rel));
    if (!parsed.id && fallbackId) {
      // Stamp only what round-trips. A note that cannot be stamped is indexed
      // as it is, under the id its path already had: a missing id in the file
      // costs rename-safety for one note, which is recoverable. Rewriting
      // metadata (or prose, or bytes) that was not parsed is not.
      const s = this.stampOrKeep(rel, content, file.utf8, fallbackId);
      content = s.content;
      if (s.stamped) writeFileAtomic(abs, content);
    }
    const mtimeMs = fs.statSync(abs).mtimeMs;
    const note = this.index.upsert({ path: rel, content, mtimeMs, id: fallbackId });
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
        // by chokidar's own "add" for the same path). Gone includes "renamed
        // to another spelling": existsSync says yes to every spelling of a
        // file on a case-insensitive volume, the directory listing does not.
        if (!listedExactly(this.root, relPath)) return this.forget(relPath);
        const { content, utf8 } = readNote(absPath);

        // Our own write coming back round: the file still holds exactly what we
        // put there, so there is nothing to learn from it. Anything else is a
        // real edit — Obsidian, an editor, a script — and must be indexed even
        // if it lands microseconds after one of our writes.
        if (this.inFlightWrites.get(relPath) === VaultStore.digest(content)) {
          this.inFlightWrites.delete(relPath);
          return;
        }

        this.ingest(relPath, absPath, content, utf8);
      } catch (err) {
        console.error("Error handling external change", err);
      }
    } else if (event === "unlink") {
      // A save that replaces the file (ours are atomic: temp file, then rename;
      // some editors do the same) can reach us as unlink + add, and the two
      // share one debounce, so the unlink may be the one that fires. The file
      // is still there, under this exact name: it changed, it did not go.
      if (listedExactly(this.root, relPath)) return this.handleExternalChange("change", relPath, absPath);
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
  private ingest(relPath: string, absPath: string, content: string, utf8: boolean): void {
    const parsed = parseNote(content, titleFromPath(relPath));
    if (parsed.id && this.sameNameElsewhere(parsed.id, relPath)) return;
    const owner = parsed.id ? this.ownerElsewhere(parsed.id, relPath) : undefined;
    // The id this path already has: a note that cannot be stamped keeps it
    // across every save (audit STO-003), and one whose id: line was removed
    // gets it back.
    const pathId = this.index.getByPath(relPath)?.id;
    if (owner && !utf8) {
      console.error(`[vault] ${relPath}: carries note id ${parsed.id}, which belongs to ${owner.path}, and ${NOT_UTF8} Not indexed.`);
      return;
    }
    if (owner) {
      // A copy of another note. It becomes a note of its own; if this path
      // already was one (`cp A.md B.md` over B), it stays that note.
      const stamped = this.restamp(relPath, content, parsed.id!, owner.path, pathId ?? generateNoteId());
      if (stamped === null) return;
      content = stamped;
      this.markWritten(relPath, content);
      writeFileAtomic(absPath, content);
    }
    const fallbackId = parsed.id ? undefined : (pathId ?? generateNoteId());
    if (!owner && fallbackId) {
      // Same rule as load(): stamp only what round-trips. This path fires on
      // every watcher event, so a rewrite that changed anything else would be
      // repeated — and compounded — forever.
      const s = this.stampOrKeep(relPath, content, utf8, fallbackId);
      content = s.content;
      if (s.stamped) {
        this.markWritten(relPath, content);
        writeFileAtomic(absPath, content);
      }
    }

    const existing = this.index.getByPath(relPath);
    const mtimeMs = fs.statSync(absPath).mtimeMs;
    const note = this.index.upsert({ path: relPath, content, mtimeMs, id: fallbackId });

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
    // The one slug grammar (core projectSlugOf): a tag registered here is a
    // project every route can open (audit REG-017).
    const keys = note.tags.filter((t) => t.line === 0 && projectSlugOf(t.tag) !== null).map((t) => t.tag);
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

  /**
   * The registered projects, each named by its project note (projectName),
   * read now: the row's `name` is whichever tagged note was indexed first —
   * after a rebuild that is walk order, a chapter draft as easily as the
   * project note (audit COR-004). Names are for display; projects are told
   * apart by key.
   */
  projects(): ProjectDef[] {
    const notes = this.index.all();
    return this.db
      .select()
      .from(tables.projects)
      .all()
      .filter((p) => !p.hidden)
      .map((p) => ({ kind: p.kind, key: p.key, name: p.kind === "tag" ? projectName(projectNoteFor(notes, p.key), p.name) : p.name }));
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
   * The result is also spelled the way the disk spells it (diskPath.ts): on
   * APFS `shared/eng secret.md` IS `Shared/Eng Secret.md`, so it must be that
   * note — found in the index, judged by its tags and its folder's grant, and
   * merged into — not a fresh untagged note renamed over it (audit ACL-001).
   * `asNamed` keeps the last segment as the caller spelled it (a rename's
   * target) and reports which existing entry, if any, that name already means.
   *
   * Callers must use the returned `rel`/`abs`, never the string they passed in.
   */
  private resolvePath(input: string, opts: { asNamed?: boolean } = {}): { rel: string; abs: string; taken?: string } {
    const given = path.relative(this.root, path.resolve(this.root, input)).split(path.sep).join("/");
    if (given === "" || given === ".." || given.startsWith("../") || path.isAbsolute(given)) {
      throw new HttpError(400, "invalid path");
    }
    if (!given.toLowerCase().endsWith(".md")) throw new HttpError(400, "only .md files live in the vault");
    // Through a link back into the vault, the folder the ACL would judge is
    // not the folder the bytes land in (rule 6).
    if (throughVaultLink(this.root, this.realRoot, given)) throw new HttpError(400, "that path goes through a link to another part of the vault");
    let disk: { rel: string; found: boolean };
    try {
      disk = onDisk(this.root, given);
    } catch (err) {
      if (err instanceof AmbiguousPathError) throw new HttpError(409, err.message);
      throw err;
    }
    if (!opts.asNamed) return { rel: disk.rel, abs: path.join(this.root, disk.rel) };
    const cut = disk.rel.lastIndexOf("/");
    const rel = (cut === -1 ? "" : disk.rel.slice(0, cut + 1)) + given.slice(given.lastIndexOf("/") + 1);
    return { rel, abs: path.join(this.root, rel), taken: disk.found ? disk.rel : undefined };
  }

  /**
   * Create or update a note. Returns the updated note. `create` makes it
   * create-only: a note already at the path — indexed or only on disk, in any
   * spelling — is a 409 and nothing is written (audit WEB-001).
   */
  write(user: AclUser, inputPath: string, content: string, baseHash?: string, baseContent?: string, opts: { create?: boolean; guard?: WriteGuard } = {}): IndexedNote {
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
    const disk = fs.existsSync(abs) ? readNote(abs) : null;
    if (opts.create && (existing || disk)) throw this.taken(user, existing, relPath);
    // A file that is not UTF-8 was read with U+FFFD for every byte that did
    // not decode; saving over it writes those (audit STO-011). Refuse.
    if (disk && !disk.utf8) throw new HttpError(409, `This note ${NOT_UTF8}`);
    // A file the index does not hold at this path yet (just saved by Obsidian,
    // or renamed and the watcher not settled) is still a note: take it in
    // first, so this is judged and merged as an edit of it, never as a
    // creation that replaces it.
    if (!existing && disk) {
      this.ingest(relPath, abs, disk.content, true);
      existing = this.index.getByPath(relPath);
    }
    if (existing) {
      const before = existing.content;
      if (disk && disk.content !== before) {
        this.ingest(relPath, abs, disk.content, true);
        existing = this.index.getByPath(relPath);
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
    // The caller's own rules for this write, judged on the path as the disk
    // spells it and the text about to land (agentWrites.ts): the agent and API
    // tokens may not rewrite an agent's standing instructions (audit AI-003).
    opts.guard?.({ path: relPath, before: existing ?? null, content });
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
    // Only what round-trips is stamped: content that cannot be (front matter
    // that does not parse — an autosave mid-typing `tags: [work, ` — or is
    // not a mapping, a numeric `id:`) is written as sent, and the index keeps
    // this path's id for it (audit STO-003).
    let finalContent = content;
    const keepId = existing?.id;
    const parsedId = after.id;
    const fallbackId = parsedId ? undefined : (keepId ?? generateNoteId());
    if (!parsedId) {
      const s = stampId(content, fallbackId!);
      if (s.ok) finalContent = s.content;
    } else if (keepId && parsedId !== keepId) {
      const s = stampId(content, keepId);
      if (s.ok) finalContent = s.content;
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
    try {
      writeFileAtomic(abs, finalContent, { exclusive: !!opts.create });
    } catch (err) {
      // Created by someone else between the look above and now.
      if (opts.create && (err as NodeJS.ErrnoException).code === "EEXIST") throw this.taken(user, undefined, relPath);
      throw err;
    }
    const note = this.index.upsert({ path: relPath, content: finalContent, mtimeMs: Date.now(), id: fallbackId });
    if (!existing) this.recordContent(note.id, finalContent, user.id);
    this.syncNoteRow(note);
    this.syncProjectRow(note);
    this.reconcileTaskObjects(note);
    this.events.emit("note-changed", { noteId: note.id, path: note.path, authorId: user.id } satisfies NoteChangedEvent);
    return note;
  }

  /**
   * The 409 for a create whose path is taken. It names the path only when the
   * caller may read the note there: refusing is unavoidable, describing a note
   * they cannot see is not (§5.4).
   */
  private taken(user: AclUser, existing: IndexedNote | undefined, relPath: string): HttpError {
    const note = existing ?? this.index.getByPath(relPath);
    const visible = note && canRead(user, note, this.grants());
    return new HttpError(409, visible ? `A note already exists at ${note.path}.` : "A note already exists at that path.");
  }

  /** Rename/move: metadata operation, note id is stable so links never break (§10). */
  move(user: AclUser, inputFrom: string, inputTo: string): IndexedNote {
    // Both ends are canonicalised first, for the same reason as write(): the
    // destination folder the ACL judges must be where the file actually lands.
    const { rel: fromPath, abs: absFrom } = this.resolvePath(inputFrom);
    const { rel: toPath, abs: absTo, taken } = this.resolvePath(inputTo, { asNamed: true });
    const note = this.index.getByPath(fromPath);
    if (!note || !canRead(user, note, this.grants())) throw new HttpError(404, "note not found");
    // fs.renameSync REPLACES an existing destination. Moving onto a note that
    // exists destroyed it on disk and then failed half-way (500), leaving the
    // index and the notes table disagreeing about the path — which stopped the
    // next boot. Checked on disk as well as in the index: the file may not
    // have been indexed yet, or may not be a note we can see. On disk means
    // any spelling of the name (`taken`, from the directory listing): the one
    // file it may be is the note itself, renamed only in case.
    if (toPath !== fromPath && (this.index.getByPath(toPath) || (taken !== undefined ? taken !== fromPath : fs.existsSync(absTo)))) {
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
