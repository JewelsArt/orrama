/**
 * Orr noticed (structure.md §2.15, R11): every warning the knowledge graph has, one row per
 * note, with what a fix needs as data. `/api/graph/schema` counts warnings by code; this page
 * names each one ("Pieter Bakker works at Bakker & Zn, which has no note") and offers its fix.
 *
 * Read-only, and built from the caller's readable notes only (graphFor): a warning about a note
 * they cannot read, or a relation to one, does not exist for them (§5.4).
 */
import type { FastifyInstance } from "fastify";
import { ONTOLOGY_TAG, type GraphWarning } from "@orrama/core";
import type { VaultStore } from "../vaultStore.js";
import { graphFor } from "./graph.js";

/** The order the page reads them in: what you can fix with one click first. */
const ORDER = ["unresolved-object", "person-without-company", "project-status-conflict", "project-without-status", "conversation-without-about", "range-mismatch", "document-orphan"];

export async function noticedRoutes(app: FastifyInstance, store: VaultStore) {
  app.get("/api/graph/warnings", { preHandler: [app.authenticate] }, async (req) => {
    const readable = store.readable(store.aclUser(req.userId));
    const g = graphFor(store, req.userId);
    // The same note graphFor reads the ontology from: the lowest path among the readable ones.
    const ontology = readable.filter((n) => n.tags.some((t) => t.tag === ONTOLOGY_TAG)).sort((a, b) => (a.path < b.path ? -1 : 1))[0];
    const brief = (id: string) => {
      const e = g.entities.get(id)!;
      return { id: e.id, title: e.title, type: e.type };
    };
    const row = (w: GraphWarning) => {
      const e = g.entities.get(w.note)!;
      const d = w.detail ?? {};
      return {
        code: w.code,
        message: w.message,
        note: { id: e.id, title: e.title, path: e.path, type: e.type },
        ...(d.relation ? { relation: d.relation } : {}),
        ...(d.target ? { target: d.target } : {}),
        ...(d.object && g.entities.has(d.object) ? { object: brief(d.object) } : {}),
        ...(d.found ? { found: d.found } : {}),
        ...(d.tag ? { tag: d.tag } : {}),
        ...(d.field ? { field: d.field } : {}),
        ...(d.tags ? { tags: d.tags } : {}),
      };
    };
    const rank = (code: string) => (ORDER.indexOf(code) + 1 || ORDER.length + 1);
    const warnings = [...g.warnings]
      .filter((w) => g.entities.has(w.note))
      .sort((a, b) => rank(a.code) - rank(b.code) || g.entities.get(a.note)!.title.localeCompare(g.entities.get(b.note)!.title))
      .map(row);
    return {
      typed: !!ontology,
      ontology: ontology ? { id: ontology.id, title: ontology.title, path: ontology.path } : null,
      warnings,
    };
  });
}
