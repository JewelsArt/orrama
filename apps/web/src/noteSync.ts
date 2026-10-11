import { NoteSync, type NoteSyncHooks, type SaveBody } from "@basalt/sync/client";
import { mergeText } from "@basalt/sync/merge";
import { api, getToken, type NoteDetail } from "./api.js";
import { readJson, removeKey, writeKey } from "./storage.js";

/**
 * Typing is never lost (WEB-002). A note's unsaved text used to live only inside its NoteSync:
 * a failed save waited for the next keystroke, closing the note after a failure threw the
 * buffer away, and a reload inside the 600 ms debounce never sent it. Now:
 *
 * - the sync retries a failed save on its own (packages/sync/src/client.ts);
 * - closing a note whose save is failing keeps its sync alive here, still retrying, and opening
 *   the note again picks that same sync up, buffer and all;
 * - the buffer is copied to storage (`basalt-draft:<noteId>`) while it is unsaved, so a page
 *   that dies anyway offers the text back the next time the note opens;
 * - leaving the page (reload, ⌘R, Update ready, closing the window) sends what is pending with
 *   `keepalive`, and asks first when a save is already failing.
 */

/** Every sync with a note open or unsaved text, by note id. */
const live = new Map<string, NoteSync>();
/** Of those, the ones whose note was closed while unsaved: they keep retrying until stored. */
const retired = new Set<NoteSync>();

export const DRAFT_PREFIX = "basalt-draft:";

/** What a note held when the page last saw it unsaved, and what it was based on. */
export interface Draft {
  content: string;
  base: string;
  at: number;
}

const draftKey = (noteId: string) => `${DRAFT_PREFIX}${noteId}`;

export function readDraft(noteId: string): Draft | null {
  const d = readJson<Draft | null>(draftKey(noteId), null);
  return d && typeof d.content === "string" && typeof d.base === "string" ? d : null;
}

export const dropDraft = (noteId: string) => removeKey(draftKey(noteId));

const mirrored = new WeakMap<NoteSync, number>();
/** Mirror a keystroke's buffer at most this often; a failure and leaving the page always write. */
const MIRROR_MS = 500;

/** Keep the unsaved text where the page can't lose it, or forget it once the server has it. */
function mirror(noteId: string, sync: NoteSync, force = true): void {
  const body = sync.pending();
  if (!body) {
    if (!sync.dirty) dropDraft(noteId);
    return;
  }
  const now = Date.now();
  if (!force && now - (mirrored.get(sync) ?? 0) < MIRROR_MS) return;
  mirrored.set(sync, now);
  writeKey(draftKey(noteId), JSON.stringify({ content: body.content, base: body.baseContent, at: now } satisfies Draft));
}

/**
 * The text a draft would restore, merged onto the note as the server has it now — the same
 * three-way merge a save does, so whatever changed elsewhere since stays. Null when the draft is
 * already in the note (a keepalive save made it, or it was saved some other way).
 */
export function restoredText(draft: Draft, current: string): string | null {
  if (draft.content === current) return null;
  const merged = mergeText(draft.base, draft.content, current);
  return merged === current ? null : merged;
}

/**
 * A NoteSync for an open note, talking to the real API. Every editor that saves a note goes
 * through one of these — see packages/sync/src/client.ts for why the editor must not track the
 * note's hash itself. If the note was closed with typing the server never got, that sync is
 * still here, still trying: it is handed back, with the new hooks, instead of a fresh one that
 * would show the old text.
 */
export function openNoteSync(note: NoteDetail, hooks: NoteSyncHooks, delayMs?: number): NoteSync {
  const kept = live.get(note.id);
  if (kept && retired.has(kept) && !kept.gone) {
    retired.delete(kept);
    sinks.set(kept, hooks);
    return kept;
  }
  const sync = new NoteSync(
    note.path,
    { content: note.content, hash: note.hash },
    {
      save: (body) => api<{ content: string; hash: string; path: string }>("PUT", "/api/vault/note", body),
      load: () => api<NoteDetail>("GET", `/api/vault/note/${note.id}`),
    },
    {
      // One sink per sync: a note closed while failing reports on itself, never on the badge
      // of whichever note is open now (WEB-002).
      apply: (next) => sinks.get(sync)?.apply?.(next),
      saved: (n) => {
        sinks.get(sync)?.saved?.(n);
        settled(note.id, sync);
      },
      moved: (path) => sinks.get(sync)?.moved?.(path),
      gone: () => sinks.get(sync)?.gone?.(),
      status: (state, reason) => {
        mirror(note.id, sync, state !== "saving");
        sinks.get(sync)?.status?.(state, reason);
        if (state === "saved") settled(note.id, sync);
      },
    },
    delayMs,
  );
  sinks.set(sync, hooks);
  live.set(note.id, sync);
  return sync;
}

/** The hooks each sync reports to; a retired sync's are dropped (its screen is gone). */
const sinks = new WeakMap<NoteSync, NoteSyncHooks>();

/** A retired sync that has nothing left to save is done. */
function settled(noteId: string, sync: NoteSync): void {
  if (sync.dirty) return;
  dropDraft(noteId);
  if (!retired.has(sync)) return;
  retired.delete(sync);
  sync.close();
  if (live.get(noteId) === sync) live.delete(noteId);
}

/**
 * Save what is pending, then stop — for closing a note or switching away from it. A save that
 * fails does not take the text with it: the sync stays here, retrying, until the server has it.
 */
export function retire(sync: NoteSync | null): void {
  if (!sync) return;
  sinks.delete(sync);
  const id = [...live].find(([, s]) => s === sync)?.[0];
  void sync.flush().finally(() => {
    if (sync.dirty && !sync.gone) {
      retired.add(sync);
      return;
    }
    sync.close();
    if (id && live.get(id) === sync) live.delete(id);
  });
}

/** Notes whose typing the server has not stored yet, open or closed. */
export const unsavedCount = (): number => [...live.values()].filter((s) => s.dirty).length;

/** Save everything pending now, and wait for it (signing out, before a reload of our own). */
export async function flushAll(): Promise<void> {
  await Promise.all([...live.values()].map((s) => s.flush()));
}

/**
 * The page is going away. Each unsaved note goes out once more as a request the browser keeps
 * alive after the page has gone, and its draft is written in case that fails too. The answer
 * never reaches anyone, so the note's next open compares the draft with the server's text.
 */
export function sendBeforeLeaving(send: (body: SaveBody) => void = keepaliveSave): void {
  for (const [id, sync] of live) {
    const body = sync.pending();
    if (!body) continue;
    mirror(id, sync);
    send(body);
  }
}

function keepaliveSave(body: SaveBody): void {
  const token = getToken();
  try {
    void fetch("/api/vault/note", {
      method: "PUT",
      keepalive: true,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    }).catch(() => {});
  } catch {
    // Over the keepalive size limit (64 KB in some engines): the draft in storage still has it.
  }
}

/** True when leaving now would ask first: a save is failing, so the keepalive one likely will too. */
export const failing = (): boolean => [...live.values()].some((s) => s.dirty && s.error !== null);

let leaving = false;
/** Installed once by main.tsx. Reload, ⌘R, Update ready and closing the window all pass here. */
export function installLeaveGuard(win: Window = window): () => void {
  const onLeave = (e: Event) => {
    if (!leaving) sendBeforeLeaving();
    leaving = true;
    if (e.type === "beforeunload" && failing()) {
      e.preventDefault();
      (e as BeforeUnloadEvent).returnValue = "";
    }
  };
  // The page came back (the leave was cancelled, or bfcache restored it): the next leave sends again.
  const onBack = () => (leaving = false);
  win.addEventListener("beforeunload", onLeave);
  win.addEventListener("pagehide", onLeave);
  win.addEventListener("pageshow", onBack);
  win.addEventListener("focus", onBack);
  return () => {
    win.removeEventListener("beforeunload", onLeave);
    win.removeEventListener("pagehide", onLeave);
    win.removeEventListener("pageshow", onBack);
    win.removeEventListener("focus", onBack);
  };
}

/** For tests: forget every sync. */
export function resetNoteSyncs(): void {
  for (const s of live.values()) s.close();
  live.clear();
  retired.clear();
  leaving = false;
}
