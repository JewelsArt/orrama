/**
 * Every MCP tool against a real server (audit OPS-008). apps/mcp's
 * requests.test.ts pins the request each tool sends; this checks the server
 * answers that request the way the tool's description promises — the box is
 * ticked in the file, the event is in the calendar note, the draft waits. The
 * tools with tests of their own elsewhere: edit_note, append_to_note and
 * read_note (agent-notes), schedule_block (agent-schedule), get_project and
 * log_decision (agent-instructions).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { bootAi } from "./helpers/aiServer.js";
import { mcpClient } from "./helpers/mcp.js";

const s = await bootAi("mcp-tools");
afterAll(() => s.close());

const { tables } = await import("../src/db.js");
const { encryptSecret } = await import("../src/secrets.js");
const jules = s.aclUser("jules");
const errands = s.built.store.write(jules, "Shared/Errands.md", "# Errands\n\n- [ ] buy seeds\n- [ ] fix the gate\n- [ ] call the plumber\n- [ ] order compost\n");
const mcp = await mcpClient(s.built.app, s.tokens.jules!);
const file = (rel: string) => fs.readFileSync(path.join(s.vault, rel), "utf8");

describe("reading", () => {
  it("search_notes finds a note by its words", async () => {
    const r = await mcp.tool("search_notes", { query: "plumber" });
    expect(r.json.map((n: { path: string }) => n.path)).toEqual(["Shared/Errands.md"]); // the only note that says it
  });

  it("list_tree lists the readable notes", async () => {
    const r = await mcp.tool("list_tree");
    expect(r.json).toEqual(expect.arrayContaining([expect.objectContaining({ id: errands.id, path: "Shared/Errands.md" })]));
  });

  it("list_projects and get_dashboard answer for the seed's team", async () => {
    expect(Array.isArray((await mcp.tool("list_projects")).json)).toBe(true);
    const dash = await mcp.tool("get_dashboard", { teamSlug: "engineering" });
    expect(dash.isError).toBeUndefined();
    expect(dash.json).toBeTypeOf("object");
  });

  it("get_dashboard for a team the token's owner is not in is an error, not an empty board", async () => {
    await expect(mcp.tool("get_dashboard", { teamSlug: "no-such-team" })).rejects.toThrow(/Orrama API error \(40[34]\)/);
  });

  it("get_contacts lists the workspace's people", async () => {
    const r = await mcp.tool("get_contacts");
    expect(JSON.stringify(r.json)).toContain("erin");
  });

  it("the five graph tools answer from /api/graph, even with no ontology note", async () => {
    for (const [name, args] of [
      ["vault_schema", {}],
      ["find_entities", { type: "note", limit: 3 }],
      ["get_relations", { entity: "Shared/Errands.md" }],
      ["find_path", { from: "Shared/Errands.md", to: "Welcome" }],
      ["list_summaries", { limit: 3 }],
    ] as const) {
      const r = await mcp.tool(name, args);
      expect(r.isError, name).toBeUndefined();
      expect(r.json, name).toBeTypeOf("object");
    }
  });
});

describe("tasks", () => {
  it("check_task ticks the box in the file, and unticks it", async () => {
    await mcp.tool("check_task", { noteId: errands.id, text: "buy seeds", checked: true });
    expect(file("Shared/Errands.md")).toContain("- [x] buy seeds\n");
    await mcp.tool("check_task", { noteId: errands.id, text: "buy seeds", checked: false });
    expect(file("Shared/Errands.md")).toContain("- [ ] buy seeds\n");
  });

  it("set_task_status writes the checkbox's state", async () => {
    await mcp.tool("set_task_status", { noteId: errands.id, text: "fix the gate", status: "in-progress" });
    expect(file("Shared/Errands.md")).toContain("- [/] fix the gate");
    await mcp.tool("set_task_status", { noteId: errands.id, text: "fix the gate", status: "blocked" });
    expect(file("Shared/Errands.md")).toContain("- [b] fix the gate");
  });

  it("set_task_dates writes start and due into the line", async () => {
    await mcp.tool("set_task_dates", { noteId: errands.id, text: "call the plumber", start: "2026-10-20", due: "2026-10-23" });
    const line = file("Shared/Errands.md").split("\n").find((l) => l.includes("call the plumber"))!;
    expect(line).toContain("start:2026-10-20");
    expect(line).toContain("due:2026-10-23");
  });

  it("a task named by text that matches nothing is refused, and the note is unchanged", async () => {
    const before = file("Shared/Errands.md");
    await expect(mcp.tool("check_task", { noteId: errands.id, text: "paint the shed", checked: true })).rejects.toThrow(/Orrama API error \(409\)/);
    expect(file("Shared/Errands.md")).toBe(before);
  });
});

describe("projects and the calendar", () => {
  it("create_project writes the project note and the project is listed", async () => {
    const r = await mcp.tool("create_project", { name: "Kitchen Garden", domain: "personal" });
    expect(r.json).toMatchObject({ ok: true, slug: "kitchen-garden", path: "04-Projects/kitchen-garden.md" });
    expect(file("04-Projects/kitchen-garden.md")).toContain("project/kitchen-garden");
    const listed = (await mcp.tool("list_projects")).json as { key?: string; slug?: string }[];
    expect(JSON.stringify(listed)).toContain("kitchen-garden");
  });

  it("create_event puts a row in the owner's calendar note", async () => {
    const r = await mcp.tool("create_event", { title: "Seed swap", date: "2026-11-07", startMin: 600, durationMin: 90 });
    expect(r.json).toMatchObject({ title: "Seed swap", date: "2026-11-07", startMin: 600, durationMin: 90 });
    expect(file("Personal/jules/Calendar/2026-11.md")).toContain("| 2026-11-07 | 10:00 | 11:30 | Seed swap |");
  });
});

describe("mail", () => {
  it("without a connected account, list_email and read_email say so", async () => {
    await expect(mcp.tool("list_email", { limit: 5 })).rejects.toThrow(/no mail account connected/);
    await expect(mcp.tool("read_email", { uid: 1 })).rejects.toThrow(/no mail account connected/);
  });

  it("draft_email stages a draft that waits for the user; nothing is sent", async () => {
    const users = s.built.db.select().from(tables.users).all();
    s.built.db
      .insert(tables.mailAccounts)
      .values({
        id: `mail-${crypto.randomUUID().slice(0, 8)}`,
        userId: users.find((u) => u.username === "jules")!.id,
        email: "jules.personal@example.com",
        imapHost: "imap.example.com",
        imapPort: 993,
        smtpHost: "smtp.example.com",
        smtpPort: 465,
        passwordEncrypted: encryptSecret("app-password"),
        createdAt: Date.now(),
        lastCheckedAt: null,
        lastError: null,
      })
      .run();
    const r = await mcp.tool("draft_email", { to: "mara@example.com", subject: "Seeds", body: "Thursday works." });
    expect(r.json).toMatchObject({ status: "awaiting_confirmation", to: "mara@example.com", subject: "Seeds" });
    const drafts = (await s.call("jules", "GET", "/api/mail/drafts")).json as { id: string; subject: string }[];
    expect(drafts.map((d) => d.subject)).toContain("Seeds");
    // The token cannot send it, even knowing everything about it.
    const send = await s.call(mcp.token, "POST", "/api/mail/send", { to: "mara@example.com", subject: "Seeds", body: "Thursday works." });
    expect(send.status).toBe(403);
  });
});
