import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { authHeader } from "./auth.js";
import type { Api } from "./tools.js";

/**
 * Orrama's HTTP API as the tools call it: the token as a Bearer, JSON both ways, an error
 * status thrown as an McpError with the server's own words. A body, and only a body, comes
 * with `Content-Type: application/json`: Fastify refuses a DELETE that says JSON and sends
 * nothing (400), which is what deleting an event over MCP did until 27 Oct 2026.
 * `fetchImpl` is the server tests' way in (an in-process server, apps/server/test/helpers/mcp.ts).
 */
export function orramaApi(url: string, token: string, fetchImpl: typeof fetch = fetch): Api {
  return async (path, method = "GET", body) => {
    const res = await fetchImpl(`${url}${path}`, {
      method,
      headers: { Authorization: authHeader(token), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      let msg = res.statusText;
      try {
        const errorData = (await res.json()) as { error?: string };
        if (errorData.error) msg = errorData.error;
      } catch {
        // ignore
      }
      throw new McpError(ErrorCode.InternalError, `Orrama API error (${res.status}): ${msg}`);
    }
    return res.json();
  };
}
