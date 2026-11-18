/**
 * The MCP server's tools (apps/mcp/src/tools.ts), called the way Claude Code
 * calls them, against an in-process server with a real API token. Requests go
 * through the MCP server's own HTTP client (apps/mcp/src/http.ts), headers and
 * all, with `fetch` handed to `app.inject`: a client that sent what the server
 * refuses (a DELETE saying JSON with no body) fails here as it did live. An
 * error status throws, as the MCP server's fetch does.
 */
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Db } from "../../src/db.js";
import { orramaApi } from "../../../mcp/src/http.js";
import { callTool } from "../../../mcp/src/tools.js";
import { signedIn } from "./session.js";

/** `fetch`, answered by the in-process server. */
const injectFetch = (app: FastifyInstance): typeof fetch =>
  (async (input: string | URL | Request, init: RequestInit = {}) => {
    const u = new URL(String(input));
    const r = await app.inject({
      method: (init.method ?? "GET") as "GET",
      url: u.pathname + u.search,
      headers: init.headers as Record<string, string>,
      ...(init.body !== undefined && init.body !== null ? { payload: String(init.body) } : {}),
    });
    const empty = r.statusCode === 204 || r.statusCode === 304 || r.body === "";
    return new Response(empty ? null : r.body, { status: r.statusCode, statusText: r.statusMessage, headers: Object.entries(r.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : String(v)] as [string, string]) });
  }) as typeof fetch;

/**
 * A client with an API token of `sessionToken`'s account. With `claudeOnly` (the server's
 * database), the token is the kind Connect to Claude makes (scope "mcp", mcpScope.ts): every
 * tool must work with it, since that is the token Claude holds in the desktop app.
 */
export async function mcpClient(app: FastifyInstance, sessionToken: string, claudeOnly?: Db) {
  const minted = await app.inject({ method: "POST", url: "/api/tokens", headers: signedIn(sessionToken), payload: { label: "mcp test" } });
  const token: string = minted.json().token;
  // Imported here, not at the top: db.js reads the environment, which the test sets first.
  const { tables } = await import("../../src/db.js");
  if (claudeOnly) claudeOnly.update(tables.apiTokens).set({ scope: "mcp" }).where(eq(tables.apiTokens.id, minted.json().id as string)).run();
  const api = orramaApi("http://localhost", token, injectFetch(app));
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await callTool(name, args, api);
    const text = res.content[0]?.text ?? "";
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      // an "Error: …" refusal
    }
    return { ...res, text, json };
  };
  return { token, api, tool };
}
