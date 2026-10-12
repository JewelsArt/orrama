import type { FastifyInstance } from "fastify";
import { computeManifest } from "@basalt/sync";
import { noteMoveSchema, noteWriteSchema, quickCaptureSchema } from "@basalt/schema";
import { appendLine, canEdit, canRead, categorizeNote, DEFAULT_VAULT_CATEGORY_RULES, describeNote, parseVaultCategoryRules, suggestRelated, type IndexedNote } from "@basalt/core";
import { eq } from "drizzle-orm";
import { tables, type Db } from "../db.js";
import { replay } from "../history.js";
import { hash, HttpError, type VaultStore } from "../vaultStore.js";
import { graphFor } from "./graph.js";
import { isInstructionFile, tokenWriter } from "../agentWrites.js";

export async function vaultRoutes(app: FastifyInstance, db: Db, store: VaultStore) {
  const auth = { preHandler: [app.authenticate] };

  /** Folder tree + note list — the user's partial view, ACL-filtered server-side. */
  app.get("/api/vault/tree", auth, async (req) => {
    const user = store.aclUser(req.userId);
    const notes = store.readable(user).sort((a, b) => a.path.localeCompare(b.path));
    // Life-area rules come from the vault (#vault-categories), read with the
    // caller's own ACL like any note; without one, the generic PARA defaults.
    const ruleNote = notes.find((n) => n.tags.some((t) => t.tag === "vault-categories"));
    const parsed = ruleNote ? parseVaultCategoryRules(ruleNote.content) : [];
    const rules = parsed.length ? parsed : DEFAULT_VAULT_CATEGORY_RULES;
    return notes.map((n) => ({
      id: n.id,
      path: n.path,
      folder: n.folder,
      title: n.title,
      hash: store.noteHash(n),
      mtimeMs: n.mtimeMs,
      tags: [...new Set(n.tags.map((t) => t.tag))],
      openTasks: n.tasks.filter((t) => !t.checked).length,
      category: categorizeNote({ path: n.path, tags: n.tags.map((t) => t.tag) }, rules),
    }));
  });

  app.get<{ Params: { id: string } }>("/api/vault/note/:id", auth, async (req) => {
    const user = store.aclUser(req.userId);
    const note = store.requireReadable(user, req.params.id);
    const grants = store.grants();
    // Links resolve among the notes the reader can read (§5.4): a link whose
    // only target is a note they cannot read is the author's text alone,
    // exactly like a link to nothing. `locked: true` for one and `false` for
    // the other said which unreadable titles, aliases and paths exist, and an
    // unreadable note with a stronger key captured a link meant for one they
    // can read (audit ACL-005). `locked` stays in the answer, always false.
    const readable = (n: IndexedNote) => canRead(user, n, grants);
    const links = note.links.map((l) => {
      const target = store.index.resolveLinkOf(note, l, readable);
      return { ...l, targetId: target ? target.id : null, locked: false };
    });
    return {
      id: note.id,
      path: note.path,
      title: note.title,
      content: note.content,
      hash: store.noteHash(note),
      tags: note.tags,
      tasks: note.tasks,
      links,
      backlinks: store.index.backlinks(note.id, user, grants),
      canEdit: canEdit(user, note, grants),
    };
  });

  app.put("/api/vault/note", auth, async (req) => {
    const body = noteWriteSchema.parse(req.body);
    const user = store.aclUser(req.userId);
    // An API token (the MCP server) may not write an agent's standing instructions (agentWrites.ts).
    const note = store.write(user, body.path, body.content, body.baseHash, body.baseContent, { create: body.create, guard: req.viaToken ? tokenWriter : undefined });
    return { id: note.id, path: note.path, hash: hash(note.content), content: note.content };
  });

  app.post("/api/vault/move", auth, async (req) => {
    const body = noteMoveSchema.parse(req.body);
    const user = store.aclUser(req.userId);
    if (req.viaToken && (isInstructionFile(body.fromPath) || isInstructionFile(body.toPath))) {
      throw new HttpError(403, "an API token may not move a note into or out of an agent's instructions (CLAUDE.md, AGENTS.md, .claude/)");
    }
    const note = store.move(user, body.fromPath, body.toPath);
    return { id: note.id, path: note.path };
  });

  app.get<{ Querystring: { q?: string } }>("/api/vault/search", auth, async (req) => {
    const user = store.aclUser(req.userId);
    const results = store.index.search(req.query.q ?? "", user, store.grants());
    return results.slice(0, 50).map((n) => ({ id: n.id, path: n.path, title: n.title }));
  });

  app.get("/api/vault/tags", auth, async (req) => {
    const user = store.aclUser(req.userId);
    const idx = store.index.tagIndex(user, store.grants());
    return [...idx.entries()].map(([tag, ids]) => ({ tag, count: ids.size })).sort((a, b) => a.tag.localeCompare(b.tag));
  });

  app.get<{ Params: { id: string } }>("/api/vault/note/:id/related", auth, async (req) => {
    const user = store.aclUser(req.userId);
    const note = store.requireReadable(user, req.params.id);
    // ACL before AI, always (§9): candidates are the requester's readable set.
    const candidates = store.readable(user);
    return suggestRelated(note, candidates, (t) => store.index.resolveLink(t));
  });

  /**
   * Per-note version history from the Y.Doc update log (§10), newest first, a
   * page at a time: `?limit=` (≤ 100, default 50) and `?before=<seq>` for the
   * next page. Each revision carries its length; `?content=1` adds its text.
   * The log is replayed once per request (history.ts), not once per row.
   */
  app.get<{ Params: { id: string }; Querystring: { limit?: string; before?: string; content?: string } }>("/api/vault/note/:id/history", auth, async (req) => {
    const user = store.aclUser(req.userId);
    const note = store.requireReadable(user, req.params.id);
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
    const before = req.query.before !== undefined ? Number(req.query.before) : Infinity;
    if (Number.isNaN(before)) throw new HttpError(400, "before must be a revision seq");
    const withText = req.query.content === "1";
    const log = db.select().from(tables.ydocUpdates).where(eq(tables.ydocUpdates.noteId, note.id)).orderBy(tables.ydocUpdates.id).all();
    const all: { seq: number; at: number; authorId: string | null; length: number; content?: string }[] = [];
    replay(log, (row, text) => {
      if (row.id < before) all.push({ seq: row.id, at: row.createdAt, authorId: row.authorId, length: text.length, ...(withText ? { content: text } : {}) });
    });
    const page = all.reverse().slice(0, limit);
    return { revisions: page, nextBefore: all.length > limit ? page[page.length - 1]!.seq : null, total: log.length };
  });

  /** One revision's text. The seq must belong to THIS note — seqs are global. */
  app.get<{ Params: { id: string; seq: string } }>("/api/vault/note/:id/history/:seq", auth, async (req) => {
    const user = store.aclUser(req.userId);
    const note = store.requireReadable(user, req.params.id);
    const seq = Number(req.params.seq);
    const log = db.select().from(tables.ydocUpdates).where(eq(tables.ydocUpdates.noteId, note.id)).orderBy(tables.ydocUpdates.id).all();
    const upTo = log.filter((r) => r.id <= seq);
    if (!Number.isInteger(seq) || upTo[upTo.length - 1]?.id !== seq) throw new HttpError(404, "revision not found");
    let content = "";
    replay(upTo, (_row, text) => (content = text));
    const row = upTo[upTo.length - 1]!;
    return { seq, at: row.createdAt, authorId: row.authorId, content };
  });

  /**
   * Link graph over the requester's readable notes (Architecture backdrop + local
   * graph). Edges to unreadable notes are dropped entirely — not stubbed (§5.4).
   */
  app.get("/api/vault/graph", auth, async (req) => {
    const user = store.aclUser(req.userId);
    const readable = store.readable(user);
    const ids = new Set(readable.map((n) => n.id));
    const nodes = readable.map((n) => ({
      id: n.id,
      title: n.title,
      folder: n.folder,
      // Front matter is YAML: `sector: 2026` is a number. Text or nothing.
      sector: typeof n.frontmatter["sector"] === "string" && n.frontmatter["sector"] ? n.frontmatter["sector"] : null,
      tags: n.tags.map((t) => t.tag),
      links: n.links.length,
      tasks: n.tasks.filter((t) => !t.checked).length,
      /** A saved chat (ParsedNote.kind): the map hides these unless asked. */
      kind: n.kind,
      /** One line about the note, for the map's hover readout. */
      description: describeNote(n),
    }));
    const edges: { from: string; to: string; relation?: string; implied?: true }[] = [];
    for (const n of readable) {
      for (const l of n.links) {
        // Among the readable notes, as the note view resolves them (ACL-005).
        const t = store.index.resolveLinkOf(n, l, (x) => ids.has(x.id));
        if (t && t.id !== n.id) edges.push({ from: n.id, to: t.id });
      }
    }
    // Typed relations ride on the same edges: a link that says `works_at` carries the name, and a relation
    // no link spells out (a note tagged project/x belongs to the project; a conversation is about it) is an
    // edge of its own. Stated facts only — the inverse is the same edge seen from the other end, a derived
    // fact the two real ones it came from. Built from the readable notes, so nothing here names one you cannot read.
    const at = new Map<string, number>();
    edges.forEach((e, i) => at.set(`${e.from}\0${e.to}`, i));
    for (const f of graphFor(store, req.userId).facts) {
      if (f.via === "inverse" || f.via === "derived") continue;
      const i = at.get(`${f.subject}\0${f.object}`) ?? at.get(`${f.object}\0${f.subject}`);
      if (i === undefined) edges.push({ from: f.subject, to: f.object, relation: f.relation, implied: true });
      else if (edges[i]!.relation === undefined) edges[i] = { from: f.subject, to: f.object, relation: f.relation }; // the fact's direction is the meaning's
    }
    return { nodes, edges };
  });

  /** Sync manifest (§10): the desktop client's partial checkout list. */
  app.get("/api/sync/manifest", auth, async (req) => {
    const user = store.aclUser(req.userId);
    const notes = store.index.all().map((n) => ({
      id: n.id,
      path: n.path,
      contentHash: store.noteHash(n),
      folder: n.folder,
      onlyTeams: n.onlyTeams,
      shareTeams: n.shareTeams,
    }));
    return computeManifest(user, notes, store.grants());
  });

  /** Quick capture (§6.5): append to the user's PERSONAL inbox note. */
  app.post("/api/capture", auth, async (req) => {
    const body = quickCaptureSchema.parse(req.body);
    const user = store.aclUser(req.userId);
    const path = `Personal/${user.username}/Inbox.md`;
    const existing = store.index.getByPath(path);
    const line = body.text.startsWith("- ") ? body.text : `- [ ] ${body.text} @${user.username}`;
    const content = appendLine(existing?.content ?? `---\ntitle: ${user.username}'s Inbox\n---\n# Inbox\n`, line);
    const note = store.write(user, path, content);
    return { id: note.id, path: note.path };
  });
}
