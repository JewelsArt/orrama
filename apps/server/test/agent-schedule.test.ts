/**
 * "Put it on Wednesday" puts it on the calendar, from either agent (audit AI-005).
 *
 * MCP schedule_block posted to /api/tasks/schedule, which only set the
 * DB-only planned_date: no calendar note row, no time block, nothing in
 * Planning, the Dashboard or the Timeline, while Claude said it was done.
 * Now both agents book through the route Planning uses (bookTaskBlock).
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { bootAi } from "./helpers/aiServer.js";
import { ask, toolOutputs } from "./helpers/fakeChat.js";
import { mcpClient } from "./helpers/mcp.js";

const s = await bootAi("agent-schedule");
afterAll(() => s.close());

const { tables } = await import("../src/db.js");
const jules = s.aclUser("jules");
const note = s.built.store.write(jules, "Shared/Chapters.md", "# Chapters\n\n- [ ] Draft chapter 3\n- [ ] Draft chapter 4\n");
const calendarNote = (month: string) => {
  // erin and mara read 01-Me through the seed's root viewer grants, so jules's calendar is his by path (ACL-009).
  const abs = path.join(s.vault, "Personal", "jules", "Calendar", `${month}.md`);
  return fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "";
};
const planBlocks = async (text: string) => {
  const plan = (await s.call("jules", "GET", "/api/plan")).json;
  const task = plan.assignees.flatMap((a: any) => a.tasks).find((t: any) => t.text === text);
  return task?.blocks ?? [];
};

describe("schedule_block", () => {
  it("over MCP: a row in the calendar note, a task_blocks row, and the block in the plan", async () => {
    const mcp = await mcpClient(s.built.app, s.tokens.jules!);
    const r = await mcp.tool("schedule_block", { noteId: note.id, text: "Draft chapter 3", date: "2026-10-14" });
    expect(r.isError).toBeUndefined();
    expect(r.json).toMatchObject({ date: "2026-10-14", startMin: 540, durationMin: 120 });
    expect(calendarNote("2026-10")).toMatch(/\| 2026-10-14 \| 09:00 \| 11:00 \| Draft chapter 3 \| \[\[Shared\/Chapters#\^t-[a-z0-9]+\]\] \|/);
    expect(s.built.db.select().from(tables.taskBlocks).all().filter((b) => b.date === "2026-10-14")).toHaveLength(1);
    expect(await planBlocks("Draft chapter 3")).toEqual([expect.objectContaining({ date: "2026-10-14", startMin: 540, durationMin: 120 })]);
  });

  it("over MCP, a start time and length are kept", async () => {
    const mcp = await mcpClient(s.built.app, s.tokens.jules!);
    const r = await mcp.tool("schedule_block", { noteId: note.id, text: "Draft chapter 4", date: "2026-11-02", startMin: 14 * 60, durationMin: 60 });
    expect(r.json).toMatchObject({ date: "2026-11-02", startMin: 840, durationMin: 60 });
    expect(calendarNote("2026-11")).toContain("| 2026-11-02 | 14:00 | 15:00 | Draft chapter 4 |");
  });

  it("in the app: the same booking, through the same helper", async () => {
    s.queue.push({ tool: "schedule_block", args: { noteId: note.id, text: "Draft chapter 3", date: "2026-10-15", startMin: 600 } }, { text: "Booked." });
    const r = await s.call("jules", "POST", "/api/ai/ask", ask("book chapter 3 on Thursday at 10"));
    const [out] = toolOutputs(r.body);
    expect(out.success).toBe(true);
    expect(out.block).toMatchObject({ date: "2026-10-15", startMin: 600, durationMin: 120 });
    expect(calendarNote("2026-10")).toContain("| 2026-10-15 | 10:00 | 12:00 | Draft chapter 3 |");
    expect((await planBlocks("Draft chapter 3")).map((b: any) => b.date).sort()).toEqual(["2026-10-14", "2026-10-15"]);
  });

  it("a task that is not in the note is refused, and nothing is booked", async () => {
    const before = s.built.db.select().from(tables.taskBlocks).all().length;
    s.queue.push({ tool: "schedule_block", args: { noteId: note.id, text: "No such task", date: "2026-10-16" } }, { text: "Sorry." });
    const r = await s.call("jules", "POST", "/api/ai/ask", ask("book a task that does not exist"));
    expect(toolOutputs(r.body)[0].success).toBe(false);
    expect(s.built.db.select().from(tables.taskBlocks).all().length).toBe(before);
  });
});
