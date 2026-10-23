/**
 * Every MCP tool, and the HTTP request it makes (audit OPS-008). Claude Code
 * reaches the vault through these; a tool that dropped a field (edit_note's
 * base hash, a task's blockId) or aimed at the wrong route would turn into a
 * 409, a blind overwrite or a silent no-op, and no test noticed. Each row
 * calls the tool with every argument its schema declares and pins what goes
 * out; the real server answering each request is apps/server/test/mcp-tools.test.ts.
 */
import { describe, expect, it } from "vitest";
import { callTool, TOOLS, type Api } from "../src/tools.js";

interface Call {
  path: string;
  method: string;
  body?: unknown;
}

/** An Api that records each request and answers from `reply` (or {}); `reply` may throw, as a 4xx does. */
function recorder(reply: (c: Call) => unknown = () => ({})) {
  const calls: Call[] = [];
  const api: Api = async (path, method = "GET", body) => {
    const c: Call = { path, method, ...(body !== undefined ? { body } : {}) };
    calls.push(c);
    return reply(c);
  };
  return { calls, api };
}

interface Row {
  args: Record<string, unknown>;
  calls: Call[];
  /** Declared arguments that are not sent as given: consumed by the tool itself. */
  unsent?: string[];
  reply?: (c: Call) => unknown;
}

const NOTE = { id: "n-abc", path: "Notes/Plan.md", content: "# Plan\n\n- [ ] ship\n", hash: "h-1" };
const tree = [{ id: NOTE.id, path: NOTE.path }];
const replyNote = (c: Call) => (c.path === "/api/vault/tree" ? tree : c.method === "GET" ? NOTE : { ok: true });
const task = { noteId: "n-abc", blockId: "t-1a2b3c", text: "ship it", line: 4 };

/** One row per tool, every declared argument given a value of its own. */
const ROWS: Record<string, Row> = {
  search_notes: { args: { query: "tag:thesis due & co" }, calls: [{ path: "/api/vault/search?q=tag%3Athesis%20due%20%26%20co", method: "GET" }] },
  vault_schema: { args: {}, calls: [{ path: "/api/graph/schema", method: "GET" }] },
  find_entities: {
    args: { type: "company", status: "on-track", where: ["location=Rotterdam", "sector=A&B"], text: "acme", relation: "works_at", to: "Scooperz", limit: 5 },
    calls: [{ path: "/api/graph/entities?type=company&status=on-track&where=location%3DRotterdam&where=sector%3DA%26B&text=acme&relation=works_at&to=Scooperz&limit=5", method: "GET" }],
  },
  get_relations: { args: { entity: "Acme B.V.", relation: "involves" }, calls: [{ path: "/api/graph/relations?entity=Acme+B.V.&relation=involves", method: "GET" }] },
  find_path: { args: { from: "Me", to: "Acme", maxDepth: 3, limit: 2 }, calls: [{ path: "/api/graph/path?from=Me&to=Acme&maxDepth=3&limit=2", method: "GET" }] },
  list_summaries: {
    args: { type: "conversation", status: "paused", about: "Thesis", text: "forecast", from: "2026-09-01", to: "2026-10-01", limit: 7 },
    calls: [{ path: "/api/graph/summaries?type=conversation&status=paused&about=Thesis&text=forecast&from=2026-09-01&to=2026-10-01&limit=7", method: "GET" }],
  },
  list_tree: { args: {}, calls: [{ path: "/api/vault/tree", method: "GET" }] },
  read_note: { args: { idOrPath: "Notes/Plan.md" }, reply: replyNote, unsent: ["idOrPath"], calls: [{ path: "/api/vault/tree", method: "GET" }, { path: "/api/vault/note/n-abc", method: "GET" }] },
  edit_note: {
    args: { idOrPath: "n-abc", content: "# Plan\n\n- [x] ship\n", hash: "h-1", shrink: false },
    reply: replyNote,
    unsent: ["idOrPath", "shrink"],
    calls: [
      { path: "/api/vault/note/n-abc", method: "GET" },
      { path: "/api/vault/note", method: "PUT", body: { path: "Notes/Plan.md", content: "# Plan\n\n- [x] ship\n", baseHash: "h-1" } },
    ],
  },
  append_to_note: {
    args: { idOrPath: "n-abc", line: "- [ ] and test" },
    reply: replyNote,
    unsent: ["idOrPath"],
    calls: [
      { path: "/api/vault/note/n-abc", method: "GET" },
      { path: "/api/vault/note", method: "PUT", body: { path: NOTE.path, content: `${NOTE.content}- [ ] and test`, baseHash: "h-1", baseContent: NOTE.content } },
    ],
  },
  check_task: { args: { ...task, checked: true }, calls: [{ path: "/api/tasks/check", method: "POST", body: { ...task, checked: true } }] },
  set_task_dates: { args: { ...task, start: "2026-10-20", due: "2026-10-31" }, calls: [{ path: "/api/tasks/dates", method: "POST", body: { ...task, start: "2026-10-20", due: "2026-10-31" } }] },
  schedule_block: {
    args: { ...task, date: "2026-10-21", startMin: 600, durationMin: 45 },
    calls: [{ path: "/api/tasks/blocks", method: "POST", body: { ...task, date: "2026-10-21", startMin: 600, durationMin: 45 } }],
  },
  get_dashboard: { args: { teamSlug: "eng team" }, calls: [{ path: "/api/dashboard/eng%20team", method: "GET" }] },
  get_contacts: { args: {}, calls: [{ path: "/api/contacts", method: "GET" }] },
  create_project: { args: { name: "Kitchen Garden", domain: "personal" }, calls: [{ path: "/api/projects", method: "POST", body: { name: "Kitchen Garden", domain: "personal" } }] },
  list_projects: { args: {}, calls: [{ path: "/api/projects", method: "GET" }] },
  get_project: { args: { slug: "thesis/../x" }, calls: [{ path: "/api/projects/thesis%2F..%2Fx", method: "GET" }] },
  log_decision: { args: { slug: "garden", text: "Raised beds: the soil is clay" }, calls: [{ path: "/api/projects/garden/decisions", method: "POST", body: { text: "Raised beds: the soil is clay" } }] },
  set_task_status: { args: { ...task, status: "blocked" }, calls: [{ path: "/api/tasks/status", method: "POST", body: { ...task, status: "blocked" } }] },
  create_event: {
    args: { title: "Supervision", date: "2026-10-22", startMin: 840, durationMin: 30 },
    calls: [{ path: "/api/events", method: "POST", body: { title: "Supervision", date: "2026-10-22", startMin: 840, durationMin: 30 } }],
  },
  list_email: { args: { limit: 5 }, calls: [{ path: "/api/mail/inbox?limit=5", method: "GET" }] },
  read_email: { args: { uid: 4021 }, calls: [{ path: "/api/mail/message/4021", method: "GET" }] },
  draft_email: {
    args: { to: "mara@example.com", subject: "Re: plan", body: "Thursday works.", inReplyTo: "<m1@example.com>", references: "<m0@example.com> <m1@example.com>" },
    calls: [{ path: "/api/mail/drafts", method: "POST", body: { to: "mara@example.com", subject: "Re: plan", body: "Thursday works.", inReplyTo: "<m1@example.com>", references: "<m0@example.com> <m1@example.com>" } }],
  },
};

describe("every MCP tool sends the request its row pins", () => {
  it("every tool the server lists has a row here, and no row names a tool that is gone", () => {
    expect(Object.keys(ROWS).sort()).toEqual(TOOLS.map((t) => t.name).sort());
  });

  for (const t of TOOLS) {
    it(t.name, async () => {
      const row = ROWS[t.name]!;
      const declared = Object.keys((t.inputSchema as { properties: Record<string, unknown> }).properties);
      // The row gives every declared argument, and only declared ones.
      expect(Object.keys(row.args).sort()).toEqual([...declared].sort());
      const { calls, api } = recorder(row.reply);
      const res = await callTool(t.name, row.args, api);
      expect(res.isError).toBeFalsy();
      expect(calls).toEqual(row.calls);
      // Every argument reaches the request, unless the tool consumes it itself.
      const sent = JSON.stringify(calls);
      for (const k of declared) {
        if (row.unsent?.includes(k)) continue;
        const v = row.args[k];
        for (const part of Array.isArray(v) ? v : [v]) {
          expect(sent.includes(JSON.stringify(part)) || decodeURIComponent(sent.replace(/\+/g, " ")).includes(String(part)), `${t.name} sends ${k}`).toBe(true);
        }
      }
    });
  }
});

describe("what each tool does with what it is not given", () => {
  it("schedule_block books 09:00 for two hours by default", async () => {
    const { calls, api } = recorder();
    await callTool("schedule_block", { noteId: "n-abc", text: "ship it", date: "2026-10-21" }, api);
    expect(calls[0]!.body).toMatchObject({ startMin: 540, durationMin: 120 });
  });

  it("list_email asks for 20 by default", async () => {
    const { calls, api } = recorder();
    await callTool("list_email", {}, api);
    expect(calls).toEqual([{ path: "/api/mail/inbox?limit=20", method: "GET" }]);
  });

  it("create_project sends no domain it was not given", async () => {
    const { calls, api } = recorder();
    await callTool("create_project", { name: "Garden" }, api);
    expect(calls[0]!.body).toEqual({ name: "Garden" });
  });

  it("read_note takes an id as it is, without the tree", async () => {
    const { calls, api } = recorder(replyNote);
    await callTool("read_note", { idOrPath: "n-abc" }, api);
    expect(calls).toEqual([{ path: "/api/vault/note/n-abc", method: "GET" }]);
  });
});

describe("edit_note never writes over text it was not shown (audit AI-001)", () => {
  it("a path with no note is created, create-only", async () => {
    const { calls, api } = recorder((c) => {
      if (c.path === "/api/vault/tree") return tree;
      if (c.method === "GET") throw new Error("Orrama API error (404): note not found");
      return { ok: true };
    });
    await callTool("edit_note", { idOrPath: "Notes/New.md", content: "# New\n" }, api);
    expect(calls.at(-1)).toEqual({ path: "/api/vault/note", method: "PUT", body: { path: "Notes/New.md", content: "# New\n", create: true } });
  });

  it("an existing note without the hash: refused, nothing written", async () => {
    const { calls, api } = recorder(replyNote);
    const res = await callTool("edit_note", { idOrPath: "n-abc", content: "# Other\n" }, api);
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/read_note it and pass its hash/);
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("much shorter text: refused unless shrink is true", async () => {
    const long = { ...NOTE, content: `# Plan\n\n${"a line of the plan\n".repeat(40)}` };
    const reply = (c: Call) => (c.method === "GET" ? long : { ok: true });
    const refused = recorder(reply);
    const res = await callTool("edit_note", { idOrPath: "n-abc", content: "# Plan\n", hash: "h-1" }, refused.api);
    expect(res.isError).toBe(true);
    expect(refused.calls.filter((c) => c.method !== "GET")).toEqual([]);
    const allowed = recorder(reply);
    await callTool("edit_note", { idOrPath: "n-abc", content: "# Plan\n", hash: "h-1", shrink: true }, allowed.api);
    expect(allowed.calls.at(-1)).toMatchObject({ method: "PUT", body: { content: "# Plan\n", baseHash: "h-1" } });
  });
});

describe("draft_email only ever stages a draft", () => {
  it("posts to the drafts and nowhere that sends, and says the user must send it", async () => {
    const { calls, api } = recorder(() => ({ id: "d-1" }));
    const res = await callTool("draft_email", { to: "mara@example.com", subject: "Hi", body: "Hello" }, api);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /api/mail/drafts"]);
    expect(JSON.parse(res.content[0]!.text)).toMatchObject({ id: "d-1", status: "awaiting_confirmation" });
  });
});
