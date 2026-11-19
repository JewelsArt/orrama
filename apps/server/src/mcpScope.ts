/**
 * What a Claude-only token may call (scope "mcp", made by Settings → Connections → Connect to
 * Claude): the routes Orrama's MCP tools call (apps/mcp/src/tools.ts), nothing else. A full API
 * token (scope null) may call every route a token may; this one cannot read note history,
 * export, upload or delete files, empty the trash or reach anything the MCP server never uses.
 * `authenticate` (main.ts) checks it against the route's own pattern, so `/api/vault/note/:id`
 * is one row whatever the id. apps/server/test/mcp-tools.test.ts runs every tool with such a
 * token: a tool that needs a route missing here fails there.
 */
export const MCP_ROUTES: ReadonlySet<string> = new Set([
  // notes
  "GET /api/vault/tree",
  "GET /api/vault/search",
  "GET /api/vault/note/:id",
  "PUT /api/vault/note",
  "POST /api/vault/move",
  "POST /api/vault/trash",
  // steps and blocks
  "POST /api/tasks/edit",
  "POST /api/tasks/move",
  "POST /api/tasks/delete",
  "POST /api/tasks/blocks",
  // projects and life areas
  "GET /api/projects",
  "POST /api/projects",
  "GET /api/projects/:slug",
  "PATCH /api/projects/:slug",
  "POST /api/projects/:slug/capture",
  "POST /api/projects/:slug/decisions",
  "POST /api/projects/:slug/goals",
  "GET /api/areas",
  // people and companies
  "GET /api/contacts",
  "PATCH /api/contacts/:id",
  "GET /api/companies",
  "PATCH /api/companies/:id",
  // calendar
  "GET /api/events",
  "POST /api/events",
  "PATCH /api/events/:id",
  "DELETE /api/events/:id",
  // the knowledge graph
  "GET /api/graph/schema",
  "GET /api/graph/entities",
  "GET /api/graph/relations",
  "GET /api/graph/path",
  "GET /api/graph/summaries",
  // Today, money (read only), mail (read, and drafts you send yourself)
  "GET /api/home",
  "GET /api/finance",
  "GET /api/mail/inbox",
  "GET /api/mail/message/:uid",
  "POST /api/mail/drafts",
  // you (the Me page): read only
  "GET /api/persona/text",
]);

/** Whether a token of `scope` may call `method` on the route registered as `route`. */
export function scopeAllows(scope: string | null, method: string, route: string | undefined): boolean {
  if (scope === null) return true;
  if (scope === "mcp") return route !== undefined && MCP_ROUTES.has(`${method.toUpperCase()} ${route}`);
  return false; // a scope this build doesn't know grants nothing
}
