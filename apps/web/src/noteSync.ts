import { NoteSync, type NoteSyncHooks } from "@basalt/sync/client";
import { api, type NoteDetail } from "./api.js";

/**
 * A NoteSync for an open note, talking to the real API. Every editor that saves
 * a note goes through one of these — see packages/sync/src/client.ts for why
 * the editor must not track the note's hash itself.
 */
export function openNoteSync(note: NoteDetail, hooks: NoteSyncHooks, delayMs?: number): NoteSync {
  return new NoteSync(
    note.path,
    { content: note.content, hash: note.hash },
    {
      save: (body) => api<{ content: string; hash: string }>("PUT", "/api/vault/note", body),
      load: () => api<NoteDetail>("GET", `/api/vault/note/${note.id}`),
    },
    hooks,
    delayMs,
  );
}

/** Save what is pending, then stop. For closing a note or switching away from it. */
export function retire(sync: NoteSync | null): void {
  if (sync) void sync.flush().finally(() => sync.close());
}
