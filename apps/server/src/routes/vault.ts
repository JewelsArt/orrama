import type { FastifyInstance } from "fastify";
import { computeManifest } from "@basalt/sync";
import { docFromUpdates, docContent } from "@basalt/sync";
import { noteMoveSchema, noteWriteSchema, quickCaptureSchema } from "@basalt/schema";
import { appendLine, canEdit, parseFrontmatter, suggestRelated } from "@basalt/core";
import { eq } from "drizzle-orm";
import { tables, type Db } from "../db.js";
import { hash, type VaultStore } from "../vaultStore.js";

export async function vaultRoutes(app: FastifyInstance, db: Db, store: VaultStore) {
  const auth = { preHandler: [app.authenticate] };

  /** Folder tree + note list — the user's partial view, ACL-filtered server-side. */
  app.get("/api/vault/tree", auth, async (req) => {
    const user = store.aclUser(req.userId);
    const notes = store.readable(user).sort((a, b) => a.path.localeCompare(b.path));
    return notes.map((n) => ({
      id: n.id,
      path: n.path,
      folder: n.folder,
      title: n.title,
      hash: hash(n.content),
      mtimeMs: n.mtimeMs,
      tags: [...new Set(n.tags.map((t) => t.tag))],
      openTasks: n.tasks.filter((t) => !t.checked).length,
    }));
  });

  app.get<{ Params: { id: string } }>("/api/vault/note/:id", auth, async (req) => {
    const user = store.aclUser(req.userId);
    const note = store.requireReadable(user, req.params.id);
    const grants = store.grants();
    // Locked-stub info for outgoing links (§5.4): reveal only what the author wrote.
    const links = note.links.map((l) => {
      const target = store.index.resolveLink(l.target);
      const readable = target ? store.readable(user).some((n) => n.id === target.id) : false;
      return { ...l, targetId: readable && target ? target.id : null, locked: !!target && !readable };
    });
    return {
      id: note.id,
      path: note.path,
      title: note.title,
      content: note.content,
      hash: hash(note.content),
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
    const note = store.write(user, body.path, body.content, body.baseHash, body.baseContent);
    return { id: note.id, path: note.path, hash: hash(note.content), content: note.content };
  });

  app.post("/api/vault/move", auth, async (req) => {
    const body = noteMoveSchema.parse(req.body);
    const user = store.aclUser(req.userId);
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

  /** Per-note version history from the Y.Doc update log (§10). */
  app.get<{ Params: { id: string } }>("/api/vault/note/:id/history", auth, async (req) => {
    const user = store.aclUser(req.userId);
    const note = store.requireReadable(user, req.params.id);
    const log = db.select().from(tables.ydocUpdates).where(eq(tables.ydocUpdates.noteId, note.id)).orderBy(tables.ydocUpdates.id).all();
    return log.map((row, i) => {
      const doc = docFromUpdates(log.slice(0, i + 1).map((r) => r.update));
      return { seq: row.id, at: row.createdAt, authorId: row.authorId, content: docContent(doc) };
    });
  });

  /**
   * Link graph over the requester's readable notes (Architecture backdrop + local
   * graph). Edges to unreadable notes are dropped entirely — not stubbed (§5.4).
   */
  /**
   * A one-line gist of a note: its own `description:` front-matter if the author
   * wrote one, else the first real sentence of the body — skipping headings,
   * quotes, list markers, links and images, which say nothing about content.
   */
  const describe = (n: { frontmatter: Record<string, unknown>; content: string }): string => {
    const fm = n.frontmatter["description"] ?? n.frontmatter["summary"];
    if (typeof fm === "string" && fm.trim() !== "") return fm.trim().slice(0, 220);
    const body = parseFrontmatter(n.content).bodyStart;
    const lines = n.content.split("\n").slice(body);
    let inFence = false;
    for (const raw of lines) {
      const line = raw.trim();
      if (/^(```|~~~)/.test(line)) {
        inFence = !inFence;
        continue;
      }
      if (inFence || line === "" || line.startsWith("#") || line.startsWith(">")) continue;
      if (/^(\||-{3,}|\*{3,})/.test(line)) continue;
      const text = line
        .replace(/^[-*+]\s+(\[[ xX]\]\s+)?/, "")
        .replace(/!?\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, t: string, a?: string) => a ?? t)
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/[*_`]/g, "")
        .trim();
      if (text.length > 1) return text.slice(0, 220);
    }
    return "";
  };

  app.get("/api/vault/graph", auth, async (req) => {
    const user = store.aclUser(req.userId);
    const readable = store.readable(user);
    const ids = new Set(readable.map((n) => n.id));
    const nodes = readable.map((n) => ({
      id: n.id,
      title: n.title,
      folder: n.folder,
      sector: n.frontmatter["sector"] || null,
      tags: n.tags.map((t) => t.tag),
      links: n.links.length,
      tasks: n.tasks.filter((t) => !t.checked).length,
      /** One line about the note, for the map's hover readout. */
      description: describe(n),
    }));
    const edges: { from: string; to: string }[] = [];
    for (const n of readable) {
      for (const l of n.links) {
        const t = store.index.resolveLink(l.target);
        if (t && ids.has(t.id) && t.id !== n.id) edges.push({ from: n.id, to: t.id });
      }
    }
    return { nodes, edges };
  });

  /** Sync manifest (§10): the desktop client's partial checkout list. */
  app.get("/api/sync/manifest", auth, async (req) => {
    const user = store.aclUser(req.userId);
    const notes = store.index.all().map((n) => ({
      id: n.id,
      path: n.path,
      contentHash: hash(n.content),
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
