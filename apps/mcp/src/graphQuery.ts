/** The five knowledge-graph tools are thin GETs over /api/graph/*; this builds the URL. */
export const GRAPH_TOOLS = {
  vault_schema: "schema",
  find_entities: "entities",
  get_relations: "relations",
  find_path: "path",
  list_summaries: "summaries",
} as const;

export type GraphTool = keyof typeof GRAPH_TOOLS;

export const isGraphTool = (name: string): name is GraphTool => Object.hasOwn(GRAPH_TOOLS, name);

/** Arguments → query string: lists repeat the key (`where=a=1&where=b=2`), empty values are dropped. */
export function graphPath(tool: GraphTool, args: Record<string, unknown> = {}): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) for (const x of v) qs.append(k, String(x));
    else qs.set(k, String(v));
  }
  const q = qs.toString();
  return `/api/graph/${GRAPH_TOOLS[tool]}${q ? `?${q}` : ""}`;
}
