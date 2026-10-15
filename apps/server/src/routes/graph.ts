/**
 * The knowledge graph over HTTP: five GETs a model uses instead of reading
 * notes (MCP vault_schema, find_entities, get_relations, find_path,
 * list_summaries; the in-app agent has the same five). Thin on purpose — the
 * questions and their answers live in packages/core (graph.ts, graphQuery.ts).
 *
 * ACL BEFORE the graph: the graph is built from the caller's readable notes
 * only, so a fact about a note they cannot read does not exist for them, and a
 * reference to one is the same 404 as a reference to nothing (§5.4).
 */
import type { FastifyInstance } from "fastify";
import {
  EMPTY_ONTOLOGY,
  ONTOLOGY_TAG,
  buildGraph,
  findEntities,
  findPath,
  getRelations,
  listSummaries,
  parseOntology,
  vaultSchema,
  type KnowledgeGraph,
} from "@orrama/core";
import { z } from "zod";
import { HttpError, type VaultStore } from "../vaultStore.js";

const text = z.string().trim().min(1).max(300).optional();
const num = z.coerce.number().int().optional();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional();
/** `where=location=Rotterdam` — repeated or single; the value may itself hold `=`. */
const where = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((v, ctx) => {
    const out: Record<string, string> = {};
    for (const item of v === undefined ? [] : Array.isArray(v) ? v : [v]) {
      const at = item.indexOf("=");
      if (at < 1) {
        ctx.addIssue({ code: "custom", message: `where must be field=value, got "${item}"` });
        return z.NEVER;
      }
      out[item.slice(0, at).trim()] = item.slice(at + 1).trim();
    }
    return out;
  });

const q = {
  entities: z.object({ type: text, status: text, text, where, relation: text, to: text, limit: num }),
  relations: z.object({ entity: z.string().trim().min(1), relation: text }),
  path: z.object({ from: z.string().trim().min(1), to: z.string().trim().min(1), maxDepth: num, limit: num }),
  summaries: z.object({ type: text, status: text, about: text, text, from: day, to: day, limit: num }),
};

/** The vault's ontology note (tag #vault-ontology) among what the caller can read, then the graph over those notes. */
export function graphFor(store: VaultStore, userId: string): KnowledgeGraph {
  const readable = store.readable(store.aclUser(userId));
  const ids = new Set(readable.map((n) => n.id));
  const note = readable.filter((n) => n.tags.some((t) => t.tag === ONTOLOGY_TAG)).sort((a, b) => (a.path < b.path ? -1 : 1))[0];
  return buildGraph(store.index, note ? parseOntology(note.content) : EMPTY_ONTOLOGY, { readable: (n) => ids.has(n.id) });
}

/** An id, a path, a title or an alias — the way a link names a note — to a note the graph holds. */
export function resolveRef(store: VaultStore, g: KnowledgeGraph, ref: string): string {
  if (g.entities.has(ref)) return ref;
  const n = store.index.getByPath(ref) ?? store.index.resolveLink(ref);
  if (n && g.entities.has(n.id)) return n.id;
  throw new HttpError(404, `no such note: ${ref}`);
}

export async function graphRoutes(app: FastifyInstance, store: VaultStore) {
  const auth = { preHandler: [app.authenticate] };

  const graphIn = (userId: string) => graphFor(store, userId);
  const resolve = (g: KnowledgeGraph, ref: string) => resolveRef(store, g, ref);

  const parse = <T extends z.ZodTypeAny>(schema: T, query: unknown): z.infer<T> => {
    const r = schema.safeParse(query);
    if (!r.success) throw new HttpError(400, r.error.issues.map((i) => `${i.path.join(".") || "query"}: ${i.message}`).join("; "));
    return r.data;
  };

  app.get("/api/graph/schema", auth, async (req) => vaultSchema(graphIn(req.userId)));

  app.get("/api/graph/entities", auth, async (req) => {
    const a = parse(q.entities, req.query);
    const g = graphIn(req.userId);
    if (!!a.relation !== !!a.to) throw new HttpError(400, "relation and to go together");
    return findEntities(g, {
      type: a.type,
      status: a.status,
      text: a.text,
      where: a.where,
      limit: a.limit,
      ...(a.relation && a.to ? { relation: { relation: a.relation.toLowerCase(), to: resolve(g, a.to) } } : {}),
    });
  });

  app.get("/api/graph/relations", auth, async (req) => {
    const a = parse(q.relations, req.query);
    const g = graphIn(req.userId);
    return getRelations(g, resolve(g, a.entity), a.relation)!;
  });

  app.get("/api/graph/path", auth, async (req) => {
    const a = parse(q.path, req.query);
    const g = graphIn(req.userId);
    return findPath(g, resolve(g, a.from), resolve(g, a.to), { maxDepth: a.maxDepth, limit: a.limit });
  });

  app.get("/api/graph/summaries", auth, async (req) => {
    const a = parse(q.summaries, req.query);
    const g = graphIn(req.userId);
    return listSummaries(g, { type: a.type, status: a.status, text: a.text, from: a.from, to: a.to, limit: a.limit, ...(a.about ? { about: resolve(g, a.about) } : {}) });
  });
}
