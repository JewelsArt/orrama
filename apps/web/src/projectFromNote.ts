/**
 * Make a project from a note, and take it back (N2; Jules, 10 Nov 2026). The server makes the
 * project the way New → Project does and tags the note (`POST /api/projects/from-note`,
 * apps/server/src/projectFromNote.ts). Undo is three existing writes, in this order: the note
 * moved back first (the project's delete puts what is in its folder in the trash), then the
 * project deleted (`…/trash`, which takes the tag off the note), then the note given back to
 * the project it was in before, if it was in one.
 */
import { api } from "./api.js";
import { moveNote } from "./noteActions.js";

export interface MakeFromNote {
  noteId: string;
  name: string;
  /** A life area's id; absent leaves the project in the catch-all. */
  area?: string;
  group?: string;
  /** YYYY-MM-DD. */
  deadline?: string;
  /** Into the project's folder (04-Projects/<key>/); otherwise it stays where it is. */
  move?: boolean;
  /** The note is in another project and is to leave it. */
  anyway?: boolean;
}

export interface MadeFromNote {
  slug: string;
  key: string;
  projectNoteId: string;
  projectPath: string;
  note: { id: string; path: string; from: string; moved: boolean };
  /** The project the note left (`project/<slug>`), or null. */
  left: string | null;
  /** Its open tasks, now counted for the project. */
  tasks: number;
}

export const makeProjectFromNote = (body: MakeFromNote) => api<MadeFromNote>("POST", "/api/projects/from-note", body);

/** Undo, in the one order that is safe. Each step is a write that says itself when it fails. */
export async function undoProjectFromNote(made: MadeFromNote): Promise<void> {
  if (made.note.moved) await moveNote(made.note.path, made.note.from);
  await api("POST", `/api/projects/${encodeURIComponent(made.slug)}/trash`);
  if (made.left) await api("POST", `/api/projects/${encodeURIComponent(made.left.slice("project/".length))}/notes`, { noteId: made.note.id });
}
