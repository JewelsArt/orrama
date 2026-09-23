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
  /** PUT /api/vault/note — returns the text the server stored. */
  save(body: { path: string; content: string; baseHash: string; baseContent: string }): Promise<SyncedNote>;
  /** GET the note's current text. */
  load(): Promise<SyncedNote>;
}

export type SaveState = "saved" | "saving" | "error";

export interface NoteSyncHooks {
  /** Someone else's edit arrived and this is the new text. Never called for the user's own typing. */
  apply?(next: string): void;
  status?(state: SaveState): void;
  /** A save landed. */
  saved?(note: SyncedNote): void;
}

export class NoteSync {
  private base: SyncedNote;
  private buffer: string;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private view: ((next: string) => void) | null = null;

  constructor(
    private readonly path: string,
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
      const sent = this.buffer;
      let res: SyncedNote;
      try {
        res = await this.transport.save({ path: this.path, content: sent, baseHash: this.base.hash, baseContent: this.base.content });
      } catch {
        // Keep the buffer and the old base; the next edit or flush retries.
        return this.hooks.status?.("error");
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
      let fresh: SyncedNote;
      try {
        fresh = await this.transport.load();
      } catch {
        return; // the next event or save will catch up
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
