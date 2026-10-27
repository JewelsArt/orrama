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

/** The card /api/tasks/edit and /move answer with, list of places included (the tool drops it). */
const CARD = { task: { noteId: "n-abc", line: 4, blockId: "t-1a2b3c", raw: "- [/] ship it now due:2026-10-31 !p2 #deadline ^t-1a2b3c", text: "ship it now" }, project: null, section: "Tasks", places: [{ slug: "garden" }], canEdit: true };
const replyCard = (c: Call) => (c.path.startsWith("/api/tasks/") ? CARD : {});
const COMPANIES = [{ id: "n-acme", name: "Acme B.V." }];

/** One row per tool, every declared argument given a value of its own (but those `apart` names: they can't go with the rest, and have tests of their own below). */
const ROWS: Record<string, Row & { apart?: string[] }> = {
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
  move_note: {
    args: { idOrPath: "Notes/Plan.md", to: "Archive/Old plan" },
    apart: ["trash"],
    reply: replyNote,
    unsent: ["idOrPath"],
    calls: [
      { path: "/api/vault/tree", method: "GET" },
      { path: "/api/vault/note/n-abc", method: "GET" },
      { path: "/api/vault/move", method: "POST", body: { fromPath: "Notes/Plan.md", toPath: "Archive/Old plan.md", links: true } },
    ],
  },
  get_today: { args: {}, calls: [{ path: "/api/home", method: "GET" }] },
  edit_task: {
    args: { ...task, status: "in-progress", words: "ship it now", due: "2026-10-31", start: "2026-10-20", priority: 2, key: true, moveTo: "garden", section: "Beds" },
    apart: ["delete"],
    reply: replyCard,
    calls: [
      { path: "/api/tasks/edit", method: "POST", body: { ...task, status: "in-progress", words: "ship it now", key: true, priority: 2, due: "2026-10-31", start: "2026-10-20" } },
      // The move names the step as the edit left it.
      { path: "/api/tasks/move", method: "POST", body: { noteId: "n-abc", line: 4, blockId: "t-1a2b3c", text: CARD.task.raw, to: { project: "garden", section: "Beds" } } },
    ],
  },
  schedule_block: {
    args: { ...task, date: "2026-10-21", startMin: 600, durationMin: 45 },
    calls: [{ path: "/api/tasks/blocks", method: "POST", body: { ...task, date: "2026-10-21", startMin: 600, durationMin: 45 } }],
  },
  list_projects: { args: {}, reply: (c) => (c.path === "/api/areas" ? { areas: [] } : []), calls: [{ path: "/api/areas", method: "GET" }, { path: "/api/projects", method: "GET" }] },
  get_project: { args: { slug: "thesis/../x" }, calls: [{ path: "/api/projects/thesis%2F..%2Fx", method: "GET" }] },
  create_project: { args: { name: "Kitchen Garden", area: "Personal" }, calls: [{ path: "/api/projects", method: "POST", body: { name: "Kitchen Garden", area: "Personal" } }] },
  update_project: {
    args: { slug: "garden", name: "Kitchen garden", status: "paused", area: "Home", group: "Outside", start: "2026-11-01", deadline: "" },
    calls: [{ path: "/api/projects/garden", method: "PATCH", body: { name: "Kitchen garden", status: "paused", area: "Home", group: "Outside", start: "2026-11-01", deadline: "" } }],
  },
  add_to_project: {
    args: { slug: "garden", kind: "step", text: "order seeds", due: "2026-11-02", priority: 1, key: true },
    unsent: ["kind"],
    calls: [{ path: "/api/projects/garden/capture", method: "POST", body: { text: "order seeds due:2026-11-02 !p1 #deadline", task: true } }],
  },
  get_contacts: { args: {}, calls: [{ path: "/api/contacts", method: "GET" }, { path: "/api/companies", method: "GET" }] },
  save_contact: {
    args: { kind: "person", id: "n-ines", role: "Planner", email: "ines@example.com", phone: "+31 6 1234", linkedin: "in/ines", sector: "Retail", company: "acme b.v." },
    apart: ["name", "description", "website", "careers", "location"],
    reply: (c) => (c.path === "/api/companies" ? COMPANIES : { ok: true }),
    unsent: ["kind", "company"],
    calls: [
      { path: "/api/companies", method: "GET" },
      { path: "/api/contacts/n-ines", method: "PATCH", body: { role: "Planner", email: "ines@example.com", phone: "+31 6 1234", linkedin: "in/ines", sector: "Retail", companyId: "n-acme" } },
    ],
  },
  list_events: { args: { from: "2026-10-26", to: "2026-11-01" }, calls: [{ path: "/api/events?from=2026-10-26&to=2026-11-01", method: "GET" }] },
  create_event: {
    args: { title: "Supervision", date: "2026-10-22", startMin: 840, durationMin: 30, allDay: false, place: "Room 4", notes: "Bring the draft", repeat: { every: "week", interval: 2, until: null } },
    calls: [
      {
        path: "/api/events",
        method: "POST",
        body: { title: "Supervision", date: "2026-10-22", startMin: 840, durationMin: 30, allDay: false, place: "Room 4", notes: "Bring the draft", repeat: { every: "week", interval: 2, until: null } },
      },
    ],
  },
  edit_event: {
    args: { id: "ev-1a2b@2026-10-29", title: "Supervision (moved)", date: "2026-10-30", startMin: 600, durationMin: 45, allDay: false, place: "", notes: "Online", repeat: { every: "month", interval: 1, until: "2027-01-31" }, scope: "all" },
    apart: ["delete"],
    calls: [
      {
        path: "/api/events/ev-1a2b%402026-10-29",
        method: "PATCH",
        body: { title: "Supervision (moved)", date: "2026-10-30", startMin: 600, durationMin: 45, allDay: false, place: "", notes: "Online", repeat: { every: "month", interval: 1, until: "2027-01-31" }, scope: "all" },
      },
    ],
  },
  get_money: { args: {}, calls: [{ path: "/api/finance", method: "GET" }] },
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
      const declared = Object.keys((t.inputSchema as { properties: Record<string, unknown> }).properties).filter((k) => !row.apart?.includes(k));
      // The row gives every declared argument, and only declared ones.
      expect(Object.keys(row.args).sort()).toEqual([...declared].sort());
      const { calls, api } = recorder(row.reply);
      const res = await callTool(t.name, row.args, api);
      expect(res.isError, res.content[0]?.text).toBeFalsy();
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

  it("create_project sends no area it was not given", async () => {
    const { calls, api } = recorder();
    await callTool("create_project", { name: "Garden" }, api);
    expect(calls[0]!.body).toEqual({ name: "Garden" });
  });

  it("create_event sends only what it was given", async () => {
    const { calls, api } = recorder();
    await callTool("create_event", { title: "Dentist", date: "2026-11-03", allDay: true }, api);
    expect(calls[0]!.body).toEqual({ title: "Dentist", date: "2026-11-03", allDay: true });
  });

  it("read_note takes an id as it is, without the tree", async () => {
    const { calls, api } = recorder(replyNote);
    await callTool("read_note", { idOrPath: "n-abc" }, api);
    expect(calls).toEqual([{ path: "/api/vault/note/n-abc", method: "GET" }]);
  });

  it("list_projects answers with the areas and the projects, without what only the board reads", async () => {
    const { api } = recorder((c) =>
      c.path === "/api/areas"
        ? { areas: [{ id: "work", name: "Work", words: ["Scooperz"], catchAll: false, notes: 9, projects: 2 }, { id: "personal", name: "Personal", words: [], catchAll: true, notes: 3, projects: 0 }], note: null, canEdit: true }
        : [{ slug: "garden", key: "project/garden", name: "Garden", domain: "personal", area: "personal", noteId: "n-g", status: "on-track" }],
    );
    const res = JSON.parse((await callTool("list_projects", {}, api)).content[0]!.text);
    expect(res).toEqual({
      areas: [{ id: "work", name: "Work", projects: 2 }, { id: "personal", name: "Personal", catchAll: true, projects: 0 }],
      projects: [{ slug: "garden", key: "project/garden", name: "Garden", area: "personal", status: "on-track" }],
    });
  });
});

describe("edit_task: one tool for the step's card", () => {
  it("status alone is one edit; the card comes back without its list of places", async () => {
    const { calls, api } = recorder(replyCard);
    const res = await callTool("edit_task", { ...task, status: "done" }, api);
    expect(calls).toEqual([{ path: "/api/tasks/edit", method: "POST", body: { ...task, status: "done" } }]);
    const card = JSON.parse(res.content[0]!.text);
    expect(card.task).toMatchObject({ blockId: "t-1a2b3c" });
    expect(card).not.toHaveProperty("places");
  });

  it("null and \"\" clear a date; priority 0 or null clears it", async () => {
    const { calls, api } = recorder(replyCard);
    await callTool("edit_task", { ...task, due: null, start: "", priority: 0 }, api);
    expect(calls[0]!.body).toEqual({ ...task, due: null, start: null, priority: null });
  });

  it("a date that is not a day is refused before anything is sent", async () => {
    const { calls, api } = recorder(replyCard);
    const res = await callTool("edit_task", { ...task, due: "next friday" }, api);
    expect(res.isError).toBe(true);
    expect(calls).toEqual([]);
  });

  it("moveTo inbox alone is one move", async () => {
    const { calls, api } = recorder(replyCard);
    await callTool("edit_task", { ...task, moveTo: "Inbox" }, api);
    expect(calls).toEqual([{ path: "/api/tasks/move", method: "POST", body: { ...task, to: { inbox: true } } }]);
  });

  it("delete: true takes the line out, and refuses to go with any change", async () => {
    const del = recorder();
    await callTool("edit_task", { ...task, delete: true }, del.api);
    expect(del.calls).toEqual([{ path: "/api/tasks/delete", method: "POST", body: task }]);
    const both = recorder();
    const res = await callTool("edit_task", { ...task, delete: true, status: "done" }, both.api);
    expect(res.isError).toBe(true);
    expect(both.calls).toEqual([]);
  });

  it("nothing to change, or a section without moveTo, is refused", async () => {
    const { calls, api } = recorder();
    expect((await callTool("edit_task", { ...task }, api)).isError).toBe(true);
    expect((await callTool("edit_task", { ...task, section: "Beds" }, api)).isError).toBe(true);
    expect(calls).toEqual([]);
  });
});

describe("add_to_project", () => {
  for (const [kind, call] of [
    ["inbox", { path: "/api/projects/garden/capture", method: "POST", body: { text: "ask about the shed" } }],
    ["decision", { path: "/api/projects/garden/decisions", method: "POST", body: { text: "ask about the shed" } }],
    ["goal", { path: "/api/projects/garden/goals", method: "POST", body: { text: "ask about the shed" } }],
  ] as const) {
    it(`a ${kind} goes to its own route`, async () => {
      const { calls, api } = recorder();
      await callTool("add_to_project", { slug: "garden", kind, text: "ask about\nthe shed" }, api);
      expect(calls).toEqual([call]);
    });
  }

  it("a step without extras is its words alone", async () => {
    const { calls, api } = recorder();
    await callTool("add_to_project", { slug: "garden", kind: "step", text: "water" }, api);
    expect(calls[0]!.body).toEqual({ text: "water", task: true });
  });

  it("due, priority or key on anything but a step, a bad due or priority: refused, nothing sent", async () => {
    const { calls, api } = recorder();
    for (const args of [
      { kind: "decision", text: "x", due: "2026-11-01" },
      { kind: "step", text: "x", due: "tomorrow" },
      { kind: "step", text: "x", priority: 4 },
      { kind: "plan", text: "x" },
      { kind: "step", text: "  " },
    ]) {
      expect((await callTool("add_to_project", { slug: "garden", ...args }, api)).isError, JSON.stringify(args)).toBe(true);
    }
    expect(calls).toEqual([]);
  });
});

describe("update_project", () => {
  it("refuses an unknown status, a date that is not a day, or nothing to change; nothing sent", async () => {
    const { calls, api } = recorder();
    for (const args of [{ status: "sleeping" }, { deadline: "31/12/2026" }, {}]) {
      expect((await callTool("update_project", { slug: "garden", ...args }, api)).isError, JSON.stringify(args)).toBe(true);
    }
    expect(calls).toEqual([]);
  });
});

describe("move_note", () => {
  it("trash: true puts the note in the trash and says where it can be restored", async () => {
    const { calls, api } = recorder((c) => (c.method === "GET" ? NOTE : { path: NOTE.path, trashPath: ".trash/Notes/Plan.md" }));
    const res = await callTool("move_note", { idOrPath: "n-abc", trash: true }, api);
    expect(calls.at(-1)).toEqual({ path: "/api/vault/trash", method: "POST", body: { path: "Notes/Plan.md" } });
    expect(res.content[0]!.text).toContain("Notes → Trash");
  });

  it("to and trash together, or neither: refused, nothing read or written", async () => {
    const { calls, api } = recorder(replyNote);
    expect((await callTool("move_note", { idOrPath: "n-abc", to: "X.md", trash: true }, api)).isError).toBe(true);
    expect((await callTool("move_note", { idOrPath: "n-abc" }, api)).isError).toBe(true);
    expect(calls).toEqual([]);
  });
});

describe("save_contact", () => {
  it("a new person is made create-only in Contacts/, then their facts go through the person's PATCH", async () => {
    const { calls, api } = recorder((c) => (c.path === "/api/companies" ? COMPANIES : c.method === "PUT" ? { id: "n-new", path: "Contacts/Ines Vermaat.md" } : { ok: true }));
    const res = await callTool("save_contact", { kind: "person", name: " Ines  Vermaat ", role: "Planner", company: "n-acme" }, api);
    expect(res.isError).toBeFalsy();
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /api/companies", "PUT /api/vault/note", "PATCH /api/contacts/n-new"]);
    expect(calls[1]!.body).toMatchObject({ path: "Contacts/Ines Vermaat.md", create: true });
    expect((calls[1]!.body as { content: string }).content).toMatch(/^---\ntitle: "Ines Vermaat"\ntags: \[contact\]\n/);
    expect(calls[2]!.body).toEqual({ role: "Planner", companyId: "n-acme" });
  });

  it("a new company goes to Contacts/Companies/ with its facts", async () => {
    const { calls, api } = recorder((c) => (c.method === "PUT" ? { id: "n-oak", path: "Contacts/Companies/Oakline.md" } : { ok: true }));
    await callTool("save_contact", { kind: "company", name: "Oakline", description: "Builders", website: "https://oakline.example", careers: "https://oakline.example/jobs", location: "Utrecht" }, api);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["PUT /api/vault/note", "PATCH /api/companies/n-oak"]);
    expect((calls[0]!.body as { content: string }).content).toContain("tags: [company]");
    expect(calls[1]!.body).toEqual({ description: "Builders", website: "https://oakline.example", careers: "https://oakline.example/jobs", location: "Utrecht" });
  });

  it("\"\" for company clears where they work", async () => {
    const { calls, api } = recorder();
    await callTool("save_contact", { kind: "person", id: "n-ines", company: "" }, api);
    expect(calls).toEqual([{ path: "/api/contacts/n-ines", method: "PATCH", body: { companyId: null } }]);
  });

  it("a company no note names, a fact of the other kind, a name with a slash, nothing to change: refused, nothing written", async () => {
    const { calls, api } = recorder((c) => (c.path === "/api/companies" ? COMPANIES : { ok: true }));
    for (const args of [
      { kind: "person", id: "n-ines", company: "Nowhere Ltd" },
      { kind: "person", id: "n-ines", website: "https://x.example" },
      { kind: "company", id: "n-acme", role: "CEO" },
      { kind: "person", name: "Contacts/../Ines" },
      { kind: "person", id: "n-ines" },
      { kind: "robot", name: "R2" },
    ]) {
      expect((await callTool("save_contact", args, api)).isError, JSON.stringify(args)).toBe(true);
    }
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });
});

describe("the calendar", () => {
  it("edit_event delete: one day by default, the series with scope all; never with a change", async () => {
    const { calls, api } = recorder();
    await callTool("edit_event", { id: "ev-1@2026-10-29", delete: true }, api);
    await callTool("edit_event", { id: "ev-1@2026-10-29", delete: true, scope: "all" }, api);
    expect(calls).toEqual([
      { path: "/api/events/ev-1%402026-10-29", method: "DELETE" },
      { path: "/api/events/ev-1%402026-10-29?scope=all", method: "DELETE" },
    ]);
    expect((await callTool("edit_event", { id: "ev-1", delete: true, title: "x" }, api)).isError).toBe(true);
    expect((await callTool("edit_event", { id: "ev-1" }, api)).isError).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("list_events refuses days that aren't days, backwards ranges and more than a year", async () => {
    const { calls, api } = recorder();
    for (const args of [{ from: "today", to: "2026-11-01" }, { from: "2026-11-02", to: "2026-11-01" }, { from: "2026-01-01", to: "2027-06-01" }]) {
      expect((await callTool("list_events", args, api)).isError, JSON.stringify(args)).toBe(true);
    }
    expect(calls).toEqual([]);
  });
});

describe("get_money is read-only and leaves out what only the screens need", () => {
  it("one GET; no ledger tables, files or per-row activity", async () => {
    const finance = {
      notes: { income: "n-i" },
      income: { totals: { EUR: 3000 }, items: [{ service: "Salary" }], count: 1, activity: [{ x: 1 }], unreadable: [] },
      subscriptions: { totals: { EUR: 12 }, items: [{ service: "Spotify" }], count: 1, activity: [{ x: 1 }], unreadable: [{ line: 7 }] },
      payslips: [],
      savings: null,
      recurring: [],
      summary: { balance: 100 },
      spending: { months: [], dataThrough: null, categories: { typical: 0, lastComplete: null, completeMonths: 0, months: [{ big: true }], forecast: [{ category: "Food", merchants: ["AH"] }], rules: [] }, txnCount: 0, skipped: 0, excluded: [] },
      files: [{ name: "statement.csv" }],
      ledgerConflicts: [],
      tables: { subscriptions: { version: "v" } },
    };
    const { calls, api } = recorder(() => finance);
    const text = (await callTool("get_money", {}, api)).content[0]!.text;
    expect(calls).toEqual([{ path: "/api/finance", method: "GET" }]);
    const m = JSON.parse(text);
    expect(m.subscriptions).toEqual({ totals: { EUR: 12 }, count: 1, items: [{ service: "Spotify" }], unreadable: [{ line: 7 }] });
    expect(m.income).toEqual({ totals: { EUR: 3000 }, count: 1, items: [{ service: "Salary" }] });
    expect(m.spending.categories.byCategory).toEqual([{ category: "Food" }]);
    for (const gone of ["tables", "files", "activity", "merchants", "statement.csv", "\"big\""]) expect(text).not.toContain(gone);
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

describe("no tool reaches what a token is refused", () => {
  it("no tool names a route for tokens, sessions, sign-in, webhooks, the mail account, sending mail or settings", async () => {
    const file = await import("node:fs").then((fs) => fs.readFileSync(new URL("../src/tools.ts", import.meta.url), "utf8"));
    // The routes the code calls, comments aside (one says why /api/mail/send is not one).
    const src = file.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(src).toContain("/api/mail/drafts");
    for (const route of ["/api/tokens", "/api/auth", "/api/webhooks", "/api/mail/account", "/api/mail/send", "/api/settings", "/api/admin", "/api/me/ics-token", "/api/vault/trash/empty"]) {
      expect(src, route).not.toContain(route);
    }
  });
});
