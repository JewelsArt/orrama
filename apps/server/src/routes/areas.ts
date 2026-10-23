/**
 * The life areas (1D): `GET /api/areas` lists them in order with what each holds, and
 * `PUT /api/areas` writes the whole list — add, rename, reorder, remove, and each area's words —
 * into the vault's areas note (core vaultCategories.ts), making `Orrama/Life areas.md` when the
 * vault has none. A rename or a removal takes the projects that named the area with it: their
 * `area:` (or the old `domain:` that put them there) is rewritten to the new name, or to the
 * catch-all's. Markdown stays the truth: delete the database and the list and every project's
 * area come back from the notes.
 */
import type { FastifyInstance } from "fastify";
import { lifeAreasWriteSchema } from "@orrama/schema";
import { areaOfNote, areaRules, canEdit, catchAllOf, cleanLifeAreas, LIFE_AREAS_PATH, LIFE_AREAS_TAG, lifeAreasNote, ONTOLOGY_TAG, updateFrontmatter, writeLifeAreas, type LifeArea } from "@orrama/core";
import { HttpError, type VaultStore } from "../vaultStore.js";
import { areaOf, areasFor } from "../lifeAreas.js";

export async function areaRoutes(app: FastifyInstance, store: VaultStore) {
  const auth = { preHandler: [app.authenticate] };

  app.get("/api/areas", auth, async (req) => {
    const user = store.aclUser(req.userId);
    const view = areasFor(store, user);
    const notes = new Map<string, number>();
    const projects = new Map<string, number>();
    for (const n of store.readable(user)) {
      // Orrama's own notes (what things are, this list) are not the person's.
      if (n.tags.some((t) => t.tag === ONTOLOGY_TAG || t.tag === LIFE_AREAS_TAG)) continue;
      const id = areaOf(n, view).id;
      notes.set(id, (notes.get(id) ?? 0) + 1);
      if (view.projects.has(n.id)) projects.set(id, (projects.get(id) ?? 0) + 1);
    }
    const grants = store.grants();
    return {
      areas: view.areas.map((a) => ({ id: a.id, name: a.name, words: a.words, catchAll: a.catchAll, notes: notes.get(a.id) ?? 0, projects: projects.get(a.id) ?? 0 })),
      note: view.note ? { id: view.note.id, path: view.note.path, hash: store.noteHash(view.note) } : null,
      // Without a note, the list is made where the first change goes.
      canEdit: view.note ? canEdit(user, view.note, grants) : canEdit(user, { folder: LIFE_AREAS_PATH.slice(0, LIFE_AREAS_PATH.lastIndexOf("/")), onlyTeams: [], shareTeams: [] }, grants),
    };
  });

  app.put("/api/areas", auth, async (req) => {
    const body = lifeAreasWriteSchema.parse(req.body);
    const user = store.aclUser(req.userId);
    const before = areasFor(store, user);
    const clean = cleanLifeAreas(body.areas);
    if (!clean.ok) throw new HttpError(400, clean.reason);
    const next = clean.areas;
    if (before.note && body.baseHash !== undefined && store.noteHash(before.note) !== body.baseHash) {
      throw new HttpError(409, "The life areas changed since you opened them. Reload to see them.");
    }

    // Where each area of the old list goes: its `was`, the same name, or the catch-all.
    const rest = next.find((a) => a.catchAll)!;
    const moved = new Map<string, LifeArea>();
    body.areas.forEach((sent, i) => sent.was && before.areas.some((a) => a.id === sent.was) && moved.set(sent.was, next[i]!));
    for (const a of before.areas) if (!moved.has(a.id)) moved.set(a.id, next.find((x) => x.id === a.id) ?? rest);

    if (before.note) {
      const out = writeLifeAreas(before.note.content, next);
      if (!out.ok) throw new HttpError(409, out.reason);
      store.write(user, before.note.path, out.content);
    } else {
      store.write(user, LIFE_AREAS_PATH, lifeAreasNote(next), undefined, undefined, { create: true });
    }

    // The projects whose own note put them in an area that was renamed or removed follow it.
    // One decided by words follows its words; one the person moved by hand is moved again by hand.
    const after = { areas: next, rules: areaRules(next) };
    const grants = store.grants();
    const readable = new Set(store.readable(user).map((r) => r.id));
    let projects = 0;
    let unmoved = 0;
    for (const id of before.projects) {
      const n = store.index.get(id);
      if (!n || !readable.has(id)) continue;
      const was = areaOf(n, before);
      if (was.source !== "named" && was.source !== "domain") continue;
      const target = moved.get(was.id) ?? rest;
      const now = areaOfNote({ path: n.path, tags: n.tags.map((t) => t.tag), frontmatter: n.frontmatter, project: true }, after.areas, after.rules);
      const named = typeof n.frontmatter["area"] === "string" ? (n.frontmatter["area"] as string).trim() : null;
      if (now.id === target.id && (named === null || named === target.name)) continue;
      if (!canEdit(user, n, grants)) {
        unmoved++;
        continue;
      }
      const content = updateFrontmatter(n.content, (d) => ({ ...d, area: target.name, domain: undefined }));
      if (content === n.content) {
        unmoved++;
        continue;
      }
      try {
        store.write(user, n.path, content);
        projects++;
      } catch {
        unmoved++;
      }
    }
    return { ok: true, projects, unmoved, rest: catchAllOf(next) };
  });
}
