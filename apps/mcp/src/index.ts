#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { renamedEnvProblems } from "./env.js";
import { orramaApi } from "./http.js";
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

const fetchOrrama = orramaApi(url, token);

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
