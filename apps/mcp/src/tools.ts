/**
 * The MCP server's tools: what Claude is told about (TOOLS) and what each
 * call does (callTool), over Orrama's HTTP API. Apart from index.ts, which
 * owns the stdio transport and the token, so the tools can be tested against
 * a real server without starting a process.
 *
 * Every tool is a call to a route the app's own screens use, so a token can
 * do what its owner can on screen and nothing the server keeps for a signed-in
 * session (sending mail, tokens, sessions, sign-in methods, webhooks, the mail
 * account, settings). Stage 1's model: steps are changed in their card
 * (`/api/tasks/edit`, `/move`, `/delete`), a removed note goes to the trash,
 * life areas are the user's own list, people and companies are notes with
 * facts, events repeat (MCP-A, 27 Oct 2026).
 */
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { graphPath, type GraphTool } from "./graphQuery.js";

/** One Orrama API call: resolves with the JSON answer, throws McpError on an error status. */
export type Api = (path: string, method?: string, body?: unknown) => Promise<any>;

export interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

/** A note's id: given as one, or looked up by path in the tree (the note routes take ids). */
async function noteIdOf(api: Api, idOrPath: string): Promise<string> {
  if (!idOrPath.includes("/") && !idOrPath.endsWith(".md")) return idOrPath;
  const tree: { id: string; path: string }[] = await api(`/api/vault/tree`);
  return tree.find((n) => n.path === idOrPath)?.id ?? idOrPath;
}

/** Replacing a note with text over a fifth (and 200 characters) shorter — the server's agent has the same rule (routes/ai.ts). */
const isShrink = (before: string, after: string) => after.length < before.length * 0.8 && before.length - after.length > 200;

const refusal = (text: string): ToolResult => ({ content: [{ type: "text", text: `Error: ${text}` }], isError: true });
const answer = (value: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
/** No indentation: for the answers that exist to save tokens, or are long. */
const compact = (value: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** A date argument: a day, or null to clear it ("" clears too). Undefined is "leave it". */
function dayOrNull(v: unknown, what: string): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  if (typeof v === "string" && DAY.test(v)) return v;
  throw new Error(`${what} must be YYYY-MM-DD, or null to clear it`);
}

/** Which step: the task reference every step route takes (blockId, else its text with the line as a hint). */
const taskRef = (a: Record<string, any>) => ({ noteId: a.noteId, line: a.line, blockId: a.blockId, text: a.text });

const TASK_REF = {
  noteId: { type: "string", description: "The note the step is in" },
  blockId: { type: "string", description: "The step's block id (^t-…), if it has one" },
  text: { type: "string", description: "The step's text exactly as the note has it, if no blockId" },
  line: { type: "number", description: "Line the step is on (0-indexed): a hint between identical steps, never enough alone" },
};

const PROJECT_STATUSES = ["planned", "on-track", "at-risk", "paused", "completed", "archived", "cancelled"];

const PERSON_FIELDS = ["role", "email", "phone", "linkedin", "sector"] as const;
const COMPANY_FIELDS = ["description", "sector", "linkedin", "website", "careers", "location"] as const;

/** A YAML scalar that reads back as exactly `s` (the web's New person writes them the same way, newNote.ts). */
const q = (s: string) => JSON.stringify(s);
/** The note New person / New company makes (apps/web/src/newNote.ts), facts left for the PATCH that follows. */
const personNote = (name: string) =>
  ["---", `title: ${q(name)}`, "tags: [contact]", `sector: ${q("Other")}`, ...["role", "company", "email", "phone", "linkedin"].map((k) => `${k}: ""`), "---", `# ${name}`, ""].join("\n");
const companyNote = (name: string) =>
  ["---", `title: ${q(name)}`, "tags: [company]", `sector: ${q("Other")}`, ...["description", "linkedin", "website", "careers", "location"].map((k) => `${k}: ""`), "positions: []", "---", `# ${name}`, ""].join("\n");

export const TOOLS = [
  // ---- Finding things -------------------------------------------------------
  {
    name: "vault_schema",
    description:
      "START HERE for questions about people, companies, projects, their status or deadlines, or saved Claude conversations. A ~2k-token map of the notes: the kinds of notes (types) and how many, the relations between them (works_at, involves, part_of, about, supervises…) with counts, project statuses, the most-connected notes and data warnings. Far cheaper than searching or reading notes.",
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
        status: { type: "string", description: PROJECT_STATUSES.join(", ") },
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
      "One line per note — title, date, what it is about, a one-line summary — for a filter. The way to scan many notes, above all saved Claude conversations (type=conversation), for a few thousand tokens instead of reading them: find WHICH note, then read_note only that one. Newest first. Filters: type, status, about (a note), text (words in title or summary), from/to (ISO dates on the note's date), limit (default 100).",
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
    name: "search_notes",
    description: "Search the notes' words (at most 50 hits: id, path, title), with tag:, path:, task: and assignee: filters. For questions about people, companies, projects, status, deadlines or conversations, try vault_schema, find_entities, get_relations or list_summaries first — they answer in a fraction of the tokens; search when you need words inside notes.",
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
    description: "List every note the user can read (id, path, title). Notes in the trash are not listed.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "read_note",
    description: "Read the full content and metadata of a note by id or path, with its hash (edit_note needs it to replace the note). Last, not first: find the note with find_entities, get_relations, list_summaries or search_notes, then read only that one.",
    inputSchema: {
      type: "object",
      properties: {
        idOrPath: { type: "string", description: "Note ID or path" },
      },
      required: ["idOrPath"],
    },
  },

  // ---- Notes ----------------------------------------------------------------
  {
    name: "edit_note",
    description: "Replace the whole text of a note, or create a new one at a path. Replacing an existing note needs the hash read_note returned for it: refused without it, or if the note changed since you read it (read it again). Text much shorter than the note is refused unless shrink is true. To add a line, use append_to_note: it never resends text you did not change. To rename, move or trash a note, use move_note; for a person or company, save_contact.",
    inputSchema: {
      type: "object",
      properties: {
        idOrPath: { type: "string", description: "Note ID or path" },
        content: { type: "string", description: "New full content of the note" },
        hash: { type: "string", description: "The hash read_note returned, to replace an existing note" },
        shrink: { type: "boolean", description: "Allow the new text to be much shorter than the note (removing text the user asked to remove)" },
      },
      required: ["idOrPath", "content"],
    },
  },
  {
    name: "append_to_note",
    description: "Append a line to the end of an existing note. Nothing else in it changes. To add a step, inbox line, decision or goal to a project, use add_to_project.",
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
    name: "move_note",
    description: "Rename or move a note (people and companies too), or put it in the trash. With `to`, the note moves to that path and the [[links]] in other notes that name it follow it. With trash: true, it goes to the trash (Notes → Trash in Orrama, where the user can restore it); nothing is ever deleted for good from here. A project is not trashed this way: its note stays the project's.",
    inputSchema: {
      type: "object",
      properties: {
        idOrPath: { type: "string", description: "Note ID or path" },
        to: { type: "string", description: "The new path, e.g. Contacts/Ines Vermaat.md (.md is added if missing)" },
        trash: { type: "boolean", description: "Put the note in the trash instead of moving it" },
      },
      required: ["idOrPath"],
    },
  },

  // ---- Today and steps ------------------------------------------------------
  {
    name: "get_today",
    description: "What the user's Today page says: the next 7 days' agenda (their events, subscribed calendars, booked time, steps due, money in and out), key deadlines, the steps most worth doing next, open / overdue / done counts and this week's booked hours, and the month's spending when there are statements. Start here for 'what's on my plate', 'what's due', 'plan my day'.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "edit_task",
    description:
      "Change one step (a `- [ ]` line in a note), as its card in Orrama does. Name it by blockId, or by its text exactly as the note has it. Any of: status (todo, in-progress, blocked, done: written as [ ], [/], [b], [x]), words (its text, one line), due and start (YYYY-MM-DD; null clears), priority (1 high to 3 low; null clears), key (the key-deadline tag), moveTo (a project's slug, or \"inbox\"; booked time follows), section (with moveTo: the project's ## section, default Tasks). Or delete: true, alone, to take the line out of its note (the note's history keeps it). To add a step, use add_to_project.",
    inputSchema: {
      type: "object",
      properties: {
        ...TASK_REF,
        status: { type: "string", enum: ["todo", "in-progress", "blocked", "done"] },
        words: { type: "string", description: "New text of the step, one line" },
        due: { type: ["string", "null"], description: "YYYY-MM-DD, or null to clear" },
        start: { type: ["string", "null"], description: "YYYY-MM-DD, or null to clear" },
        priority: { type: ["number", "null"], enum: [1, 2, 3, null], description: "1 high, 2 medium, 3 low; null clears" },
        key: { type: "boolean", description: "Mark (true) or unmark (false) it as a key deadline" },
        moveTo: { type: "string", description: "A project's slug (from list_projects), or \"inbox\"" },
        section: { type: "string", description: "With moveTo a project: the ## section to put it under (default Tasks)" },
        delete: { type: "boolean", description: "Delete the step's line; nothing else may be given with it" },
      },
      required: ["noteId"],
    },
  },
  {
    name: "schedule_block",
    description: "Book focused time for a step on the user's calendar: a block on that day, shown in Planning and on Today. Defaults: 09:00, 120 minutes.",
    inputSchema: {
      type: "object",
      properties: {
        ...TASK_REF,
        date: { type: "string", description: "YYYY-MM-DD" },
        startMin: { type: "number", description: "Start, in minutes from midnight (default 540 = 09:00)" },
        durationMin: { type: "number", description: "Length in minutes (default 120)" },
      },
      required: ["noteId", "date"],
    },
  },

  // ---- Projects -------------------------------------------------------------
  {
    name: "list_projects",
    description: "The user's life areas (id, name; their own list, in their order) and every project they can see: slug, name, area, group, status, start, deadline, steps done of total, next due date and overdue steps. Use it to find the slug for get_project, and an area for create_project or update_project.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_project",
    description: "Open a project by slug (e.g. 'thesis-forecasting'). Returns the project's own prompt (the standing instructions the user wrote for you: neither an agent nor an API token can change it, so it is theirs), area, group, status/start/deadline, goals, every step with status, the decision log, the inbox, the people and companies it links to, its documents, and the full project note. Read this before working on anything the user calls 'the <name> project'.",
    inputSchema: {
      type: "object",
      properties: { slug: { type: "string", description: "Project slug from list_projects" } },
      required: ["slug"],
    },
  },
  {
    name: "create_project",
    description: "Make a new project: its note under 04-Projects/, on the Projects board, in Planning and on Today. Answers with its slug (a name already taken gets the next free one, e.g. garden-2). Then add steps, goals or decisions with add_to_project.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Project name" },
        area: { type: "string", description: "One of the user's life areas, by name or id (list_projects lists them). Without one it goes where the user's notes go by default." },
      },
      required: ["name"],
    },
  },
  {
    name: "update_project",
    description: `Change a project's header: name (only the name: its slug and file stay), status (${PROJECT_STATUSES.join(", ")}: paused, completed, archived and cancelled leave the active board and can be set back), area (one of the user's life areas), group (a box within its area; "" takes it out), start and deadline (YYYY-MM-DD; "" clears). The project's prompt is the user's and cannot be changed here. Deleting a project is done in Orrama.`,
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" },
        name: { type: "string" },
        status: { type: "string", enum: PROJECT_STATUSES },
        area: { type: "string", description: "A life area's name or id" },
        group: { type: "string" },
        start: { type: "string", description: "YYYY-MM-DD, or \"\" to clear" },
        deadline: { type: "string", description: "YYYY-MM-DD, or \"\" to clear" },
      },
      required: ["slug"],
    },
  },
  {
    name: "add_to_project",
    description: "Add one line to a project: a step (a `- [ ]` under Tasks, on the board at once; with due, priority and key if given), an inbox line (a thought to sort later), a decision (dated, with what was decided and why: the project keeps its own history) or a goal.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" },
        kind: { type: "string", enum: ["step", "inbox", "decision", "goal"] },
        text: { type: "string", description: "One line" },
        due: { type: "string", description: "A step's due date, YYYY-MM-DD" },
        priority: { type: "number", enum: [1, 2, 3], description: "A step's priority: 1 high, 2 medium, 3 low" },
        key: { type: "boolean", description: "Mark the step as a key deadline" },
      },
      required: ["slug", "kind", "text"],
    },
  },

  // ---- People and companies -------------------------------------------------
  {
    name: "get_contacts",
    description: "The people (notes tagged #contact: name, role, company as written and the company note it names as companyId, email, phone, LinkedIn, sector) and the companies (name, sector, description, website, location, LinkedIn). Use it to find someone, or a company's id for save_contact, before reading their note.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "save_contact",
    description: "Make or change a person or a company, as their page in Orrama does. Without id, a new one called name is made (a person in Contacts/, a company in Contacts/Companies/; refused if that name is taken). With id, only the facts given change; \"\" empties one. A person: role, email, phone, linkedin, sector, company (where they work: a company's name or id from get_contacts; \"\" clears; a company that doesn't exist yet is made first with kind company). A company: description, sector, linkedin, website, careers, location. To rename or trash one, use move_note.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["person", "company"] },
        id: { type: "string", description: "The note's id, to change an existing one" },
        name: { type: "string", description: "To make a new one: their name" },
        role: { type: "string" },
        email: { type: "string" },
        phone: { type: "string" },
        linkedin: { type: "string" },
        sector: { type: "string" },
        company: { type: "string", description: "A person's company: its name or id" },
        description: { type: "string", description: "A company's: what it does" },
        website: { type: "string" },
        careers: { type: "string", description: "A company's careers page" },
        location: { type: "string" },
      },
      required: ["kind"],
    },
  },

  // ---- Calendar -------------------------------------------------------------
  {
    name: "list_events",
    description: "The user's calendar between two days: their own events (each day of a repeating one, with its id as <id>@<day>) and their subscribed calendars' (read-only). Each with date, start and length in minutes from midnight, all-day, place and notes.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "YYYY-MM-DD" },
        to: { type: "string", description: "YYYY-MM-DD (at most a year after from)" },
      },
      required: ["from", "to"],
    },
  },
  {
    name: "create_event",
    description: "Add an event to the user's calendar: a meeting, an appointment. It can be all day, have a place and notes, and repeat every week, two weeks, month or year, until a day or for ever.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        date: { type: "string", description: "YYYY-MM-DD (the first day, for a repeating one)" },
        startMin: { type: "number", description: "Minutes from midnight (e.g. 540 = 09:00); not for an all-day event" },
        durationMin: { type: "number", description: "Duration in minutes (default 60)" },
        allDay: { type: "boolean" },
        place: { type: "string", description: "An address or a room" },
        notes: { type: "string" },
        repeat: {
          type: "object",
          description: "e.g. {every: \"week\", interval: 2, until: null} for every two weeks for ever",
          properties: {
            every: { type: "string", enum: ["week", "month", "year"] },
            interval: { type: "number", description: "1 = every week/month/year, 2 = every other…" },
            until: { type: ["string", "null"], description: "Last day, YYYY-MM-DD, or null for ever" },
          },
          required: ["every", "interval", "until"],
        },
      },
      required: ["title", "date"],
    },
  },
  {
    name: "edit_event",
    description: "Change or delete one of the user's own events (subscribed calendars' are read-only). On a day of a repeating event (id <id>@<day> from list_events), scope \"one\" (the default) changes or deletes that day alone and \"all\" the whole series; a new date with \"all\" moves every day of it by as many days. repeat: null stops a series repeating. Only what is given changes; \"\" empties place or notes.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The event's id from list_events or create_event" },
        title: { type: "string" },
        date: { type: "string", description: "YYYY-MM-DD" },
        startMin: { type: "number" },
        durationMin: { type: "number" },
        allDay: { type: "boolean" },
        place: { type: "string" },
        notes: { type: "string" },
        repeat: {
          type: ["object", "null"],
          properties: {
            every: { type: "string", enum: ["week", "month", "year"] },
            interval: { type: "number" },
            until: { type: ["string", "null"] },
          },
          required: ["every", "interval", "until"],
        },
        scope: { type: "string", enum: ["one", "all"] },
        delete: { type: "boolean", description: "Delete it (that day, or with scope all the series)" },
      },
      required: ["id"],
    },
  },

  // ---- Money ----------------------------------------------------------------
  {
    name: "get_money",
    description: "The user's money as Orrama's Money page reads it, read-only: commitments (subscriptions and what they cost a month), income lines, payslips, the balance and runway, net per month, savings, and spending by category per month from their bank statements (typical month, last complete month). Changing money is done in Orrama.",
    inputSchema: { type: "object", properties: {} },
  },

  // ---- Mail -----------------------------------------------------------------
  {
    name: "list_email",
    description: "List recent messages in the user's connected email inbox. Returns sender, subject, date, read state and a uid to read the full message. Requires a mail account connected in Orrama (Settings → Mail).",
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
    description: "Prepare an email from the user's connected mailbox. The draft waits in Orrama for the user to review and send — this tool cannot send mail itself, so tell the user their draft is ready rather than claiming it went out. To reply in-thread, pass inReplyTo (and references) from read_email.",
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
];

/** A step's card without the list of every place it could move to (the card's menu, not Claude's). */
function cardOf(card: { places?: unknown; canEdit?: unknown } & Record<string, unknown>) {
  const { places: _places, ...rest } = card ?? {};
  return rest;
}

async function editTask(args: Record<string, any>, api: Api): Promise<ToolResult> {
  const ref = taskRef(args);
  if (args.delete === true) {
    const others = ["status", "words", "due", "start", "priority", "key", "moveTo", "section"].filter((k) => args[k] !== undefined);
    if (others.length) return refusal(`delete takes the step out; it can't be given with ${others.join(", ")}`);
    return answer(await api(`/api/tasks/delete`, "POST", ref));
  }
  const edit: Record<string, unknown> = {};
  if (args.status !== undefined) edit.status = args.status;
  if (args.words !== undefined) edit.words = args.words;
  if (args.key !== undefined) edit.key = args.key;
  if (args.priority !== undefined) edit.priority = args.priority === 0 ? null : args.priority;
  try {
    const due = dayOrNull(args.due, "due");
    const start = dayOrNull(args.start, "start");
    if (due !== undefined) edit.due = due;
    if (start !== undefined) edit.start = start;
  } catch (e) {
    return refusal((e as Error).message);
  }
  if (args.section !== undefined && args.moveTo === undefined) return refusal("section goes with moveTo: the project to move the step to");
  if (Object.keys(edit).length === 0 && args.moveTo === undefined) return refusal("nothing to change: give status, words, due, start, priority, key or moveTo (or delete: true)");

  let card: any = null;
  let at = ref;
  if (Object.keys(edit).length) {
    card = await api(`/api/tasks/edit`, "POST", { ...ref, ...edit });
    // Its words may have changed: the move names it as it is now.
    const t = card?.task;
    if (t) at = { noteId: t.noteId ?? ref.noteId, line: t.line, blockId: t.blockId ?? undefined, text: t.raw ?? t.text };
  }
  if (args.moveTo !== undefined) {
    const to = String(args.moveTo).trim();
    if (!to) return refusal("moveTo: a project's slug, or \"inbox\"");
    const dest = to.toLowerCase() === "inbox" ? { inbox: true } : { project: to, ...(args.section ? { section: String(args.section) } : {}) };
    card = await api(`/api/tasks/move`, "POST", { ...at, to: dest });
  }
  return answer(cardOf(card));
}

async function saveContact(args: Record<string, any>, api: Api): Promise<ToolResult> {
  const kind = args.kind;
  if (kind !== "person" && kind !== "company") return refusal("kind: person or company");
  const own: readonly string[] = kind === "person" ? [...PERSON_FIELDS, "company"] : COMPANY_FIELDS;
  const wrong = [...PERSON_FIELDS, ...COMPANY_FIELDS, "company"].filter((k) => args[k] !== undefined && !own.includes(k));
  if (wrong.length) return refusal(`a ${kind} has no ${[...new Set(wrong)].join(", ")}`);

  const set: Record<string, unknown> = {};
  for (const k of own) if (k !== "company" && args[k] !== undefined) set[k] = String(args[k]);
  if (kind === "person" && args.company !== undefined) {
    const want = String(args.company).trim();
    if (!want) set.companyId = null;
    else {
      // Where they work is a company note, as the page's picker writes it: never a name that names none.
      const companies: { id: string; name: string }[] = await api(`/api/companies`);
      const byId = companies.find((c) => c.id === want);
      const named = byId ? [byId] : companies.filter((c) => c.name.trim().toLowerCase() === want.toLowerCase());
      if (named.length === 0) return refusal(`no company called "${want}": make it first with save_contact kind company, then give its name or id`);
      if (named.length > 1) return refusal(`${named.length} companies are called "${want}": give the one you mean by id (get_contacts lists them)`);
      set.companyId = named[0]!.id;
    }
  }

  let id = typeof args.id === "string" && args.id ? args.id : null;
  let made: { id: string; path: string } | null = null;
  if (!id) {
    const name = String(args.name ?? "").replace(/\s+/g, " ").trim();
    if (!name) return refusal("give the name of the new " + kind + ", or the id of one to change");
    if (/[/\\]/.test(name) || name.startsWith(".")) return refusal("a name can't contain a slash or start with a dot");
    const path = kind === "person" ? `Contacts/${name}.md` : `Contacts/Companies/${name}.md`;
    // Create-only: someone already there is a 409, never replaced.
    made = await api(`/api/vault/note`, "PUT", { path, content: kind === "person" ? personNote(name) : companyNote(name), create: true });
    id = made!.id;
  } else if (Object.keys(set).length === 0) {
    return refusal("nothing to change: give the facts to set");
  }
  if (Object.keys(set).length) await api(kind === "person" ? `/api/contacts/${encodeURIComponent(id)}` : `/api/companies/${encodeURIComponent(id)}`, "PATCH", set);
  return answer({ ok: true, id, ...(made ? { made: made.path } : {}) });
}

/** Money as the page reads it, less what only its screens need (each ledger's raw table, file lists, per-row activity). */
function moneyOf(m: any) {
  const ledger = (l: any) => (l ? { totals: l.totals, count: l.count, items: l.items, ...(l.unreadable?.length ? { unreadable: l.unreadable } : {}) } : null);
  const cats = m?.spending?.categories;
  return {
    summary: m?.summary ?? null,
    subscriptions: ledger(m?.subscriptions),
    income: ledger(m?.income),
    payslips: m?.payslips ?? [],
    savings: m?.savings ?? null,
    recurring: m?.recurring ?? null,
    spending: m?.spending
      ? {
          dataThrough: m.spending.dataThrough,
          months: m.spending.months,
          categories: cats
            ? {
                typical: cats.typical,
                lastComplete: cats.lastComplete,
                completeMonths: cats.completeMonths,
                byCategory: (cats.forecast ?? []).map(({ merchants: _m, ...f }: any) => f),
              }
            : null,
          excluded: m.spending.excluded,
        }
      : null,
  };
}

export async function callTool(name: string, args: Record<string, any>, api: Api): Promise<ToolResult> {
  switch (name) {
    case "vault_schema":
    case "find_entities":
    case "get_relations":
    case "find_path":
    case "list_summaries": {
      // Compact: these answers exist to save tokens, so no indentation.
      return compact(await api(graphPath(name as GraphTool, args)));
    }

    case "search_notes": {
      const query = String(args.query ?? "");
      return answer(await api(`/api/vault/search?q=${encodeURIComponent(query)}`));
    }

    case "list_tree":
      return answer(await api(`/api/vault/tree`));

    case "read_note":
      return answer(await api(`/api/vault/note/${encodeURIComponent(await noteIdOf(api, String(args.idOrPath ?? "")))}`));

    case "edit_note": {
      const idOrPath = String(args.idOrPath ?? "");
      const content = String(args.content ?? "");
      const hash = typeof args.hash === "string" && args.hash ? args.hash : undefined;
      let note: { path: string; content: string } | null = null;
      try {
        note = await api(`/api/vault/note/${encodeURIComponent(await noteIdOf(api, idOrPath))}`);
      } catch {
        // No note there (or none this token can read): a new note.
      }
      if (!note) {
        // Create-only: a note already at that path, in any spelling, is a 409,
        // never replaced by text written without reading it.
        return answer(await api(`/api/vault/note`, "PUT", { path: idOrPath, content, create: true }));
      }
      // Replacing a note means rebuilding it, and a rebuild from anything but
      // the text read_note returned deletes what it left out (audit AI-001).
      // The hash is that text's: a note changed since is refused, not merged.
      if (!hash) return refusal(`${note.path} already exists: read_note it and pass its hash to replace it, or use append_to_note`);
      if (!args.shrink && isShrink(note.content, content)) {
        return refusal(`this would cut ${note.path} from ${note.content.length} to ${content.length} characters; send the whole note, or pass shrink: true if removing that text is what the user asked for`);
      }
      return answer(await api(`/api/vault/note`, "PUT", { path: note.path, content, baseHash: hash }));
    }

    case "append_to_note": {
      const note = await api(`/api/vault/note/${encodeURIComponent(await noteIdOf(api, String(args.idOrPath ?? "")))}`);
      const newContent = note.content + (note.content.endsWith("\n") ? "" : "\n") + String(args.line ?? "");
      return answer(await api(`/api/vault/note`, "PUT", { path: note.path, content: newContent, baseHash: note.hash, baseContent: note.content }));
    }

    case "move_note": {
      const trash = args.trash === true;
      const to = typeof args.to === "string" ? args.to.trim() : "";
      if (trash === !!to) return refusal(trash ? "give either to or trash: true, not both" : "say where: to (a new path), or trash: true");
      const note: { path: string } = await api(`/api/vault/note/${encodeURIComponent(await noteIdOf(api, String(args.idOrPath ?? "")))}`);
      if (trash) {
        const res = await api(`/api/vault/trash`, "POST", { path: note.path });
        return answer({ ...res, restore: "In Orrama: Notes → Trash → Restore." });
      }
      const toPath = /\.md$/i.test(to) ? to : `${to}.md`;
      return answer(await api(`/api/vault/move`, "POST", { fromPath: note.path, toPath, links: true }));
    }

    case "get_today":
      return compact(await api(`/api/home`));

    case "edit_task":
      return editTask(args, api);

    case "schedule_block": {
      // A real block in the calendar note, the way Planning books one. The old
      // /api/tasks/schedule only set the DB-only planned_date, which no screen
      // shows (audit AI-005).
      return answer(await api(`/api/tasks/blocks`, "POST", { ...taskRef(args), date: args.date, startMin: args.startMin ?? 540, durationMin: args.durationMin ?? 120 }));
    }

    case "list_projects": {
      const [areas, projects] = await Promise.all([api(`/api/areas`), api(`/api/projects`)]);
      return answer({
        areas: (areas?.areas ?? []).map((a: { id: string; name: string; catchAll: boolean; projects: number }) => ({ id: a.id, name: a.name, ...(a.catchAll ? { catchAll: true } : {}), projects: a.projects })),
        projects: (projects ?? []).map(({ domain: _d, noteId: _n, ...p }: Record<string, unknown>) => p),
      });
    }

    case "get_project":
      return answer(await api(`/api/projects/${encodeURIComponent(String(args.slug ?? ""))}`));

    case "create_project": {
      const name = String(args.name ?? "");
      const area = typeof args.area === "string" && args.area.trim() ? args.area.trim() : undefined;
      return answer(await api(`/api/projects`, "POST", { name, ...(area ? { area } : {}) }));
    }

    case "update_project": {
      const body: Record<string, unknown> = {};
      for (const k of ["name", "status", "area", "group", "start", "deadline"]) if (args[k] !== undefined && args[k] !== null) body[k] = String(args[k]);
      for (const k of ["start", "deadline"] as const) if (body[k] && !DAY.test(body[k] as string)) return refusal(`${k} must be YYYY-MM-DD, or "" to clear it`);
      if (body.status !== undefined && !PROJECT_STATUSES.includes(body.status as string)) return refusal(`status is one of ${PROJECT_STATUSES.join(", ")}`);
      if (Object.keys(body).length === 0) return refusal("nothing to change: give name, status, area, group, start or deadline");
      await api(`/api/projects/${encodeURIComponent(String(args.slug ?? ""))}`, "PATCH", body);
      return answer({ ok: true, changed: Object.keys(body) });
    }

    case "add_to_project": {
      const slug = encodeURIComponent(String(args.slug ?? ""));
      const text = String(args.text ?? "").replace(/\s+/g, " ").trim();
      if (!text) return refusal("text: the line to add");
      const stepOnly = ["due", "priority", "key"].filter((k) => args[k] !== undefined);
      if (args.kind !== "step" && stepOnly.length) return refusal(`${stepOnly.join(", ")} belong to a step`);
      switch (args.kind) {
        case "step": {
          if (args.due !== undefined && !(typeof args.due === "string" && DAY.test(args.due))) return refusal("due must be YYYY-MM-DD");
          if (args.priority !== undefined && ![1, 2, 3].includes(args.priority)) return refusal("priority is 1, 2 or 3");
          // The line Add a step writes (apps/web ProjectViews.tsx stepLine).
          const line = [text, args.due ? `due:${args.due}` : "", args.priority ? `!p${args.priority}` : "", args.key ? "#deadline" : ""].filter(Boolean).join(" ");
          return answer(await api(`/api/projects/${slug}/capture`, "POST", { text: line, task: true }));
        }
        case "inbox":
          return answer(await api(`/api/projects/${slug}/capture`, "POST", { text }));
        case "decision":
          return answer(await api(`/api/projects/${slug}/decisions`, "POST", { text }));
        case "goal":
          return answer(await api(`/api/projects/${slug}/goals`, "POST", { text }));
        default:
          return refusal("kind: step, inbox, decision or goal");
      }
    }

    case "get_contacts": {
      const [people, companies] = await Promise.all([api(`/api/contacts`), api(`/api/companies`)]);
      return compact({ people, companies });
    }

    case "save_contact":
      return saveContact(args, api);

    case "list_events": {
      const from = String(args.from ?? "");
      const to = String(args.to ?? "");
      if (!DAY.test(from) || !DAY.test(to)) return refusal("from and to are YYYY-MM-DD");
      if (to < from) return refusal("to is before from");
      if (Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`) > 366 * 86_400_000) return refusal("at most a year at a time");
      return compact(await api(`/api/events?from=${from}&to=${to}`));
    }

    case "create_event": {
      const body: Record<string, unknown> = { title: args.title, date: args.date };
      for (const k of ["startMin", "durationMin", "allDay", "place", "notes", "repeat"]) if (args[k] !== undefined) body[k] = args[k];
      return answer(await api(`/api/events`, "POST", body));
    }

    case "edit_event": {
      const id = encodeURIComponent(String(args.id ?? ""));
      const fields = ["title", "date", "startMin", "durationMin", "allDay", "place", "notes", "repeat"].filter((k) => args[k] !== undefined);
      if (args.delete === true) {
        if (fields.length) return refusal(`delete can't be given with ${fields.join(", ")}`);
        return answer(await api(`/api/events/${id}${args.scope === "all" ? "?scope=all" : ""}`, "DELETE"));
      }
      if (fields.length === 0) return refusal("nothing to change: give title, date, startMin, durationMin, allDay, place, notes or repeat (or delete: true)");
      const body: Record<string, unknown> = Object.fromEntries(fields.map((k) => [k, args[k]]));
      if (args.scope !== undefined) body.scope = args.scope;
      return answer(await api(`/api/events/${id}`, "PATCH", body));
    }

    case "get_money":
      return compact(moneyOf(await api(`/api/finance`)));

    case "list_email": {
      const limit = Number(args.limit ?? 20);
      return answer(await api(`/api/mail/inbox?limit=${encodeURIComponent(limit)}`));
    }

    case "read_email":
      return answer(await api(`/api/mail/message/${encodeURIComponent(Number(args.uid))}`));

    case "draft_email": {
      // Staging, not sending: /api/mail/send refuses API tokens outright.
      const res = await api(`/api/mail/drafts`, "POST", { to: args.to, subject: args.subject, body: args.body, inReplyTo: args.inReplyTo, references: args.references });
      return answer({ ...res, status: "awaiting_confirmation", note: "The user must review and send this draft in Orrama." });
    }

    default:
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
  }
}
