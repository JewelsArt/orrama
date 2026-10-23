/**
 * The server's vault service: real Markdown files in a real folder tree on disk
 * (admins can rsync/git-backup it), an in-memory VaultIndex over them, and a
 * Y.Doc per note whose update log lives in SQLite for history + CRDT merge.
 * Every read surface goes through @orrama/core ACL — implemented once, used everywhere.
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
  foldPath,
  generateNoteId,
  ONTOLOGY_TAG,
  ONTOLOGY_TEMPLATE,
  parseFrontmatter,
  parseOntology,
  parseNote,
  personalOwner,
  projectName,
  projectNoteFor,
  projectSlugOf,
  PROJECTS_DIR,
  stampId,
  titleFromPath,
  updateFrontmatter,
  validateEdit,
  type AclUser,
  type EditValidation,
  type FolderGrant,
  type IndexedNote,
  type ProjectDef,
} from "@orrama/core";
import { createNoteDoc, docContent, docFromUpdates, encodeStateB64, mergeText, SpliceMismatchError, updateDocContent } from "@orrama/sync";
import { tables, type Db } from "./db.js";
import { vaultDir } from "./env.js";
import { carriedId, chooseIdOwner } from "./noteIds.js";
import { writeFileAtomic } from "./atomicWrite.js";
import { AmbiguousPathError, linksIntoVault, listedExactly, onDisk, sameFile, throughVaultLink } from "./diskPath.js";
import { unportableName } from "./portableName.js";
import { numbered } from "./uploads.js";
import { retarget, rewriteLinks, rewriteNames, type Renaming } from "./linkRename.js";

/** How long after the watcher's folder set changes the vault is read again
 *  (reconcileLater): past the moment Node rebuilds its FSEvents stream, which
 *  comes after chokidar has read the new folder; under load that took ~200 ms. */
const RECONCILE_MS = 1000;
/** A stream of folder changes postpones the re-read at most this long. */
const RECONCILE_MAX_WAIT_MS = 10_000;
/** reconcileLater's key in watchTimeouts: no note path holds a NUL. */
const RECONCILE_KEY = "\0reconcile";

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

/** A note left the index (deleted, moved out of the vault, put in the trash). `note` is how it
 *  was, so a listener can still ask who could read it. */
export interface NoteRemovedEvent {
  noteId: string;
  path: string;
  note: IndexedNote;
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

/** Whether a path is a file once links are followed (false if it is gone). */
function isFile(abs: string): boolean {
  try {
    return fs.statSync(abs).isFile();
  } catch {
    return false;
  }
}

const NOT_UTF8 = "is not UTF-8 text, so Orrama reads it but will not write to it. Save it as UTF-8 to edit it here.";

/**
 * The notes folder's trash, `.trash/` at its root, as Obsidian keeps one (Jules, 21 Oct
 * 2026: recoverable in Finder, travels with a backup, emptied by hand). Nothing in it is ever
 * indexed: the boot walk and the watcher skip every name starting with a dot, and
 * resolvePath refuses it, so no write, create or move can put a note there or reach one in it.
 */
export const TRASH_DIR = ".trash";

function refuseTrash(rel: string): void {
  if (foldPath(rel.split("/")[0] ?? "") === TRASH_DIR) throw new HttpError(400, "That's the trash. Put the note back first.");
}

/** `Personal/` and each person's own folder in it hold the path-based ACL (§5.3) and the
 *  capture inbox: they are never renamed, moved or trashed as folders. */
function refusePersonalRoot(rel: string): void {
  const parts = rel.split("/");
  if (personalOwner(rel) !== null && parts.length <= 2) throw new HttpError(400, "Personal folders can't be renamed, moved or put in the trash.");
}

/** A folder as the ACL judges it, with no tags of its own. */
const asFolder = (folder: string) => ({ folder, onlyTeams: [] as string[], shareTeams: [] as string[] });

/** Whether anything holds this name, a dangling link included (existsSync follows links). */
function present(abs: string): boolean {
  try {
    fs.lstatSync(abs);
    return true;
  } catch {
    return false;
  }
}

function isRealDir(abs: string): boolean {
  try {
    return fs.lstatSync(abs).isDirectory();
  } catch {
    return false;
  }
}

function isPlainFile(abs: string): boolean {
  try {
    return fs.lstatSync(abs).isFile();
  } catch {
    return false;
  }
}

/** Every file under `dir`, never following a link; with `links`, links are listed as files. */
function filesIn(dir: string, opts: { links?: boolean } = {}): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() || (opts.links && e.isSymbolicLink())) out.push(full);
    }
  };
  walk(dir);
  return out;
}

/**
 * Move `src` (a file or a folder) to `dst`. A folder meeting a folder merges into it, entry by
 * entry; a file meeting a taken name takes the next free `name (n).ext`. Returns where `src`
 * itself ended up.
 */
function moveInto(src: string, dst: string): string {
  if (!present(dst)) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.renameSync(src, dst);
    return dst;
  }
  if (isRealDir(src) && isRealDir(dst)) {
    for (const e of fs.readdirSync(src)) moveInto(path.join(src, e), path.join(dst, e));
    fs.rmdirSync(src);
    return dst;
  }
  let next = dst;
  for (let n = 2; present(next); n++) next = path.join(path.dirname(dst), numbered(path.basename(dst), n));
  fs.renameSync(src, next);
  return next;
}

/** Remove empty folders from `dir` up to (not including) `stop`; with `all`, every empty
 *  folder below `dir` too, `dir` included. */
function pruneEmpty(dir: string, stop: string, opts: { all?: boolean } = {}): void {
  if (opts.all && isRealDir(dir)) for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) pruneEmpty(path.join(dir, e.name), dir, { all: true });
  for (let d = dir; d !== stop && d.startsWith(stop); d = path.dirname(d)) {
    try {
      if (!isRealDir(d) || fs.readdirSync(d).length > 0) return;
      fs.rmdirSync(d);
    } catch {
      return;
    }
  }
}

/** A folder appeared, moved or went (live sync tells whoever may read it). */
export interface FolderChangedEvent {
  folder: string;
  authorId: string;
}

/** A note whose exact links follow a rename (VaultStore.linkPlan). */
interface LinkPlanItem {
  id: string;
  path: string;
  title: string;
  links: number;
  canEdit: boolean;
  /** The link targets, folded, that name the note in this one. */
  targets: Set<string>;
  /** The plain names in its relation properties, folded, that name the note (`company: Acme`). */
  names: Set<string>;
}

/** One file in the trash, as GET /api/vault/trash lists it. */
export interface TrashItem {
  /** Its path in the notes folder now, under `.trash/` — what restore takes. */
  path: string;
  /** Where it came from (and goes back to). */
  from: string;
  title: string;
  kind: "note" | "file";
  /** When it went in (the file's change time). */
  at: number;
  canRestore: boolean;
}

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

/**
 * Whether `file` is the vault-root CLAUDE.md, which is never indexed or
 * stamped. Compared as resolved paths: on Windows chokidar reports
 * `C:/…/vault/CLAUDE.md` while path.join gives `C:\…\vault\CLAUDE.md`, so a
 * string compare never matched, and the user's guide was indexed and had an id
 * written into it (audit OPS-003). `p` is there for the tests.
 */
export function isRootGuide(root: string, file: string, p: typeof path = path): boolean {
  return p.resolve(file) === p.resolve(root, "CLAUDE.md");
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
  /** When the pending re-read of the vault is due (reconcileLater). */
  private reconcileDue = 0;
  /** Folders reconcile() handed to chokidar, each once: a handed folder
   *  chokidar did not list as watched would otherwise be handed, and the
   *  vault read again, every second. Forgotten when chokidar reports it gone. */
  private handedDirs = new Set<string>();
  private watcher: FSWatcher | null = null;
  /** Set when close() starts: from then on no watcher event schedules work. */
  private closing = false;
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
    this.docCacheSize = Math.max(1, opts.docCacheSize ?? (Number(process.env.ORRAMA_DOC_CACHE) || 256));
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
    this.realRoot = fs.realpathSync(this.root);
    // Same reason as the per-file guard below: a folder we cannot read
    // must cost that folder, not the whole boot.
    const { files: found } = this.walkVault((dir, err) =>
      console.error(`[vault] ${path.relative(this.root, dir) || "."}: folder skipped at boot — ${err instanceof Error ? err.message : String(err)}`),
    );
    // One file must not be able to stop the server booting. Under launchd's
    // KeepAlive a throw here is not an error page, it is a crash loop: the
    // agent restarts, meets the same file, and the whole app is down until
    // someone edits the database by hand. Skip it, loudly, and boot.
    const skip = (rel: string, err: unknown) =>
      console.error(`[vault] ${rel}: skipped at boot — ${err instanceof Error ? err.message : String(err)}`);
    // Read everything first: which of two files carrying one id keeps it is
    // decided over the whole vault, not by whichever the walk reached last.
    const files: BootFile[] = [];
    for (const abs of found) {
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

    // Loading again (a re-index) replaces the watcher. The old one, left
    // open, kept its listeners: past close() it went on reporting the vault's
    // changes into this store, and its timers fired into a closed database.
    // chokidar's close() detaches the listeners at once; the rest settles alone.
    void this.watcher?.close().catch(() => {});
    this.handedDirs.clear();
    const watcher = chokidar.watch(this.root, {
      ignored: (filePath: string, stats?: fs.Stats) => {
        const basename = path.basename(filePath);
        if (basename.startsWith(".")) return true;
        if (isRootGuide(this.root, filePath)) return true;
        return linksIntoVault(this.realRoot, filePath);
      },
      ignoreInitial: true,
    }).on("all", (event, absPath) => {
      // The watcher's folder set changes: on macOS that rebuilds the stream
      // and can drop other events of that moment (reconcileLater).
      if (event === "unlinkDir") this.handedDirs.delete(absPath);
      if (event === "addDir" || event === "unlinkDir") return this.reconcileLater();
      if (!absPath.toLowerCase().endsWith(".md")) return;
      const relPath = path.relative(this.root, absPath).split(path.sep).join("/");
      // No early return on "we wrote this": whether it is our echo is decided in
      // handleExternalChange, by comparing the bytes on disk with what we wrote.
      this.settleLater(event, relPath, absPath);
    });
    // A note created and deleted in one breath — Orrama writes it, something
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
      if (relPath.startsWith("..")) return;
      const held = !!this.index.getByPath(relPath);
      const listed = listedExactly(this.root, relPath);
      if (held && !listed) return this.settleLater("unlink", relPath, absPath);
      if (this.watchTimeouts.has(relPath)) return; // chokidar's own event is settling it
      // And the other way: a name the folder lists that the index lacks.
      // After reconcile() mended a dropped event, chokidar's own picture of
      // that folder is stale — a case-only rename back to the spelling it
      // still holds reads as "nothing changed" — so it reports no "add".
      if (!held && listed && !isRootGuide(this.root, absPath) && isFile(absPath)) this.settleLater("add", relPath, absPath);
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
    // Ready means chokidar has called fs.watch on every folder, not that
    // events flow: on macOS the stream starts later, from "now" (reconcileLater).
    watcher.once("ready", () => this.reconcileLater());
  }

  /** Debounce the watcher's events per path: the last one settles it, 300ms on. */
  private settleLater(event: string, relPath: string, absPath: string): void {
    if (this.closing) return;
    const pending = this.watchTimeouts.get(relPath);
    if (pending) clearTimeout(pending);
    this.watchTimeouts.set(relPath, setTimeout(() => {
      this.watchTimeouts.delete(relPath);
      this.handleExternalChange(event, relPath, absPath);
    }, 300));
  }

  /**
   * Read the whole vault again, a moment after the watcher's set of folders
   * changed, and settle whatever its events missed.
   *
   * On macOS, Node's fs.watch (libuv) serves every watched folder of the
   * process from ONE FSEvents stream, and each time a folder watch is added
   * or closed it throws that stream away and starts a new one "since now".
   * Events FSEvents had not yet delivered to the old stream are lost, for
   * every folder — a note created, renamed or moved in at that moment, or a
   * new folder, is never reported, and nothing reports it until that folder
   * changes again. chokidar adds a watch for each new folder and closes one
   * for each folder that goes, so this is any folder made or removed in the
   * vault, by Orrama or by anything else; the first stream, at boot, starts
   * after "ready" the same way. Under load the window grows from a few
   * milliseconds to hundreds. (Measured 21 Oct 2026: a test's new folder
   * dropped another folder's event, which never came.) Linux and Windows
   * watch each folder on its own; the re-read also covers the moment between
   * chokidar reading a new folder and watching it (`_handleDir` in its
   * handler.js), where inotify reports nothing.
   *
   * Notes the folders list that the index lacks are taken in, notes the
   * index holds that are no longer listed under that exact spelling are
   * dropped, and a folder chokidar does not know is handed to it — which
   * changes the folder set again, so one more read follows. Each goes
   * through the same 300 ms settle as an event, which checks the disk again.
   * The walk is a few milliseconds for a vault of hundreds of notes.
   */
  private reconcileLater(): void {
    if (this.closing) return;
    this.reconcileDue = Date.now() + RECONCILE_MS;
    if (this.watchTimeouts.has(RECONCILE_KEY)) return;
    const first = Date.now();
    const fire = () => {
      const wait = this.reconcileDue - Date.now();
      if (wait > 0 && Date.now() - first < RECONCILE_MAX_WAIT_MS) {
        this.watchTimeouts.set(RECONCILE_KEY, setTimeout(fire, wait));
        return;
      }
      this.watchTimeouts.delete(RECONCILE_KEY);
      this.reconcile();
    };
    this.watchTimeouts.set(RECONCILE_KEY, setTimeout(fire, RECONCILE_MS));
  }

  private reconcile(): void {
    const watcher = this.watcher;
    if (this.closing || !watcher) return;
    const { files, dirs, complete } = this.walkVault();
    const watched = watcher.getWatched();
    let handed = false;
    for (const dir of dirs) {
      if (dir === this.root || this.handedDirs.has(dir) || watched[path.dirname(dir)]?.includes(path.basename(dir))) continue;
      // add() is an initial add to chokidar: with ignoreInitial it reports
      // nothing inside; the notes in it are taken in below.
      watcher.add(dir);
      this.handedDirs.add(dir);
      handed = true;
    }
    const listed = new Set<string>();
    for (const abs of files) {
      const rel = path.relative(this.root, abs).split(path.sep).join("/");
      listed.add(rel);
      if (!this.index.getByPath(rel) && !this.watchTimeouts.has(rel)) this.settleLater("add", rel, abs);
    }
    // A folder we could not read lists nothing: its notes are not gone.
    if (complete) {
      for (const note of this.index.all()) {
        if (!listed.has(note.path) && !this.watchTimeouts.has(note.path)) this.settleLater("unlink", note.path, path.join(this.root, note.path));
      }
    }
    if (handed) this.reconcileLater();
  }

  /**
   * Every note file and every folder of the vault, as boot and the watcher
   * see it. A folder linked in from elsewhere is part of the vault (audit
   * STO-010): Obsidian follows it, the watcher follows it and resolvePath
   * writes through it, and a walk that took only real directories (a
   * symlink's Dirent is not one) dropped its notes at every restart. A link
   * back into the vault is a second name for notes it already has and is
   * skipped (linksIntoVault); each real folder is walked once besides.
   * `complete` is false when a folder could not be read.
   */
  private walkVault(unreadable: (dir: string, err: unknown) => void = () => {}): { files: string[]; dirs: string[]; complete: boolean } {
    const files: string[] = [];
    const dirs: string[] = [];
    let complete = true;
    const walked = new Set<string>();
    const walk = (dir: string): void => {
      let real: string;
      let entries: fs.Dirent[];
      try {
        real = fs.realpathSync(dir);
        if (walked.has(real)) return;
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (err) {
        complete = false;
        return unreadable(dir, err);
      }
      walked.add(real);
      dirs.push(dir);
      for (const e of entries) {
        if (e.name.startsWith(".")) continue;
        if (dir === this.root && e.name === "CLAUDE.md") continue;
        const full = path.join(dir, e.name);
        if (e.isSymbolicLink() && linksIntoVault(this.realRoot, full)) continue;
        if (e.isDirectory() || (e.isSymbolicLink() && isFolder(full))) walk(full);
        else if (e.name.toLowerCase().endsWith(".md")) files.push(full);
      }
    };
    walk(this.root);
    return { files, dirs, complete };
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
    console.warn(`[vault] ${rel}: carries note id ${id}, which belongs to ${ownerPath} (a copy made outside Orrama?) — gave it its own id ${next}.`);
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
   * renamed outside Orrama (its unlink not processed yet), and keeps the id.
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
    this.syncProjectRow(note, { anchor: false });
  }

  /** Stop watching the vault. Called when the app closes, before the database
   *  is: "closed" tells listeners holding timers to drop them (webhooks.ts).
   *  chokidar can still deliver events while its close() is awaited, and the
   *  database closes as soon as this resolves: once closing, no event sets a
   *  timer, and the timers are cleared again after the watcher is gone. */
  async close(): Promise<void> {
    this.closing = true;
    const clearTimers = () => {
      for (const t of this.watchTimeouts.values()) clearTimeout(t);
      this.watchTimeouts.clear();
    };
    clearTimers();
    await this.watcher?.close();
    this.watcher = null;
    clearTimers();
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
    this.events.emit("note-removed", { noteId: existing.id, path: relPath, note: existing } satisfies NoteRemovedEvent);
  }

  /**
   * Take a file's current bytes into the index, the note's Y.Doc and its
   * history, as an edit by nobody in particular (Obsidian, an editor, a
   * script). The watcher calls this once its 300ms debounce settles; `write()`
   * calls it too when it finds the disk ahead of the index, so an edit is
   * recorded the same way whichever of the two notices it first.
   */
  private ingest(relPath: string, absPath: string, content: string, utf8: boolean, knownId?: string): void {
    const parsed = parseNote(content, titleFromPath(relPath));
    if (parsed.id && this.sameNameElsewhere(parsed.id, relPath)) return;
    const owner = parsed.id ? this.ownerElsewhere(parsed.id, relPath) : undefined;
    // The id this path already has: a note that cannot be stamped keeps it
    // across every save (audit STO-003), and one whose id: line was removed
    // gets it back.
    const pathId = this.index.getByPath(relPath)?.id ?? (knownId && !this.index.get(knownId) ? knownId : undefined);
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
   * existing row's name/team/hidden overrides are preserved, and a project
   * the owner removed (hidden=1) is never resurrected. Body mentions of
   * "project/…" (line ≠ 0) are ignored. The row's `domain` follows the
   * project's own note: it was written once and never again, so a project
   * moved to another area kept its old one on Today (1D).
   */
  private syncProjectRow(note: IndexedNote, opts: { anchor: boolean } = { anchor: true }): void {
    // The one slug grammar (core projectSlugOf): a tag registered here is a
    // project every route can open (audit REG-017).
    const keys = note.tags.filter((t) => t.line === 0 && projectSlugOf(t.tag) !== null).map((t) => t.tag);
    const domain = typeof note.frontmatter?.["domain"] === "string" ? (note.frontmatter["domain"] as string) : null;
    for (const key of keys) {
      const existing = this.db.select().from(tables.projects).where(eq(tables.projects.key, key)).get();
      if (existing) {
        // Only the project's own note speaks for it; a note that joins it does not.
        const own = existing.noteId === note.id || note.path === `${PROJECTS_DIR}/${projectSlugOf(key)}.md`;
        if (own && existing.domain !== domain) this.db.update(tables.projects).set({ domain }).where(eq(tables.projects.id, existing.id)).run();
        continue;
      }
      // The note that registered the key is the project (projectNote). At boot
      // the index is half-built and this is walk order, so the anchor is left
      // for projectNote to choose once everything is indexed.
      const noteId = opts.anchor ? note.id : null;
      this.db
        .insert(tables.projects)
        .values({ id: `p-${crypto.randomUUID().slice(0, 8)}`, kind: "tag", key, name: note.title, teamId: null, domain, hidden: null, noteId })
        .run();
    }
  }

  /**
   * The note that IS project `key` — the one its documents, board and name
   * are authorised against (audit ACL-002). The conventional
   * `04-Projects/<slug>.md` first, then the note the registration row is
   * anchored to, while it still carries the tag. Never chosen from the notes a
   * caller can read: tags are free text, and "the caller's own note tagged
   * project/<slug>" made any folder editor the owner of another team's
   * project. Ranking among the tagged notes is no better — a note's id and
   * folder are its author's to write — so the ranking (projectNoteFor) is used
   * only to anchor a row that has none yet (a database from before schema 4, a
   * rebuild) or whose note is gone or untagged, and the choice is stored.
   * Every other note carrying the tag only joins the project.
   */
  projectNote(key: string): IndexedNote | undefined {
    const slug = projectSlugOf(key);
    if (slug === null) return undefined;
    const conventional = this.index.getByPath(`${PROJECTS_DIR}/${slug}.md`);
    if (conventional) return conventional;
    const row = this.db.select().from(tables.projects).where(eq(tables.projects.key, key)).get();
    if (!row) return undefined;
    const anchored = row.noteId ? this.index.get(row.noteId) : undefined;
    if (anchored && anchored.tags.some((t) => t.line === 0 && t.tag === key)) return anchored;
    const chosen = projectNoteFor(this.index.all(), key);
    if ((chosen?.id ?? null) !== row.noteId) this.db.update(tables.projects).set({ noteId: chosen?.id ?? null }).where(eq(tables.projects.id, row.id)).run();
    return chosen;
  }

  /** The ids of every registered project's own note (`projectNote`): the notes whose `area:` says their area. */
  projectNoteIds(): Set<string> {
    const out = new Set<string>();
    for (const p of this.db.select().from(tables.projects).all()) {
      if (p.hidden || p.kind !== "tag") continue;
      const note = this.projectNote(p.key);
      if (note) out.add(note.id);
    }
    return out;
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
      // Disk may have moved ahead of the log (edited outside Orrama) — reconcile.
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
   * history — a note renamed outside Orrama, or deleted and put back — logged
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
   * The registered projects `user` can see, each named by its project note
   * (projectName), read now: the row's `name` is whichever tagged note was
   * indexed first — after a rebuild that is walk order, a chapter draft as
   * easily as the project note (audit COR-004). Names are for display;
   * projects are told apart by key. A project whose note (projectNote) or
   * folder the user cannot read does not exist for them: tagging your own note
   * `project/<slug>` does not put another team's project, or its name, on
   * your tasks and boards (audit ACL-002), and a project with no tasks you can
   * read is not listed by name on your team's board (ACL-004).
   */
  projects(user: AclUser): ProjectDef[] {
    const grants = this.grants();
    const out: ProjectDef[] = [];
    for (const p of this.db.select().from(tables.projects).all()) {
      if (p.hidden) continue;
      if (p.kind !== "tag") {
        // A folder project is the folder: its name is the reader's only if the folder is.
        if (canRead(user, { folder: p.key, onlyTeams: [], shareTeams: [] }, grants)) out.push({ kind: p.kind, key: p.key, name: p.name });
        continue;
      }
      const note = this.projectNote(p.key);
      // A registration whose tag no note carries any more is the owners' to see.
      if (note ? canRead(user, note, grants) : user.isOwner) out.push({ kind: p.kind, key: p.key, name: projectName(note, p.name) });
    }
    return out;
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

  /**
   * The vault's own CLAUDE.md (root; left out of the index at boot) — the
   * "who I am / how to help me" note the agent reads as grounding — for
   * `user`, or null when they cannot read it. It is a note like any other,
   * judged by its folder (the root) and its own #only/#share tags: read raw
   * for everyone, it put a note a user got a 404 for into their model
   * context, where they could just ask for it (audit AI-002).
   */
  vaultGuide(user: AclUser): string | null {
    try {
      const abs = path.join(this.root, "CLAUDE.md");
      if (!fs.existsSync(abs)) return null;
      const content = fs.readFileSync(abs, "utf8");
      const note = parseNote(content, "CLAUDE");
      if (!canRead(user, { folder: "", onlyTeams: note.onlyTeams, shareTeams: note.shareTeams }, this.grants())) return null;
      return content.slice(0, 8000);
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
    // Judged as the disk spells it: `.Trash/x.md` is the trash too.
    refuseTrash(disk.rel);
    if (!opts.asNamed) return { rel: disk.rel, abs: path.join(this.root, disk.rel) };
    const cut = disk.rel.lastIndexOf("/");
    const rel = (cut === -1 ? "" : disk.rel.slice(0, cut + 1)) + given.slice(given.lastIndexOf("/") + 1);
    return { rel, abs: path.join(this.root, rel), taken: disk.found ? disk.rel : undefined };
  }

  /**
   * A new name must be one every disk holds (portableName.ts): the note's
   * file name, unless it is `keepName` (a move that keeps it), and every
   * folder the write would create. A name already on disk is never judged.
   */
  private requirePortable(rel: string, keepName?: string): void {
    const parts = rel.split("/");
    const name = parts.pop()!;
    const why = name === keepName ? null : unportableName(name, "note");
    if (why) throw new HttpError(400, why);
    for (let i = 0; i < parts.length; i++) {
      if (fs.existsSync(path.join(this.root, ...parts.slice(0, i + 1)))) continue;
      const folder = unportableName(parts[i]!, "folder");
      if (folder) throw new HttpError(400, folder);
    }
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
    const folder = relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : "";
    // A note the caller cannot read is answered as an empty path would be,
    // before its text is looked at (§5.4, audit ACL-005): comparing a
    // `baseHash` with it first made a wrong guess a 409 and a right one a 403
    // — a way to confirm a private note's exact text — and a stale hash a 409
    // where a missing note was a 403. Where the caller could create a note at
    // this path, refusing is unavoidable; nothing else is said.
    const there = existing ?? (disk ? parseNote(disk.content, titleFromPath(relPath)) : null);
    if (there && !canRead(user, { folder, onlyTeams: there.onlyTeams, shareTeams: there.shareTeams }, grants)) {
      opts.guard?.({ path: relPath, before: null, content });
      const sent = parseNote(content, titleFromPath(relPath));
      const asNew = validateEdit(user, { folder, onlyTeams: [], shareTeams: [] }, { folder, onlyTeams: sent.onlyTeams, shareTeams: sent.shareTeams }, grants);
      if (!asNew.ok) throw new HttpError(403, asNew.message);
      throw opts.create ? this.taken(user, existing, relPath) : new HttpError(403, "You do not have edit access to this note.");
    }
    if (opts.create && (existing || disk)) throw this.taken(user, existing, relPath);
    if (!existing && !disk) this.requirePortable(relPath);
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
    // Edit on both ends first, then whether the destination is taken: the
    // other way round, "a note already exists at that path" answered for
    // folders the caller cannot write to, or read — a probe for any path in
    // the vault (§5.4, audit ACL-005).
    const toFolder = toPath.includes("/") ? toPath.slice(0, toPath.lastIndexOf("/")) : "";
    if (
      !canEdit(user, note, this.grants()) ||
      !canEdit(user, { folder: toFolder, onlyTeams: note.onlyTeams, shareTeams: note.shareTeams }, this.grants())
    ) {
      throw new HttpError(403, "need edit access to both source and destination folders");
    }
    this.requirePortable(toPath, fromPath.slice(fromPath.lastIndexOf("/") + 1));
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
    fs.mkdirSync(path.dirname(absTo), { recursive: true });
    // A rename produces unlink+add; the destination arrives holding the note's
    // own bytes, so the digest recognises it. The source path is simply gone.
    this.markWritten(fromPath, note.content);
    this.markWritten(toPath, note.content);
    fs.renameSync(absFrom, absTo);
    this.index.remove(fromPath);
    // The id goes with it: a note whose front matter can't be stamped carries none, and
    // without this a move gave it a new one, cutting its tasks and history loose.
    const moved = this.index.upsert({ path: toPath, content: note.content, mtimeMs: Date.now(), id: note.id });
    this.syncNoteRow(moved);
    this.events.emit("note-changed", { noteId: moved.id, path: moved.path, authorId: user.id } satisfies NoteChangedEvent);
    return moved;
  }

  /**
   * Which notes hold exact links to `note` that a move to `toPath` would leave naming nothing
   * (linkRename.ts), each with the targets that resolve to it there — computed before the move,
   * since afterwards they no longer resolve. `other` counts the links that won't follow:
   * Markdown links, and links in notes the caller can't edit.
   */
  private linkPlan(user: AclUser, note: IndexedNote, toPath: string): { notes: LinkPlanItem[]; other: number; renaming: Renaming; fields: Set<string>; sections: string[] } {
    const grants = this.grants();
    const { fields, sections } = this.relationFields();
    const oldTitle = note.writtenTitle ?? note.title;
    const renamed = titleFromPath(note.path) !== titleFromPath(toPath);
    const renaming: Renaming = { from: { path: note.path, title: oldTitle }, to: { path: toPath, title: renamed ? titleFromPath(toPath) : oldTitle } };
    // Among what the caller can read, as every link of theirs resolves (ACL-005).
    const among = (n: IndexedNote) => n.id === note.id || canRead(user, n, grants);
    const notes: LinkPlanItem[] = [];
    let other = 0;
    for (const src of this.readable(user)) {
      // A saved conversation's text is a transcript: its links are quoted, never followed.
      if (src.kind === "conversation") continue;
      const targets = new Set<string>();
      let count = 0;
      // Every wiki link as the rewrite will see it — front matter (`company: "[[Acme]]"`)
      // included, code left out — so what is counted is what follows.
      rewriteLinks(src.content, (target) => {
        if (this.index.resolveLink(target, undefined, among)?.id === note.id && retarget(target, renaming) !== null) {
          targets.add(foldPath(target.trim()));
          count++;
        }
        return null;
      });
      // A relation property naming it in plain text (`company: Acme`, what New person wrote)
      // follows too (1F): counted as a link, rewritten by rewriteNames.
      const names = new Set<string>();
      for (const [k, v] of Object.entries(src.frontmatter)) {
        if (!fields.has(k.toLowerCase())) continue;
        for (const text of typeof v === "string" ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []) {
          const t = text.trim();
          if (!t || t.includes("[[")) continue;
          if (this.index.resolveLink(t, undefined, among)?.id === note.id && retarget(t, renaming) !== null) {
            names.add(foldPath(t));
            count++;
          }
        }
      }
      // A Markdown link to it doesn't follow (it is never rewritten).
      if (note.path !== toPath) other += src.links.filter((l) => !l.raw.startsWith("[[") && this.index.resolveLinkOf(src, l, among)?.id === note.id).length;
      if (count === 0) continue;
      const editable = canEdit(user, src, grants);
      if (!editable) other += count;
      notes.push({ id: src.id, path: src.path, title: src.title, links: count, canEdit: editable, targets, names });
    }
    return { notes, other, renaming, fields, sections };
  }

  /**
   * The front-matter keys that hold relations (`company`, `supervises`, `involves`…): the
   * vault's ontology note's, or the template's when it has none, so a plain name follows a
   * rename the same way on a vault that never wrote one.
   */
  private relationFields(): { fields: Set<string>; sections: string[] } {
    const note = this.index.all().find((n) => n.tags.some((t) => t.tag === ONTOLOGY_TAG));
    const ontology = parseOntology(note?.content ?? ONTOLOGY_TEMPLATE);
    const also = ontology.relations.flatMap((r) => r.also).filter((a) => /^section:/i.test(a));
    return { fields: new Set(ontology.relations.flatMap((r) => r.fields)), sections: [...new Set(also.map((a) => a.slice(8).trim()))] };
  }

  /** The linkers of a note for a move to `inputTo`, as GET …/linkers answers (nothing written). */
  linkers(user: AclUser, noteId: string, inputTo: string): { notes: Omit<LinkPlanItem, "targets" | "names">[]; other: number } {
    const note = this.requireReadable(user, noteId);
    const { rel: toPath } = this.resolvePath(inputTo, { asNamed: true });
    const plan = this.linkPlan(user, note, toPath);
    return { notes: plan.notes.map(({ targets: _t, names: _n, ...rest }) => rest), other: plan.other };
  }

  /**
   * Rename or move a note the way a person means it: the file; its `title:` line when the
   * name changes and it has one; and, with `links` (Jules, 21 Oct 2026), every exact link in
   * the notes the caller can edit that named it by what changed. A title line that can't be
   * rewritten (front matter that doesn't parse) is a 409 before anything moves.
   */
  renameNote(user: AclUser, inputFrom: string, inputTo: string, opts: { links?: boolean; guard?: WriteGuard } = {}): { note: IndexedNote; links: number; notes: number } {
    const { rel: fromPath } = this.resolvePath(inputFrom);
    const { rel: toPath } = this.resolvePath(inputTo, { asNamed: true });
    const note = this.index.getByPath(fromPath);
    if (!note || !canRead(user, note, this.grants())) throw new HttpError(404, "note not found");
    const renamed = titleFromPath(fromPath) !== titleFromPath(toPath);
    let titled: string | null = null;
    if (renamed) {
      const fm = parseFrontmatter(note.content);
      if (fm.malformed || fm.notMapping) throw new HttpError(409, "This note's properties can't be read, so it wasn't renamed. Fix them in the note first.");
      if (Object.hasOwn(fm.data, "title")) {
        titled = updateFrontmatter(note.content, (d) => ({ ...d, title: titleFromPath(toPath) }));
        if (titled === note.content && fm.data["title"] !== titleFromPath(toPath)) throw new HttpError(409, "This note's title line can't be changed safely, so it wasn't renamed.");
      }
    }
    const plan = opts.links ? this.linkPlan(user, note, toPath) : null;
    let moved = this.move(user, fromPath, toPath);
    if (titled !== null && titled !== moved.content) moved = this.write(user, moved.path, titled, undefined, undefined, { guard: opts.guard });
    let links = 0;
    let notes = 0;
    for (const item of plan?.notes ?? []) {
      if (!item.canEdit) continue;
      const src = this.index.get(item.id);
      if (!src) continue;
      // Names first: a label is checked against the link's old target, before it is rewritten.
      const r = plan!.renaming;
      const labelled = r.from.title !== r.to.title;
      const named = rewriteNames(src.content, plan!.fields, {
        plain: (t) => (item.names.has(foldPath(t)) ? retarget(t, r) : null),
        label: (t, label) => (labelled && item.targets.has(foldPath(t)) && foldPath(label) === foldPath(r.from.title) ? r.to.title : null),
      }, plan!.sections);
      const linked = rewriteLinks(named.content, (t) => (item.targets.has(foldPath(t)) ? retarget(t, r) : null));
      const next = { content: linked.content, count: linked.count + item.names.size };
      if (next.content === src.content) continue;
      try {
        const written = this.write(user, src.path, next.content, undefined, undefined, { guard: opts.guard });
        if (written.id === moved.id) moved = written;
        links += next.count;
        notes++;
      } catch (err) {
        // One note refusing (an agent's standing instructions, a note changed under us) costs
        // that note's links, not the rename.
        console.warn(`[vault] ${src.path}: its links to ${moved.path} were left as they were — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { note: moved, links, notes };
  }

  // ---- Folders and the trash (stage 1, 1C) ---------------------------------

  /**
   * A folder path, canonicalised as resolvePath does a note's (rule 6): no escape, never the
   * vault itself or the trash, never through a link back into the vault, spelled as the disk
   * spells it. `asNamed` keeps the last segment as given (a rename's new name). `found` says
   * whether a folder is there now.
   */
  private resolveFolder(input: string, opts: { asNamed?: boolean } = {}): { rel: string; abs: string; found: boolean } {
    const given = path.relative(this.root, path.resolve(this.root, input.replace(/\/+$/, ""))).split(path.sep).join("/");
    if (given === "" || given === ".." || given.startsWith("../") || path.isAbsolute(given)) throw new HttpError(400, "invalid folder");
    if (throughVaultLink(this.root, this.realRoot, given)) throw new HttpError(400, "that folder goes through a link to another part of the vault");
    let disk: { rel: string; found: boolean };
    try {
      disk = onDisk(this.root, given);
    } catch (err) {
      if (err instanceof AmbiguousPathError) throw new HttpError(409, err.message);
      throw err;
    }
    refuseTrash(disk.rel);
    let rel = disk.rel;
    if (opts.asNamed) {
      const cut = disk.rel.lastIndexOf("/");
      rel = (cut === -1 ? "" : disk.rel.slice(0, cut + 1)) + given.slice(given.lastIndexOf("/") + 1);
    }
    const abs = path.join(this.root, rel);
    return { rel, abs, found: isFolder(abs) };
  }

  /** Every folder a new name would create must be one every disk holds (portableName.ts). */
  private requirePortableFolder(rel: string): void {
    const parts = rel.split("/");
    for (let i = 0; i < parts.length; i++) {
      if (present(path.join(this.root, ...parts.slice(0, i + 1)))) continue;
      const why = unportableName(parts[i]!, "folder");
      if (why) throw new HttpError(400, why);
    }
  }

  /** The indexed notes under a folder (any depth). */
  private notesUnder(rel: string): IndexedNote[] {
    const prefix = `${rel}/`;
    return this.index.all().filter((n) => n.path.startsWith(prefix));
  }

  /**
   * Every folder the reader may see, empty ones included, so a folder made in Orrama shows
   * before a note goes in it: the folders on disk the folder rules let them read, and every
   * folder holding a note they can read (a #share note in a folder they can't). Never the
   * trash or another hidden folder (the walk skips them).
   */
  folders(user: AclUser): string[] {
    const grants = this.grants();
    const out = new Set<string>();
    for (const abs of this.walkVault().dirs) {
      const rel = path.relative(this.root, abs).split(path.sep).join("/");
      if (rel && canRead(user, asFolder(rel), grants)) out.add(rel);
    }
    for (const n of this.readable(user)) {
      for (let f = n.folder; f !== ""; f = f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "") out.add(f);
    }
    return [...out].sort((a, b) => a.localeCompare(b));
  }

  /** A new, empty folder. Needs edit there; a name already taken in any spelling is a 409. */
  makeFolder(user: AclUser, input: string): string {
    const { rel, abs } = this.resolveFolder(input);
    if (!canEdit(user, asFolder(rel), this.grants())) throw new HttpError(403, "You can't make a folder there.");
    if (present(abs)) throw new HttpError(409, "There's already a folder or a note with that name there.");
    this.requirePortableFolder(rel);
    fs.mkdirSync(abs, { recursive: true });
    this.events.emit("folder-changed", { folder: rel, authorId: user.id } satisfies FolderChangedEvent);
    return rel;
  }

  /**
   * Rename or move a folder, everything in it going along (notes, files, folders). Each note
   * in it must be one the caller can edit where it is and where it lands — the same rule as a
   * note's move — and its files need edit on both folders. One rename on disk, then every
   * note's path in the index, ids kept.
   */
  moveFolder(user: AclUser, inputFrom: string, inputTo: string): { path: string; notes: number } {
    const grants = this.grants();
    const from = this.resolveFolder(inputFrom);
    refusePersonalRoot(from.rel);
    const notes = this.notesUnder(from.rel);
    if (!from.found || (!canRead(user, asFolder(from.rel), grants) && !notes.some((n) => canRead(user, n, grants)))) throw new HttpError(404, "folder not found");
    const to = this.resolveFolder(inputTo, { asNamed: true });
    refusePersonalRoot(to.rel);
    if (foldPath(to.rel).startsWith(`${foldPath(from.rel)}/`)) throw new HttpError(400, "A folder can't go inside itself.");
    const landing = (n: IndexedNote) => `${to.rel}${n.path.slice(from.rel.length)}`;
    const folderOfPath = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
    if (
      !canEdit(user, asFolder(from.rel), grants) ||
      !canEdit(user, asFolder(to.rel), grants) ||
      notes.some((n) => !canEdit(user, n, grants) || !canEdit(user, { folder: folderOfPath(landing(n)), onlyTeams: n.onlyTeams, shareTeams: n.shareTeams }, grants))
    ) {
      throw new HttpError(403, "You need edit access to this folder, everything in it, and where it goes.");
    }
    if (to.rel === from.rel) return { path: from.rel, notes: 0 };
    // Taken in any spelling, unless it is this very folder renamed only in case.
    if (present(to.abs) && !(sameFile(to.abs, from.abs) && foldPath(to.rel) === foldPath(from.rel))) {
      throw new HttpError(409, "There's already a folder or a note with that name there.");
    }
    this.requirePortableFolder(to.rel);
    fs.mkdirSync(path.dirname(to.abs), { recursive: true });
    for (const n of notes) {
      this.markWritten(n.path, n.content);
      this.markWritten(landing(n), n.content);
    }
    fs.renameSync(from.abs, to.abs);
    for (const n of notes) {
      this.index.remove(n.path);
      const moved = this.index.upsert({ path: landing(n), content: n.content, mtimeMs: n.mtimeMs, id: n.id });
      this.syncNoteRow(moved);
      this.events.emit("note-changed", { noteId: moved.id, path: moved.path, authorId: user.id } satisfies NoteChangedEvent);
    }
    this.events.emit("folder-changed", { folder: to.rel, authorId: user.id } satisfies FolderChangedEvent);
    this.events.emit("folder-changed", { folder: from.rel, authorId: user.id } satisfies FolderChangedEvent);
    return { path: to.rel, notes: notes.length };
  }

  /** The trash folder, made when first needed. Refused when something other than a plain
   *  folder holds its name: a link there would carry notes out of the vault. */
  private trashDir(): string {
    const abs = path.join(this.root, TRASH_DIR);
    let st: fs.Stats | null = null;
    try {
      st = fs.lstatSync(abs);
    } catch {
      st = null;
    }
    if (st && !st.isDirectory()) throw new HttpError(409, "Your notes folder holds a .trash that isn't a plain folder, so nothing was moved to the trash.");
    if (!st) fs.mkdirSync(abs);
    return abs;
  }

  /**
   * Move a note to the trash (Jules, 21 Oct 2026: a trash folder, not a delete). The file
   * goes to `.trash/<its path>`, byte for byte, and leaves the index — so it is gone from
   * every surface — while its id, history and task objects stay in the database: restoring
   * it brings the same note back. Needs edit on the note.
   */
  trashNote(user: AclUser, input: string): { path: string; trashPath: string } {
    const { rel, abs } = this.resolvePath(input);
    const grants = this.grants();
    const note = this.index.getByPath(rel);
    if (!note || !canRead(user, note, grants)) throw new HttpError(404, "note not found");
    if (!canEdit(user, note, grants)) throw new HttpError(403, "You can't change this note, so it stays where it is.");
    const placed = moveInto(abs, path.join(this.trashDir(), ...rel.split("/")));
    this.forget(rel);
    return { path: rel, trashPath: path.relative(this.root, placed).split(path.sep).join("/") };
  }

  /** Move a folder and everything in it to the trash, keeping its place under `.trash/`.
   *  The same rule as moving it: edit on the folder and on every note in it. */
  trashFolder(user: AclUser, input: string): { path: string; notes: number } {
    const grants = this.grants();
    const from = this.resolveFolder(input);
    refusePersonalRoot(from.rel);
    const notes = this.notesUnder(from.rel);
    if (!from.found || (!canRead(user, asFolder(from.rel), grants) && !notes.some((n) => canRead(user, n, grants)))) throw new HttpError(404, "folder not found");
    if (!canEdit(user, asFolder(from.rel), grants) || notes.some((n) => !canEdit(user, n, grants))) {
      throw new HttpError(403, "You need edit access to this folder and everything in it.");
    }
    moveInto(from.abs, path.join(this.trashDir(), ...from.rel.split("/")));
    for (const n of notes) this.forget(n.path);
    this.events.emit("folder-changed", { folder: from.rel, authorId: user.id } satisfies FolderChangedEvent);
    return { path: from.rel, notes: notes.length };
  }

  /**
   * What is in the trash that the reader could read where it came from: each file, with the
   * place it came from (its path under `.trash/`), its title when it is a note, and when it
   * went in. Judged as the note would be judged there — its folder and its own tags — so
   * another person's trashed note is as invisible here as it was in the tree.
   */
  trash(user: AclUser): TrashItem[] {
    const root = path.join(this.root, TRASH_DIR);
    if (!isRealDir(root)) return [];
    const grants = this.grants();
    const out: TrashItem[] = [];
    for (const abs of filesIn(root)) {
      const from = path.relative(root, abs).split(path.sep).join("/");
      const judged = this.judgeTrashed(abs, from);
      if (!canRead(user, judged.acl, grants)) continue;
      out.push({
        path: `${TRASH_DIR}/${from}`,
        from,
        title: judged.title,
        kind: judged.note ? "note" : "file",
        at: Math.round(fs.lstatSync(abs).ctimeMs),
        canRestore: canEdit(user, judged.acl, grants),
      });
    }
    return out.sort((a, b) => b.at - a.at || a.from.localeCompare(b.from));
  }

  /** A trashed file as the ACL would see it where it came from. */
  private judgeTrashed(abs: string, from: string): { acl: { folder: string; onlyTeams: string[]; shareTeams: string[] }; title: string; note: boolean } {
    const folder = from.includes("/") ? from.slice(0, from.lastIndexOf("/")) : "";
    const name = from.slice(from.lastIndexOf("/") + 1);
    if (!name.toLowerCase().endsWith(".md")) return { acl: asFolder(folder), title: name, note: false };
    const parsed = parseNote(readNote(abs).content, titleFromPath(from));
    return { acl: { folder, onlyTeams: parsed.onlyTeams, shareTeams: parsed.shareTeams }, title: parsed.title, note: true };
  }

  /**
   * Put a trashed file back where it came from — beside it, `name (2).md`, when that place is
   * taken now. A note comes back as the note it was: its id from its front matter (or, for
   * one that couldn't be stamped, from the notes table), so its history and tasks are its own
   * again. Needs edit where it lands.
   */
  restore(user: AclUser, input: string): { path: string; id: string | null } {
    const root = path.join(this.root, TRASH_DIR);
    const given = path.relative(this.root, path.resolve(this.root, input)).split(path.sep).join("/");
    const [head, ...rest] = given.split("/");
    if (foldPath(head ?? "") !== TRASH_DIR || rest.length === 0 || rest.includes("..") || given.startsWith("../")) throw new HttpError(400, "not a path in the trash");
    const abs = path.join(root, ...rest);
    if (!isRealDir(root) || !isPlainFile(abs)) throw new HttpError(404, "not in the trash");
    const from = rest.join("/");
    const grants = this.grants();
    const judged = this.judgeTrashed(abs, from);
    if (!canRead(user, judged.acl, grants)) throw new HttpError(404, "not in the trash");
    if (!canEdit(user, judged.acl, grants)) throw new HttpError(403, "You can't put things back in that folder.");
    // Where it lands, canonicalised like any write: a folder renamed in case since is that folder.
    const folder = judged.acl.folder;
    const dir = folder === "" ? { rel: "", abs: this.root } : this.resolveFolder(folder);
    let name = from.slice(from.lastIndexOf("/") + 1);
    const taken = (n: string) => present(path.join(dir.abs, n)) || !!this.index.getByPath(dir.rel ? `${dir.rel}/${n}` : n);
    for (let i = 2; taken(name); i++) name = numbered(from.slice(from.lastIndexOf("/") + 1), i);
    const rel = dir.rel ? `${dir.rel}/${name}` : name;
    if (dir.rel) this.requirePortableFolder(dir.rel);
    const target = path.join(dir.abs, name);
    fs.mkdirSync(dir.abs, { recursive: true });
    let id: string | null = null;
    if (judged.note) {
      const { content, utf8 } = readNote(abs);
      this.markWritten(rel, content);
      fs.renameSync(abs, target);
      const known = this.db.select({ id: tables.notes.id }).from(tables.notes).where(and(eq(tables.notes.path, from), eq(tables.notes.deleted, true))).get()?.id;
      this.ingest(rel, target, content, utf8, known);
      id = this.index.getByPath(rel)?.id ?? null;
    } else {
      fs.renameSync(abs, target);
    }
    pruneEmpty(path.dirname(abs), root);
    if (!judged.note) this.events.emit("folder-changed", { folder: dir.rel, authorId: user.id } satisfies FolderChangedEvent);
    return { path: rel, id };
  }

  /**
   * Empty the trash: the one permanent delete (behind a Confirm in the app). Only files under
   * `.trash/`, and only the ones the caller could edit where they came from; a link in the
   * trash is removed as a link, never followed.
   */
  emptyTrash(user: AclUser): { removed: number; kept: number } {
    const root = path.join(this.root, TRASH_DIR);
    if (!isRealDir(root)) return { removed: 0, kept: 0 };
    const grants = this.grants();
    let removed = 0;
    let kept = 0;
    for (const abs of filesIn(root, { links: true })) {
      const from = path.relative(root, abs).split(path.sep).join("/");
      const judged = isPlainFile(abs) ? this.judgeTrashed(abs, from) : { acl: asFolder(from.includes("/") ? from.slice(0, from.lastIndexOf("/")) : "") };
      if (!canEdit(user, judged.acl, grants)) {
        kept++;
        continue;
      }
      fs.unlinkSync(abs);
      removed++;
    }
    pruneEmpty(root, path.dirname(root), { all: true });
    return { removed, kept };
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
