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
import { graphPath, type GraphTool } from "./graphQuery.js";

const url = process.env.BASALT_URL || "http://localhost:4623";
const token = process.env.BASALT_TOKEN;

if (!token) {
  console.error("BASALT_TOKEN environment variable is required");
  process.exit(1);
}

const server = new Server(
  {
    name: "basalt-mcp",
    version: "0.1.0",
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
        description: "Search notes using full-text search, supporting tag:, path:, task: filters. For questions about people, companies, projects, status, deadlines or conversations, try vault_schema, find_entities, get_relations or list_summaries first — they answer in a fraction of the tokens; search when you need words inside notes.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query" },
          },
          required: ["query"],
        },
      },
      {
        name: "vault_schema",
        description:
          "START HERE for questions about people, companies, projects, their status or deadlines, or saved Claude conversations. A ~2k-token map of the vault: the kinds of notes (types) and how many, the relations between them (works_at, involves, part_of, about, supervises…) with counts, project statuses, the most-connected notes and data warnings. Far cheaper than searching or reading notes.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "find_entities",
        description:
          "List notes by type and facts instead of searching text. Examples: type=company where=[\"location=Rotterdam\"]; type=project status=archived; type=document where=[\"deadline=2026-10-19\"]; relation=works_at to=Scooperz (who works there). Returns id, title, type, status, a one-line summary and the front-matter fields. Prefer it to search_notes for any 'which … are …' or 'list the …' question. Field matches are exact (case-insensitive); start a value with ~ for 'contains'. Types come from vault_schema.",
        inputSchema: {
          type: "object",
          properties: {
            type: { type: "string", description: "person, company, project, document, area, conversation, note" },
            status: { type: "string", description: "planned, on-track, at-risk, paused, completed, archived, cancelled" },
            where: { type: "array", items: { type: "string" }, description: "field=value filters, e.g. location=Rotterdam, deadline=2026-10-19, role=CEO" },
            text: { type: "string", description: "words in the title or one-line summary" },
            relation: { type: "string", description: "with `to`: only notes that have this relation to that note (works_at, involves, part_of, about, supervises, involved_in…)" },
            to: { type: "string", description: "the note the relation points at (title, path or id)" },
            limit: { type: "number", description: "default 25, max 100" },
          },
        },
      },
      {
        name: "get_relations",
        description:
          "Everything one note is connected to, grouped by relation (works_at / employs, involves / involved_in, part_of / has_part, about / discussed_in, supervises / supervised_by, involves_company), each with where it was read. Use for 'who works at X', 'which people does project X involve', 'what belongs to project X', 'what is this conversation about'. Accepts a title, path or id. Cheaper and more complete than reading the note: a long note's links are all here.",
        inputSchema: {
          type: "object",
          properties: {
            entity: { type: "string", description: "Title, path or id of the note" },
            relation: { type: "string", description: "Only this relation, e.g. involves" },
          },
          required: ["entity"],
        },
      },
      {
        name: "find_path",
        description: "How two notes are connected: the shortest chains of typed relations between them, step by step with where each was read. found=false means no typed connection within maxDepth (default 4).",
        inputSchema: {
          type: "object",
          properties: {
            from: { type: "string", description: "Title, path or id" },
            to: { type: "string", description: "Title, path or id" },
            maxDepth: { type: "number", description: "default 4, max 6" },
            limit: { type: "number", description: "paths to return, default 3" },
          },
          required: ["from", "to"],
        },
      },
      {
        name: "list_summaries",
        description:
          "One line per note — title, date, what it is about, a one-line summary — for a filter. The way to scan many notes, above all saved Claude conversations (type=conversation, ~100 of them), for a few thousand tokens instead of reading them: find WHICH note, then read_note only that one. Newest first. Filters: type, status, about (a note), text (words in title or summary), from/to (ISO dates on the note's date), limit (default 100).",
        inputSchema: {
          type: "object",
          properties: {
            type: { type: "string" },
            status: { type: "string" },
            about: { type: "string", description: "Only notes about this one (title, path or id)" },
            text: { type: "string" },
            from: { type: "string", description: "YYYY-MM-DD" },
            to: { type: "string", description: "YYYY-MM-DD" },
            limit: { type: "number" },
          },
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
        description: "Read the full content and metadata of a note by id or path. Last, not first: find the note with find_entities, get_relations, list_summaries or search_notes, then read only that one.",
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
            blockId: { type: "string", description: "Block ID of the task if promoted" },
            text: { type: "string", description: "The task's text exactly as the note has it, if no blockId" },
            line: { type: "number", description: "Line the task is on (0-indexed): a hint between identical tasks, never enough alone" },
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
            blockId: { type: "string", description: "Block ID of the task if promoted" },
            text: { type: "string", description: "The task's text exactly as the note has it, if no blockId" },
            line: { type: "number", description: "Line the task is on (0-indexed): a hint between identical tasks, never enough alone" },
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
            blockId: { type: "string", description: "Block ID of the task if promoted" },
            text: { type: "string", description: "The task's text exactly as the note has it, if no blockId" },
            line: { type: "number", description: "Line the task is on (0-indexed): a hint between identical tasks, never enough alone" },
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
      {
        name: "create_project",
        description: "Create a new project. Writes a project note under 04-Projects/ so it appears on the board with tasks, planning, and dashboard progress. Add work as `- [ ]` checkbox tasks in the note afterwards.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Project name" },
            domain: { type: "string", enum: ["personal", "professional", "academic"], description: "Life-area for the Overview board" },
          },
          required: ["name"],
        },
      },
      {
        name: "list_projects",
        description: "List every project the workspace can see: slug, name, life-area domain, and task progress. Use it to find the slug for get_project.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "get_project",
        description: "Open a project workspace by slug (e.g. 'thesis-forecasting'). Returns the project's own prompt (the standing instructions its owner wrote for you), goals, status/start/deadline, every task with status, the decision log, the inbox, the contacts and companies it links to, its uploaded documents, and the full project note. Read this before working on anything the user calls 'the <name> project'.",
        inputSchema: {
          type: "object",
          properties: { slug: { type: "string", description: "Project slug from list_projects" } },
          required: ["slug"],
        },
      },
      {
        name: "log_decision",
        description: "Append a dated line to a project's ## Decisions log — what was decided and why. Use it when a choice gets made so the project note keeps its own history.",
        inputSchema: {
          type: "object",
          properties: {
            slug: { type: "string" },
            text: { type: "string", description: "The decision, one line, including the reason" },
          },
          required: ["slug", "text"],
        },
      },
      {
        name: "set_task_status",
        description: "Set a task's status. Written into the note's checkbox: [ ] todo, [/] in-progress, [b] blocked, [x] done. Identify the task by blockId, or by its text exactly as the note has it.",
        inputSchema: {
          type: "object",
          properties: {
            noteId: { type: "string" },
            blockId: { type: "string", description: "Block ID of the task if promoted" },
            text: { type: "string", description: "The task's text exactly as the note has it, if no blockId" },
            line: { type: "number", description: "Line the task is on (0-indexed): a hint between identical tasks, never enough alone" },
            status: { type: "string", enum: ["todo", "in-progress", "blocked", "done"] },
          },
          required: ["noteId", "status"],
        },
      },
      {
        name: "create_event",
        description: "Add a meeting/event to the calendar for a specific day.",
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string" },
            date: { type: "string", description: "YYYY-MM-DD" },
            startMin: { type: "number", description: "Minutes from midnight (e.g. 540 = 09:00)" },
            durationMin: { type: "number", description: "Duration in minutes (default 60)" },
          },
          required: ["title", "date", "startMin"],
        },
      },
      {
        name: "list_email",
        description: "List recent messages in the user's connected email inbox. Returns sender, subject, date, read state and a uid to read the full message. Requires a mail account connected in Basalt (Settings -> Mail).",
        inputSchema: {
          type: "object",
          properties: {
            limit: { type: "number", description: "How many recent messages (default 20, max 100)" },
          },
        },
      },
      {
        name: "read_email",
        description: "Read the full text of one inbox message by its uid (from list_email). Marks it read. Returns body plus messageId/references for threading a reply.",
        inputSchema: {
          type: "object",
          properties: {
            uid: { type: "number", description: "Message uid from list_email" },
          },
          required: ["uid"],
        },
      },
      {
        name: "draft_email",
        description: "Prepare an email from the user's connected mailbox. The draft waits in Basalt for the user to review and send — this tool cannot send mail itself, so tell the user their draft is ready rather than claiming it went out. To reply in-thread, pass inReplyTo (and references) from read_email.",
        inputSchema: {
          type: "object",
          properties: {
            to: { type: "string", description: "Recipient address(es)" },
            subject: { type: "string" },
            body: { type: "string" },
            inReplyTo: { type: "string", description: "Message-ID being replied to (optional)" },
            references: { type: "string", description: "References header for threading (optional)" },
          },
          required: ["to", "subject", "body"],
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
      
      case "vault_schema":
      case "find_entities":
      case "get_relations":
      case "find_path":
      case "list_summaries": {
        const answer = await fetchBasalt(graphPath(request.params.name as GraphTool, request.params.arguments ?? {}));
        // Compact: these answers exist to save tokens, so no indentation.
        return { content: [{ type: "text", text: JSON.stringify(answer) }] };
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
        let baseHash: string | undefined = undefined;
        let baseContent: string | undefined = undefined;

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
          baseContent = note.content;
        } catch {
          // Creating a new note, no baseHash
        }

        // edit_note REPLACES the note, so its base is the text just read: a
        // change landing between that read and this write is merged, not lost
        // (and, since the server refuses a stale hash that comes without its
        // text, not refused either).
        const saved = await fetchBasalt(`/api/vault/note`, "PUT", { path, content, baseHash, baseContent });
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
        
        const saved = await fetchBasalt(`/api/vault/note`, "PUT", { path: note.path, content: newContent, baseHash: note.hash, baseContent: note.content });
        return { content: [{ type: "text", text: JSON.stringify(saved, null, 2) }] };
      }

      case "check_task": {
        const args = request.params.arguments as any;
        const saved = await fetchBasalt(`/api/tasks/check`, "POST", {
          noteId: args.noteId,
          line: args.line,
          blockId: args.blockId,
          text: args.text,
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
          text: args.text,
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
          text: args.text,
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

      case "create_project": {
        const name = String(request.params.arguments?.name ?? "");
        const domain = request.params.arguments?.domain;
        const created = await fetchBasalt(`/api/projects`, "POST", { name, ...(domain ? { domain } : {}) });
        return { content: [{ type: "text", text: JSON.stringify(created, null, 2) }] };
      }

      case "list_projects": {
        const projects = await fetchBasalt(`/api/projects`);
        return { content: [{ type: "text", text: JSON.stringify(projects, null, 2) }] };
      }

      case "get_project": {
        const slug = String(request.params.arguments?.slug ?? "");
        const project = await fetchBasalt(`/api/projects/${encodeURIComponent(slug)}`);
        return { content: [{ type: "text", text: JSON.stringify(project, null, 2) }] };
      }

      case "log_decision": {
        const a = request.params.arguments ?? {};
        const res = await fetchBasalt(`/api/projects/${encodeURIComponent(String(a.slug ?? ""))}/decisions`, "POST", { text: a.text });
        return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
      }

      case "set_task_status": {
        const a = request.params.arguments ?? {};
        const res = await fetchBasalt(`/api/tasks/status`, "POST", { noteId: a.noteId, line: a.line, blockId: a.blockId, text: a.text, status: a.status });
        return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
      }

      case "create_event": {
        const a = request.params.arguments ?? {};
        const res = await fetchBasalt(`/api/events`, "POST", { title: a.title, date: a.date, startMin: a.startMin, durationMin: a.durationMin });
        return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
      }

      case "list_email": {
        const limit = Number(request.params.arguments?.limit ?? 20);
        const res = await fetchBasalt(`/api/mail/inbox?limit=${encodeURIComponent(limit)}`);
        return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
      }

      case "read_email": {
        const uid = Number(request.params.arguments?.uid);
        const res = await fetchBasalt(`/api/mail/message/${encodeURIComponent(uid)}`);
        return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
      }

      case "draft_email": {
        const a = request.params.arguments ?? {};
        // Staging, not sending: /api/mail/send refuses API tokens outright.
        const res = await fetchBasalt(`/api/mail/drafts`, "POST", { to: a.to, subject: a.subject, body: a.body, inReplyTo: a.inReplyTo, references: a.references });
        return { content: [{ type: "text", text: JSON.stringify({ ...res, status: "awaiting_confirmation", note: "The user must review and send this draft in Basalt." }, null, 2) }] };
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
