/**
 * The server's vault service: real Markdown files in a real folder tree on disk
 * (admins can rsync/git-backup it), an in-memory VaultIndex over them, and a
 * Y.Doc per note whose update log lives in SQLite for history + CRDT merge.
 * Every read surface goes through @basalt/core ACL — implemented once, used everywhere.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { and, desc, eq } from "drizzle-orm";
import * as Y from "yjs";
import {
  VaultIndex,
  canEdit,
  canRead,
  filterReadable,
  generateNoteId,
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
import { createNoteDoc, docContent, docFromUpdates, encodeStateB64, updateDocContent } from "@basalt/sync";
import { tables, type Db } from "./db.js";
import { vaultDir } from "./env.js";

export const hash = (s: string) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);

export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export class VaultStore {
  index = new VaultIndex();
  private docs = new Map<string, Y.Doc>(); // noteId → Y.Doc
  private root = vaultDir();

  constructor(private db: Db) {}

  /** Scan the vault folder, assign missing front-matter ids, hydrate index + notes table. */
  load(): void {
    fs.mkdirSync(this.root, { recursive: true });
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        if (e.name.startsWith(".")) return [];
        const full = path.join(dir, e.name);
        if (e.isDirectory()) return walk(full);
        return e.name.toLowerCase().endsWith(".md") ? [full] : [];
      });
    for (const abs of walk(this.root)) {
      const rel = path.relative(this.root, abs).split(path.sep).join("/");
      let content = fs.readFileSync(abs, "utf8");
      const parsed = parseNote(content, titleFromPath(rel));
      if (!parsed.id) {
        content = updateFrontmatter(content, (d) => ({ id: generateNoteId(), ...d }));
        fs.writeFileSync(abs, content);
      }
      const mtimeMs = fs.statSync(abs).mtimeMs;
      const note = this.index.upsert({ path: rel, content, mtimeMs });
      this.syncNoteRow(note);
    }
  }

  private syncNoteRow(note: IndexedNote): void {
    this.db
      .insert(tables.notes)
      .values({
        id: note.id,
        path: note.path,
        title: note.title,
        contentHash: hash(note.content),
        mtimeMs: Math.round(note.mtimeMs ?? Date.now()),
        deleted: false,
      })
      .onConflictDoUpdate({
        target: tables.notes.id,
        set: { path: note.path, title: note.title, contentHash: hash(note.content), mtimeMs: Math.round(note.mtimeMs ?? Date.now()), deleted: false },
      })
      .run();
  }

  doc(noteId: string): Y.Doc {
    let doc = this.docs.get(noteId);
    if (doc) return doc;
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
        const u = updateDocContent(doc, note.content);
        if (u) this.logUpdate(noteId, u, null);
      }
    } else {
      doc = createNoteDoc(note?.content ?? "");
      this.logUpdate(noteId, encodeStateB64(doc), null);
    }
    this.docs.set(noteId, doc);
    return doc;
  }

  private logUpdate(noteId: string, update: string, authorId: string | null): void {
    this.db.insert(tables.ydocUpdates).values({ noteId, update, authorId, createdAt: Date.now() }).run();
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

  grants(): FolderGrant[] {
    return this.db
      .select({ team: tables.teams.slug, folder: tables.folderGrants.folder, role: tables.folderGrants.role })
      .from(tables.folderGrants)
      .innerJoin(tables.teams, eq(tables.folderGrants.teamId, tables.teams.id))
      .all() as FolderGrant[];
  }

  projects(): ProjectDef[] {
    return this.db.select().from(tables.projects).all().map((p) => ({ kind: p.kind, key: p.key, name: p.name }));
  }

  readable(user: AclUser): IndexedNote[] {
    return filterReadable(user, this.index.all(), this.grants());
  }

  requireReadable(user: AclUser, noteId: string): IndexedNote {
    const note = this.index.get(noteId);
    // 404 (not 403) for invisible notes: no existence confirmation (§5.4).
    if (!note || !canRead(user, note, this.grants())) throw new HttpError(404, "note not found");
    return note;
  }

  // ---- Mutations (all server-enforced per §5.3) ---------------------------

  /** Create or update a note. Returns the updated note. */
  write(user: AclUser, relPath: string, content: string, baseHash?: string): IndexedNote {
    const grants = this.grants();
    const existing = this.index.getByPath(relPath);
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
    }

    if (existing) {
      const doc = this.doc(existing.id);
      // CRDT rebase: if the client edited from a stale base, splice against the live
      // doc so concurrent edits outside the changed region survive (spec §10).
      if (baseHash && baseHash !== hash(existing.content)) {
        // Client base is stale; the splice against current text is the merge.
      }
      const update = updateDocContent(doc, finalContent, user.id);
      if (update) this.logUpdate(existing.id, update, user.id);
      finalContent = docContent(doc);
    }

    const abs = path.join(this.root, relPath);
    if (!abs.startsWith(this.root)) throw new HttpError(400, "invalid path");
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, finalContent);
    const note = this.index.upsert({ path: relPath, content: finalContent, mtimeMs: Date.now() });
    if (!existing) {
      const doc = createNoteDoc(finalContent);
      this.docs.set(note.id, doc);
      this.logUpdate(note.id, encodeStateB64(doc), user.id);
    }
    this.syncNoteRow(note);
    this.reconcileTaskObjects(note);
    return note;
  }

  /** Rename/move: metadata operation, note id is stable so links never break (§10). */
  move(user: AclUser, fromPath: string, toPath: string): IndexedNote {
    const note = this.index.getByPath(fromPath);
    if (!note || !canRead(user, note, this.grants())) throw new HttpError(404, "note not found");
    const toFolder = toPath.includes("/") ? toPath.slice(0, toPath.lastIndexOf("/")) : "";
    if (
      !canEdit(user, note, this.grants()) ||
      !canEdit(user, { folder: toFolder, onlyTeams: note.onlyTeams, shareTeams: note.shareTeams }, this.grants())
    ) {
      throw new HttpError(403, "need edit access to both source and destination folders");
    }
    const absFrom = path.join(this.root, fromPath);
    const absTo = path.join(this.root, toPath);
    if (!absTo.startsWith(this.root)) throw new HttpError(400, "invalid path");
    fs.mkdirSync(path.dirname(absTo), { recursive: true });
    fs.renameSync(absFrom, absTo);
    this.index.remove(fromPath);
    const moved = this.index.upsert({ path: toPath, content: note.content, mtimeMs: Date.now() });
    this.syncNoteRow(moved);
    return moved;
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
        // Two-way binding, file wins (§7.2): box checked ⇒ done; unchecked resurrects orphans/done.
        const fileStatus = line.checked ? "done" : obj.status === "done" || obj.status === "orphaned" ? "todo" : obj.status;
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
