/**
 * The Orrery's data: four GETs the app already serves, and the life areas, read in parallel and folded into one
 * model (model.ts). The ontology's schema only adds words for relations it defines, so the
 * Orrery still opens if that one fails.
 */
import type { GraphData, TreeNote } from "@orrama/schema/responses";
import { api } from "../api.js";
import { areasNow, loadAreas } from "../categories.js";
import { buildModel, orreryAreas, signature, type Model, type ProjectRow, type SchemaRelations } from "./model.js";

export async function loadOrrery(signal?: AbortSignal): Promise<{ model: Model; sig: string }> {
  const [graph, tree, projects, schema] = await Promise.all([
    api<GraphData>("GET", "/api/vault/graph", undefined, { signal }),
    api<TreeNote[]>("GET", "/api/vault/tree", undefined, { signal }),
    api<ProjectRow[]>("GET", "/api/projects", undefined, { signal }),
    api<SchemaRelations>("GET", "/api/graph/schema", undefined, { signal }).catch(() => null),
    loadAreas(),
  ]);
  const model = buildModel(graph, tree, projects, schema, Date.now(), orreryAreas(areasNow()));
  return { model, sig: signature(model) };
}
