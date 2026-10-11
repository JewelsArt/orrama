/**
 * The web editor's side of a note: what it holds, what the server last agreed
 * to, and the order in which it talks to the server about them.
 *
 * Audit B5 on the client. The editors used to take the note's NEW hash
 * whenever the server sent a newer version, but the editor itself only swapped
 * in new text while unfocused. So while you typed, an Obsidian edit refreshed
 * the hash and not the buffer; the next save presented the stale buffer as
 * current, and the server — seeing a matching hash — wrote it over the edit.
 * No server check can see that. The hash was also read when save() was CALLED,
 * not when the PUT fired, so a keystroke racing a save response carried an old
 * one.
 *
 * NoteSync keeps `base` honest: it moves only to text the server actually
 * returned, and the buffer is always base + your local edits. Every save sends
 * base with it, so the server can merge instead of overwrite, and whatever the
 * server merged in comes back and is folded into the buffer — including
 * anything typed while the request was out. Every GET and PUT for the note runs
 * through one queue, so a response can never land after a newer one.
 *
 * Framework-free, with the transport injected: the server's tests drive this
 * very class against the real Fastify app.
 */
import { mergeText } from "./merge.js";

export interface SyncedNote {
  content: string;
  hash: string;
}

export interface NoteSyncTransport {
  /** PUT /api/vault/note — returns the text the server stored (and where, when it says). */
  save(body: SaveBody): Promise<SyncedNote & { path?: string }>;
  /** GET the note's current text (and its path, which a rename elsewhere changes). */
  load(): Promise<SyncedNote & { path?: string }>;
}

export interface SaveBody {
  path: string;
  content: string;
  baseHash: string;
  baseContent: string;
}

export type SaveState = "saved" | "saving" | "error";

export interface NoteSyncHooks {
  /** Someone else's edit arrived and this is the new text. Never called for the user's own typing. */
  apply?(next: string): void;
  /** With "error", why the save failed, in the server's words when it gave any. */
  status?(state: SaveState, reason?: string): void;
  /** A save landed. */
  saved?(note: SyncedNote): void;
  /** The note was renamed or moved outside this editor; saves now go to `path` (WEB-005). */
  moved?(path: string): void;
  /** The note is gone (deleted, or no longer readable): nothing is saved any more, the typing is kept. */
  gone?(): void;
}

/** A failed save waits this long before it tries again, doubling to RETRY_MAX_MS (WEB-002). */
export const RETRY_FIRST_MS = 2000;
export const RETRY_MAX_MS = 30_000;

/**
 * Worth trying again on its own: the server did not answer (a restart under `pnpm ship`, a
 * Tailscale hiccup), failed, or asked to wait. A refusal (403, 409, 413) would only be refused
 * again; it waits for the next edit, and the text stays where it is.
 */
export function retryable(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status !== "number" || status >= 500 || status === 408 || status === 429;
}

const statusOf = (err: unknown): number | undefined => {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : undefined;
};

export class NoteSync {
  private base: SyncedNote;
  private buffer: string;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private view: ((next: string) => void) | null = null;
  /** The wait before the next retry of a failed save; 0 while nothing has failed. */
  private backoff = 0;
  private lost = false;
  /** Why the last save failed, while it has not been saved since. */
  error: string | null = null;

  constructor(
    /** Where saves go. The server's answer moves it when the note was renamed elsewhere (WEB-005). */
    private path: string,
    note: SyncedNote,
    private readonly transport: NoteSyncTransport,
    private readonly hooks: NoteSyncHooks,
    private readonly delayMs = 600,
  ) {
    this.base = { content: note.content, hash: note.hash };
    this.buffer = note.content;
  }

  /** What the editor should be showing. */
  get content(): string {
    return this.buffer;
  }

  /** True while there is typing the server has not stored. */
  get dirty(): boolean {
    return this.buffer !== this.base.content;
  }

  /** The note's path, as the server last named it. */
  get where(): string {
    return this.path;
  }

  /** True once the server says the note is gone: saving stops, the buffer stays. */
  get gone(): boolean {
    return this.lost;
  }

  /** What a save would send now, or null when there is nothing to save. For a save that must outlive the page. */
  pending(): SaveBody | null {
    if (!this.dirty || this.lost) return null;
    return { path: this.path, content: this.buffer, baseHash: this.base.hash, baseContent: this.base.content };
  }

  /** The editor changed. */
  edit(next: string): void {
    if (this.closed || next === this.buffer) return;
    this.buffer = next;
    clearTimeout(this.timer);
    if (!this.dirty) return this.hooks.status?.("saved");
    this.hooks.status?.("saving");
    this.timer = setTimeout(() => void this.flush(), this.delayMs);
  }

  /** Save now rather than after the debounce. Resolves once the save is done. */
  flush(): Promise<void> {
    clearTimeout(this.timer);
    return this.enqueue(async () => {
      if (!this.dirty) return this.hooks.status?.("saved");
      if (this.lost) return this.hooks.status?.("error", this.error ?? undefined);
      const sent = this.buffer;
      let res: SyncedNote & { path?: string };
      try {
        res = await this.transport.save({ path: this.path, content: sent, baseHash: this.base.hash, baseContent: this.base.content });
      } catch (err) {
        // Keep the buffer and the old base, say why, and try again on our own when it is worth
        // it: "the next edit retries" lost everything for someone who stopped typing (WEB-002).
        this.error = err instanceof Error && err.message ? err.message : "the server did not answer";
        if (retryable(err) && !this.closed) {
          this.backoff = this.backoff ? Math.min(this.backoff * 2, RETRY_MAX_MS) : RETRY_FIRST_MS;
          clearTimeout(this.timer);
          this.timer = setTimeout(() => void this.flush(), this.backoff);
        }
        return this.hooks.status?.("error", this.error);
      }
      this.backoff = 0;
      this.error = null;
      if (res.path && res.path !== this.path) {
        this.path = res.path;
        this.hooks.moved?.(res.path);
      }
      this.base = { content: res.content, hash: res.hash };
      // The server may have merged someone else's edit in (res ≠ sent), and
      // the user may have typed since the request left (buffer ≠ sent). Both
      // started from `sent`, so fold one into the other.
      this.settle(mergeText(sent, this.buffer, res.content));
      this.hooks.saved?.(res);
    });
  }

  /**
   * The server says the note changed (a live-sync event, a checkbox toggled
   * elsewhere). Fetches it in turn — after any save already under way — and
   * merges it into what is being typed. Resolves once done.
   */
  refresh(): Promise<void> {
    return this.enqueue(async () => {
      let fresh: SyncedNote & { path?: string };
      try {
        fresh = await this.transport.load();
      } catch (err) {
        // Gone: deleted, or no longer ours to read. A save to its old path would bring it back
        // as a new file, so stop saving and keep the typing (WEB-005).
        if (statusOf(err) === 404 || statusOf(err) === 403) {
          this.lost = true;
          clearTimeout(this.timer);
          this.error = "this note is no longer in the vault";
          this.hooks.gone?.();
          if (this.dirty) this.hooks.status?.("error", this.error);
        }
        return; // otherwise the next event or save will catch up
      }
      // Renamed or moved outside this editor: the next save goes where the note is now, not to
      // its old path, where the server would make a duplicate of it (WEB-005).
      if (fresh.path && fresh.path !== this.path) {
        this.path = fresh.path;
        this.hooks.moved?.(fresh.path);
      }
      if (fresh.hash === this.base.hash) return;
      // The buffer is base + local edits; fresh is base + everyone else's.
      const next = mergeText(this.base.content, this.buffer, fresh.content);
      this.base = { content: fresh.content, hash: fresh.hash };
      this.settle(next);
    });
  }

  /**
   * The editor view that should receive other people's edits. The view is
   * created after the sync (and recreated with it), so it registers itself;
   * the returned function unregisters it.
   */
  attach(apply: (next: string) => void): () => void {
    this.view = apply;
    return () => {
      if (this.view === apply) this.view = null;
    };
  }

  /** Stop talking to the editor and the server (the note was closed). */
  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
  }

  private settle(next: string): void {
    if (this.closed) return;
    if (next !== this.buffer) {
      this.buffer = next;
      this.view?.(next);
      this.hooks.apply?.(next);
    }
    if (this.dirty) {
      this.hooks.status?.("saving");
      clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.flush(), this.delayMs);
    } else {
      this.hooks.status?.("saved");
    }
  }

  private enqueue(op: () => Promise<void>): Promise<void> {
    const run = this.queue.then(() => (this.closed ? undefined : op()));
    this.queue = run.catch(() => undefined);
    return run;
  }
}
