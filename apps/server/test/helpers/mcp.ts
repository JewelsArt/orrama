/**
 * The MCP server's tools (apps/mcp/src/tools.ts), called the way Claude Code
 * calls them, against an in-process server with a real API token. Requests go
 * through the MCP server's own HTTP client (apps/mcp/src/http.ts), headers and
 * all, with `fetch` handed to `app.inject`: a client that sent what the server
 * refuses (a DELETE saying JSON with no body) fails here as it did live. An
 * error status throws, as the MCP server's fetch does.
 */
import type { FastifyInstance } from "fastify";
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

export async function mcpClient(app: FastifyInstance, sessionToken: string) {
  const minted = await app.inject({ method: "POST", url: "/api/tokens", headers: signedIn(sessionToken), payload: { label: "mcp test" } });
  const token: string = minted.json().token;
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
