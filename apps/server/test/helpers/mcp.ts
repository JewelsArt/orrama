/**
 * The MCP server's tools (apps/mcp/src/tools.ts), called the way Claude Code
 * calls them, against an in-process server with a real API token. An error
 * status throws, as the MCP server's fetch does.
 */
import type { FastifyInstance } from "fastify";
import { callTool } from "../../../mcp/src/tools.js";

export async function mcpClient(app: FastifyInstance, sessionToken: string) {
  const minted = await app.inject({ method: "POST", url: "/api/tokens", headers: { authorization: `Bearer ${sessionToken}` }, payload: { label: "mcp test" } });
  const token: string = minted.json().token;
  const api = async (url: string, method = "GET", body?: unknown) => {
    const r = await app.inject({ method: method as "GET", url, headers: { authorization: `Bearer ${token}` }, ...(body !== undefined ? { payload: body as object } : {}) });
    if (r.statusCode >= 400) throw new Error(`Orrama API error (${r.statusCode}): ${r.json().error ?? r.statusMessage}`);
    return r.json();
  };
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
