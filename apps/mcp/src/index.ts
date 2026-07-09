#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";

const url = process.env.BASALT_URL || "http://localhost:4623";
const token = process.env.BASALT_TOKEN;

if (!token) {
  console.error("BASALT_TOKEN environment variable is required");
  process.exit(1);
}

const server = new Server(
  {
    name: "basalt-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

async function fetchBasalt(path: string, method: string = "GET", body?: any) {
  const res = await fetch(`${url}${path}`, {
    method,
    headers: {
      "Authorization": `Bearer bslt_${token}`,
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
      `Basalt API error (${res.status}): ${msg}`
    );
  }
  return res.json();
}

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "search_notes",
        description: "Search notes using full-text search, supporting tag:, path:, task: filters",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query" },
          },
          required: ["query"],
        },
      },
      {
        name: "list_tree",
        description: "List all readable notes in the vault tree",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "read_note",
        description: "Read the full content and metadata of a note by id or path",
        inputSchema: {
          type: "object",
          properties: {
            idOrPath: { type: "string", description: "Note ID or path" },
          },
          required: ["idOrPath"],
        },
      },
      {
        name: "edit_note",
        description: "Save full content of a note",
        inputSchema: {
          type: "object",
          properties: {
            idOrPath: { type: "string", description: "Note ID or path" },
            content: { type: "string", description: "New full content of the note" },
          },
          required: ["idOrPath", "content"],
        },
      },
      {
        name: "append_to_note",
        description: "Append a line to an existing note",
        inputSchema: {
          type: "object",
          properties: {
            idOrPath: { type: "string", description: "Note ID or path" },
            line: { type: "string", description: "Line of text to append" },
          },
          required: ["idOrPath", "line"],
        },
      },
      {
        name: "check_task",
        description: "Check or uncheck a task within a note",
        inputSchema: {
          type: "object",
          properties: {
            noteId: { type: "string" },
            line: { type: "number", description: "Line number of the task (0-indexed) if no blockId" },
            blockId: { type: "string", description: "Block ID of the task if promoted" },
            checked: { type: "boolean" },
          },
          required: ["noteId", "checked"],
        },
      },
      {
        name: "set_task_dates",
        description: "Set start or due date for a task",
        inputSchema: {
          type: "object",
          properties: {
            noteId: { type: "string" },
            line: { type: "number" },
            blockId: { type: "string" },
            start: { type: "string", description: "YYYY-MM-DD" },
            due: { type: "string", description: "YYYY-MM-DD" },
          },
          required: ["noteId"],
        },
      },
      {
        name: "schedule_block",
        description: "Put a task on the calendar for a specific date",
        inputSchema: {
          type: "object",
          properties: {
            noteId: { type: "string" },
            line: { type: "number" },
            blockId: { type: "string" },
            date: { type: "string", description: "YYYY-MM-DD" },
          },
          required: ["noteId"],
        },
      },
      {
        name: "get_dashboard",
        description: "Get the team dashboard overview",
        inputSchema: {
          type: "object",
          properties: {
            teamSlug: { type: "string", description: "Slug of the team" },
          },
          required: ["teamSlug"],
        },
      },
      {
        name: "get_contacts",
        description: "Get a list of workspace members",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    switch (request.params.name) {
      case "search_notes": {
        const query = String(request.params.arguments?.query ?? "");
        const results = await fetchBasalt(`/api/vault/search?q=${encodeURIComponent(query)}`);
        return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
      }
      
      case "list_tree": {
        const results = await fetchBasalt(`/api/vault/tree`);
        return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
      }

      case "read_note": {
        const idOrPath = String(request.params.arguments?.idOrPath ?? "");
        // Resolve path to ID if needed (though API accepts ID, wait, API accepts ID in path `/api/vault/note/:id`. Does it accept path?)
        // Let's assume we can fetch by ID. If it's a path, we first find it via tree or search.
        // Actually, the spec says "idOrPath". Wait, the vaultRoutes API `/api/vault/note/:id` checks store.requireReadable which calls index.get(). index.get() might only accept ID.
        // Let's get the tree to map path to ID if necessary.
        let noteId = idOrPath;
        if (idOrPath.includes("/") || idOrPath.endsWith(".md")) {
          const tree = await fetchBasalt(`/api/vault/tree`);
          const match = tree.find((n: any) => n.path === idOrPath);
          if (match) noteId = match.id;
        }
        const note = await fetchBasalt(`/api/vault/note/${encodeURIComponent(noteId)}`);
        return { content: [{ type: "text", text: JSON.stringify(note, null, 2) }] };
      }

      case "edit_note": {
        const idOrPath = String(request.params.arguments?.idOrPath ?? "");
        const content = String(request.params.arguments?.content ?? "");
        
        let noteId = idOrPath;
        let path = idOrPath;
        let baseHash = undefined;

        if (idOrPath.includes("/") || idOrPath.endsWith(".md")) {
          const tree = await fetchBasalt(`/api/vault/tree`);
          const match = tree.find((n: any) => n.path === idOrPath);
          if (match) {
            noteId = match.id;
            path = match.path;
          }
        }

        try {
          // Fetch existing to get path and hash
          const note = await fetchBasalt(`/api/vault/note/${encodeURIComponent(noteId)}`);
          path = note.path;
          baseHash = note.hash;
        } catch {
          // Creating a new note, no baseHash
        }

        const saved = await fetchBasalt(`/api/vault/note`, "PUT", { path, content, baseHash });
        return { content: [{ type: "text", text: JSON.stringify(saved, null, 2) }] };
      }

      case "append_to_note": {
        const idOrPath = String(request.params.arguments?.idOrPath ?? "");
        const line = String(request.params.arguments?.line ?? "");
        
        let noteId = idOrPath;
        if (idOrPath.includes("/") || idOrPath.endsWith(".md")) {
          const tree = await fetchBasalt(`/api/vault/tree`);
          const match = tree.find((n: any) => n.path === idOrPath);
          if (match) noteId = match.id;
        }

        const note = await fetchBasalt(`/api/vault/note/${encodeURIComponent(noteId)}`);
        const newContent = note.content + (note.content.endsWith("\n") ? "" : "\n") + line;
        
        const saved = await fetchBasalt(`/api/vault/note`, "PUT", { path: note.path, content: newContent, baseHash: note.hash });
        return { content: [{ type: "text", text: JSON.stringify(saved, null, 2) }] };
      }

      case "check_task": {
        const args = request.params.arguments as any;
        const saved = await fetchBasalt(`/api/tasks/check`, "POST", {
          noteId: args.noteId,
          line: args.line,
          blockId: args.blockId,
          checked: args.checked,
        });
        return { content: [{ type: "text", text: JSON.stringify(saved, null, 2) }] };
      }

      case "set_task_dates": {
        const args = request.params.arguments as any;
        const saved = await fetchBasalt(`/api/tasks/dates`, "POST", {
          noteId: args.noteId,
          line: args.line,
          blockId: args.blockId,
          start: args.start,
          due: args.due,
        });
        return { content: [{ type: "text", text: JSON.stringify(saved, null, 2) }] };
      }

      case "schedule_block": {
        const args = request.params.arguments as any;
        const saved = await fetchBasalt(`/api/tasks/schedule`, "POST", {
          noteId: args.noteId,
          line: args.line,
          blockId: args.blockId,
          date: args.date,
        });
        return { content: [{ type: "text", text: JSON.stringify(saved, null, 2) }] };
      }

      case "get_dashboard": {
        const teamSlug = String(request.params.arguments?.teamSlug ?? "");
        const dash = await fetchBasalt(`/api/dashboard/${encodeURIComponent(teamSlug)}`);
        return { content: [{ type: "text", text: JSON.stringify(dash, null, 2) }] };
      }

      case "get_contacts": {
        const contacts = await fetchBasalt(`/api/members`);
        return { content: [{ type: "text", text: JSON.stringify(contacts, null, 2) }] };
      }

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
    }
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
  console.error("Basalt MCP server running on stdio");
}

run().catch(console.error);
