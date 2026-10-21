/**
 * Rename, move and the trash, for notes and folders: the one client every page uses (stage 1,
 * 1C). Notes calls it from the tree and the note's header; the people, area and project pages
 * call the same functions and dialogs (notes/actions.tsx) for their own notes.
 *
 * Every function is one request and throws the server's refusal as an ApiError, so a dialog can
 * say it under its field (NameDialog's rule) and a one-click action can pass it to `attempt`.
 * Each change is one step from the person's point of view, and the `…WithUndo` helpers make the
 * toast's Undo the step back: a rename is renamed back (links follow again), a trashed note is
 * restored, a move is moved back.
 *
 * Jules, 21 Oct 2026: deleting moves to the notes folder's trash (restorable, emptied by hand),
 * and a rename takes the exact `[[links]]` that named the note with it.
 */
import type { Linkers, TrashItem } from "@orrama/schema/responses";
import { api } from "./api.js";
import { toast } from "./ui/overlays.js";
import { attempt } from "./ui/writes.js";

/** The folder a vault path is in ("" for the top folder). */
export const folderOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
/** A note's name: its file name without `.md`. */
export const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "");
/** `folder/name.md`. */
export const notePath = (folder: string, name: string) => `${folder ? `${folder}/` : ""}${name}.md`;
/** A folder's last part. */
export const folderLeaf = (folder: string) => folder.slice(folder.lastIndexOf("/") + 1);
const join = (folder: string, leaf: string) => (folder ? `${folder}/${leaf}` : leaf);

/**
 * A name typed into a rename or new-folder field, checked before it is sent: one name, no
 * folder in it. What a disk can't hold (`:`, `?`…) the server says, in its words.
 */
export function nameProblem(name: string, what: "note" | "folder"): string | null {
  const n = name.trim();
  if (!n) return `Give the ${what} a name.`;
  if (n.includes("/") || n.includes("\\")) return `A ${what} name can't contain a slash. To put it in another folder, use Move.`;
  if (n.startsWith(".")) return `A ${what} name can't start with a dot.`;
  return null;
}

export interface Moved {
  id: string;
  path: string;
  /** How many links in other notes were rewritten, and in how many notes. */
  links: number;
  notes: number;
}

/** Move a note to `toPath`; its exact links follow unless `links: false`. */
export const moveNote = (fromPath: string, toPath: string, opts: { links?: boolean } = {}) =>
  api<Moved>("POST", "/api/vault/move", { fromPath, toPath, links: opts.links ?? true });

/** Rename a note in its folder: the file, its title line, and the links that name it. */
export const renameNote = (path: string, name: string) => moveNote(path, notePath(folderOf(path), name.trim()));

/** Before a rename or move: which notes' links will follow, and how many won't. */
export const linkersOf = (noteId: string, toPath: string, signal?: AbortSignal) =>
  api<Linkers>("GET", `/api/vault/note/${encodeURIComponent(noteId)}/linkers?to=${encodeURIComponent(toPath)}`, undefined, { signal });

/** "2 notes link here; their links will follow." — or null when nothing links to it. */
export function linkersSentence(l: Linkers | null): string | null {
  if (!l) return null;
  const follow = l.notes.filter((n) => n.canEdit).length;
  const parts: string[] = [];
  if (follow > 0) parts.push(follow === 1 ? "1 note links here; its links will follow." : `${follow} notes link here; their links will follow.`);
  if (l.other > 0) parts.push(l.other === 1 ? "1 link won't follow: it's written another way or in a note you can't change." : `${l.other} links won't follow: they're written another way or in notes you can't change.`);
  return parts.length ? parts.join(" ") : null;
}

/** Put a note in the trash. */
export const trashNote = (path: string) => api<{ path: string; trashPath: string }>("POST", "/api/vault/trash", { path });
/** What is in the trash, newest first. */
export const trashList = () => api<TrashItem[]>("GET", "/api/vault/trash");
/** Put something in the trash back where it was (or beside it, `name (2)`, when that's taken). */
export const restoreFromTrash = (trashPath: string) => api<{ path: string; id: string | null }>("POST", "/api/vault/trash/restore", { path: trashPath });
/** The one permanent delete: everything in the trash you could change where it came from. */
export const emptyTrash = () => api<{ removed: number; kept: number }>("POST", "/api/vault/trash/empty");

/** Every folder you can see, empty ones too. */
export const listFolders = () => api<string[]>("GET", "/api/vault/folders");
export const makeFolder = (folder: string) => api<{ path: string }>("POST", "/api/vault/folder", { folder });
export const moveFolder = (from: string, to: string) => api<{ path: string; notes: number }>("POST", "/api/vault/folder/move", { from, to });
export const renameFolder = (folder: string, name: string) => moveFolder(folder, join(folderOf(folder), name.trim()));
export const trashFolder = (folder: string) => api<{ path: string; notes: number }>("POST", "/api/vault/folder/trash", { folder });

/**
 * "Moved to the trash · Undo": the note goes, the toast's Undo brings it back. `after` runs once
 * it is gone, `restored` with its id once Undo has put it back.
 */
export async function trashNoteWithUndo(path: string, title: string, on: { after?: () => void; restored?: (id: string | null) => void } = {}): Promise<boolean> {
  let trashed: { trashPath: string } | null = null;
  const ok = await attempt(`“${title}” wasn't moved to the trash.`, async () => {
    trashed = await trashNote(path);
  });
  if (!ok || !trashed) return false;
  const where = (trashed as { trashPath: string }).trashPath;
  on.after?.();
  toast(`Moved “${title}” to the trash.`, {
    ms: 8000,
    action: { label: "Undo", run: () => void attempt(`“${title}” wasn't put back.`, () => restoreFromTrash(where).then((back) => on.restored?.(back.id))) },
  });
  return true;
}

/** "Renamed · Undo" (or "Moved to …"): Undo moves it back, its links following again. */
export function sayMoved(what: string, from: string, done: Moved, after?: (path: string) => void): void {
  const followed = done.notes > 0 ? ` ${done.notes === 1 ? "1 note's links" : `${done.notes} notes' links`} followed.` : "";
  toast(`${what}${followed}`, {
    ms: 8000,
    action: {
      label: "Undo",
      run: () => void attempt("It wasn't put back.", () => moveNote(done.path, from).then((back) => after?.(back.path))),
    },
  });
}
