#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { authHeader } from "./auth.js";
import { renamedEnvProblems } from "./env.js";
import { callTool, TOOLS } from "./tools.js";

const renamed = renamedEnvProblems(process.env);
if (renamed.length) {
  console.error(`Refusing to start — Orrama reads only ORRAMA_* variables now:\n  - ${renamed.join("\n  - ")}`);
  process.exit(1);
}

const url = process.env.ORRAMA_URL || "http://localhost:4623";
const token = process.env.ORRAMA_TOKEN;

if (!token) {
  console.error("ORRAMA_TOKEN environment variable is required");
  process.exit(1);
}

const server = new Server(
  {
    name: "orrama-mcp",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

async function fetchOrrama(path: string, method: string = "GET", body?: any) {
  const res = await fetch(`${url}${path}`, {
    method,
    headers: {
      "Authorization": authHeader(token!),
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const errorData = await res.json();
      if (errorData.error) msg = errorData.error;
    } catch {
      // ignore
    }
    throw new McpError(
      ErrorCode.InternalError,
      `Orrama API error (${res.status}): ${msg}`
    );
  }
  return res.json();
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    return await callTool(request.params.name, request.params.arguments ?? {}, fetchOrrama);
  } catch (error: any) {
    if (error instanceof McpError) throw error;
    return {
      content: [{ type: "text", text: `Error: ${error.message}` }],
      isError: true,
    };
  }
});

async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Orrama MCP server running on stdio");
}

run().catch(console.error);
