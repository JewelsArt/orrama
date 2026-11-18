import fs from "node:fs";
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

/** What a tool answers when Orrama can't be reached through the desktop app's connection: what to do, in words. */
export const NOT_CONNECTED = "Orrama isn't connected to Claude. In Orrama, open Settings → Connections and choose Connect to Claude.";
export const NOT_OPEN = "Orrama isn't open. Open the Orrama app, then ask again.";
export const TURNED_OFF = "Orrama turned this connection off. In Orrama, open Settings → Connections and connect to Claude again.";

/**
 * The desktop app's way in (Connect to Claude, apps/server/src/claudeConnect.ts): the address
 * and a Claude-only token live in an owner-only file in Orrama's data folder, and Claude's
 * settings name only that file (`ORRAMA_CONNECTION`). It is read at every call, never kept:
 * the app may have started on another port, or been disconnected, since Claude started this
 * server. The token is never in an answer.
 */
export function connectionApi(file: string, fetchImpl: typeof fetch = fetch): Api {
  return async (path, method = "GET", body) => {
    let c: { url?: unknown; token?: unknown };
    try {
      c = JSON.parse(fs.readFileSync(file, "utf8")) as typeof c;
    } catch {
      throw new McpError(ErrorCode.InternalError, NOT_CONNECTED);
    }
    if (typeof c.url !== "string" || typeof c.token !== "string") throw new McpError(ErrorCode.InternalError, NOT_CONNECTED);
    try {
      return await orramaApi(c.url, c.token, fetchImpl)(path, method, body);
    } catch (err) {
      if (!(err instanceof McpError)) throw new McpError(ErrorCode.InternalError, NOT_OPEN); // nothing answered at the address
      if (err.message.includes("Orrama API error (401)")) throw new McpError(ErrorCode.InternalError, TURNED_OFF);
      throw err;
    }
  };
}
