/**
 * What the People page says about each person and company beyond their own
 * front matter, in one call: their relations in the knowledge graph (the line
 * under the name, "supervises Graduation thesis") and the newest note that
 * mentions them (the column on the right, "25 Sep · Kade drinks").
 *
 * One graph and one pass over the links, rather than a /api/graph/relations
 * call and a backlinks scan per row. Both are built from the caller's readable
 * notes only (graphFor; filterReadable), so a relation to a note they cannot
 * read, or a mention in one, does not exist for them. Without an ontology the
 * graph has no types and every row's relations are empty: the page is plain.
 */
import type { FastifyInstance } from "fastify";
import { ONTOLOGY_TAG, type IndexedNote } from "@orrama/core";
import type { VaultStore } from "../vaultStore.js";
import { graphFor } from "./graph.js";

const isPerson = (n: IndexedNote) => n.tags.some((t) => t.tag === "contact");
const isCompany = (n: IndexedNote) => n.tags.some((t) => t.tag === "company");
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The day a note is about: its own `date:`, else when it was last saved. A note
 * dated after today (next week's lunch) has not happened, so it is no contact.
 */
function dayOf(n: IndexedNote, today: string): string | null {
  const d = n.frontmatter["date"];
  const day = d instanceof Date ? d.toISOString().slice(0, 10) : typeof d === "string" ? d.trim() : "";
  if (DAY_RE.test(day)) return day <= today ? day : null;
  return n.mtimeMs ? new Date(n.mtimeMs).toISOString() : null;
}

export async function peopleRoutes(app: FastifyInstance, store: VaultStore) {
  app.get("/api/people/context", { preHandler: [app.authenticate] }, async (req) => {
    const user = store.aclUser(req.userId);
    const readable = store.readable(user);
    const g = graphFor(store, req.userId);
    const typed = readable.some((n) => n.tags.some((t) => t.tag === ONTOLOGY_TAG));
    const entries = readable.filter((n) => isPerson(n) || isCompany(n));
    const wanted = new Set(entries.map((n) => n.id));

    // Mentions come from ordinary notes: a person's, a company's or a project's
    // own note links to people as a matter of record, not because you met.
    const recordNotes = new Set(
      store
        .projects(user)
        .filter((p) => p.kind === "tag")
        .map((p) => store.projectNote(p.key)?.id)
        .filter((id): id is string => !!id),
    );
    const today = new Date().toISOString().slice(0, 10);
    const newest = new Map<string, { id: string; title: string; at: string }>();
    for (const src of readable) {
      if (isPerson(src) || isCompany(src) || recordNotes.has(src.id) || src.tags.some((t) => t.tag === ONTOLOGY_TAG)) continue;
      const at = dayOf(src, today);
      if (!at) continue;
      const seen = new Set<string>();
      for (const link of src.links) {
        const to = store.index.resolveLinkOf(src, link)?.id;
        if (!to || !wanted.has(to) || seen.has(to)) continue;
        seen.add(to);
        const cur = newest.get(to);
        if (!cur || at > cur.at || (at === cur.at && src.title < cur.title)) newest.set(to, { id: src.id, title: src.title, at });
      }
    }

    return {
      typed,
      entries: entries.map((n) => {
        const by = new Map<string, { id: string; title: string; type: string }[]>();
        for (const f of g.from(n.id)) {
          const o = g.entities.get(f.object);
          if (!o) continue;
          const list = by.get(f.relation) ?? by.set(f.relation, []).get(f.relation)!;
          if (!list.some((x) => x.id === o.id)) list.push({ id: o.id, title: o.title, type: o.type });
        }
        for (const list of by.values()) list.sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
        return {
          id: n.id,
          relations: [...by].map(([relation, to]) => ({ relation, to })).sort((a, b) => (a.relation < b.relation ? -1 : 1)),
          mention: newest.get(n.id) ?? null,
        };
      }),
    };
  });
}
