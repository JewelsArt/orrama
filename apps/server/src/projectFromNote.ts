/**
 * Make a project from a note (N2; Jules, 10 Nov 2026: "Notes: make a project from a note").
 *
 * The project is made by `createProject`, the one way New → Project, MCP and Ask Orr's
 * create_project make one: its own note at `04-Projects/<key>.md`, on the board. The note it
 * was made from joins it by its `project/<key>` tag (membership is by tag, never by folder:
 * CLAUDE.md "Projects are bound by tag"), and moves into the project's folder only when asked.
 * Its tasks count for the project through that tag; nothing is copied. A note that brings
 * open tasks gets no "First step" placeholder (Jules, 24 Nov 2026).
 *
 * Everything that can refuse is checked before anything is written. Whatever fails after the
 * project is made puts the note back as it was and the project in the trash, so a refusal
 * leaves no half-made project behind. Undo is the page's: the note moved back
 * (`/api/vault/move`), the project deleted (`/api/projects/:slug/trash`, which takes the tag
 * off), and the project the note was in before, if any, given back (`/api/projects/:slug/notes`).
 */
import path from "node:path";
import { canEdit, parseFrontmatter, projectSlugOf, PROJECTS_DIR, updateFrontmatter, type IndexedNote } from "@orrama/core";
import type { Db } from "./db.js";
import { withProjectTag } from "./projectEdits.js";
import { HttpError, type VaultStore, type WriteGuard } from "./vaultStore.js";
import { areaNamedFor, asGroup, createProject } from "./routes/projects.js";

/** A day typed as YYYY-MM-DD that is a real day from 1900 on (the header's rule, entity/dateInput.ts). */
export function isoDayOf(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1900 || mo < 1 || mo > 12 || d < 1) return null;
  const real = new Date(Date.UTC(y, mo - 1, d));
  return real.getUTCMonth() === mo - 1 && real.getUTCDate() === d ? m[0] : null;
}

/** The projects a note's front matter puts it in, by key (`project/<slug>`). */
const projectTagsOf = (n: IndexedNote) => n.tags.filter((t) => t.line === 0 && projectSlugOf(t.tag) !== null).map((t) => t.tag);

export interface FromNote {
  noteId?: unknown;
  name?: unknown;
  area?: unknown;
  group?: unknown;
  deadline?: unknown;
  move?: unknown;
  anyway?: unknown;
}

/** `POST /api/projects/from-note`: the project made, and where the note is now. */
export function projectFromNote(store: VaultStore, db: Db, user: ReturnType<VaultStore["aclUser"]>, body: FromNote, guard?: WriteGuard) {
  if (typeof body.noteId !== "string" || !body.noteId) throw new HttpError(400, "noteId required");
  const note = store.requireReadable(user, body.noteId);
  if (!canEdit(user, note, store.grants())) throw new HttpError(403, "You can't change this note, so no project was made from it.");

  // A project's own note is the project already; a note in another project says so first, and
  // goes ahead only when asked again ("Make a new project anyway"). The second also keeps a
  // double click from making two projects.
  const keys = projectTagsOf(note);
  if (keys.some((k) => store.projectNote(k)?.id === note.id)) throw new HttpError(400, "This note is a project's own note.");
  if (keys.length > 0 && body.anyway !== true) {
    const name = store.projects(user).find((p) => p.key === keys[0])?.name ?? keys[0]!.slice("project/".length);
    throw new HttpError(409, `This note is already in ${name}.`);
  }

  const name = (typeof body.name === "string" ? body.name : note.title).replace(/\s+/g, " ").trim();
  if (!name || name.length > 120) throw new HttpError(400, "A project needs a name, at most 120 characters.");
  const area = body.area === undefined || body.area === "" ? undefined : areaNamedFor(store, user, body.area);
  const group = asGroup(body.group);
  const deadline = body.deadline === undefined || body.deadline === "" ? null : isoDayOf(body.deadline);
  if (body.deadline !== undefined && body.deadline !== "" && !deadline) throw new HttpError(400, "That due date isn't a day.");
  const fm = parseFrontmatter(note.content);
  if (fm.malformed || fm.notMapping || withProjectTag(note.content, "probe") === null) {
    throw new HttpError(409, "This note's properties can't be read, so no project was made from it. Fix them in the note first.");
  }
  const open = note.tasks.filter((t) => !t.checked).length;

  const made = createProject(store, db, user, { name, area, firstStep: open === 0 }, guard);
  const from = note.path;
  let tagged = false;
  try {
    if (group || deadline) {
      const pn = store.index.get(made.noteId)!;
      const next = updateFrontmatter(pn.content, (d) => ({ ...d, ...(group ? { group } : {}), ...(deadline ? { deadline } : {}) }));
      store.write(user, pn.path, next, undefined, undefined, { guard });
    }
    const now = store.index.get(note.id)!;
    const withTag = withProjectTag(now.content, made.slug);
    if (withTag === null) throw new HttpError(409, "This note's properties can't be read, so no project was made from it. Fix them in the note first.");
    store.write(user, now.path, withTag, undefined, undefined, { guard });
    tagged = true;
    let at = now.path;
    if (body.move === true) {
      const done = store.renameNote(user, now.path, `${PROJECTS_DIR}/${made.slug}/${path.posix.basename(now.path)}`, { links: true, guard });
      at = done.note.path;
    }
    return { ok: true, slug: made.slug, key: made.key, projectNoteId: made.noteId, projectPath: made.path, note: { id: note.id, path: at, from, moved: at !== from }, left: keys[0] ?? null, tasks: open };
  } catch (err) {
    // Back as it was: the note's own text (the tag off, another project's tag back), then the project in the trash.
    try {
      const now = store.index.get(note.id);
      if (tagged && now) store.write(user, now.path, note.content, undefined, undefined, { guard });
      store.trashNote(user, made.path);
    } catch {
      // the first failure is the one to say
    }
    throw err;
  }
}
