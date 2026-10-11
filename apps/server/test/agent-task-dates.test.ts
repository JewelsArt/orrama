/**
 * The agent's set_task_dates is the route's, validation included (audit AI-011).
 *
 * POST /api/tasks/dates takes YYYY-MM-DD only; the agent's own copy of it
 * wrote any string. "next friday" became part of the task's title and the
 * task lost its due date; a value with a newline split the line and moved
 * the task's ^t- block id (its blocks and comments hang on it) onto the
 * injected line.
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { bootAi } from "./helpers/aiServer.js";
import { ask, toolOutputs } from "./helpers/fakeChat.js";

const s = await bootAi("agent-task-dates");
afterAll(() => s.close());
const jules = s.aclUser("jules");
const note = s.built.store.write(jules, "Shared/Spike.md", "# Spike\n\n- [/] partial checkout spike !p1 ^t-22y7ne\n- [ ] wire the payment form\n");
const onDisk = () => fs.readFileSync(path.join(s.vault, "Shared/Spike.md"), "utf8");

const agentSets = async (args: object) => {
  s.queue.push({ tool: "set_task_dates", args: { noteId: note.id, ...args } }, { text: "Done." });
  const r = await s.call("jules", "POST", "/api/ai/ask", ask("change the dates"));
  return toolOutputs(r.body)[0];
};

describe("set_task_dates", () => {
  it("refuses a date that is not YYYY-MM-DD and leaves the note as it was", async () => {
    const before = onDisk();
    const out = await agentSets({ blockId: "t-22y7ne", due: "next friday" });
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/due/);
    expect(onDisk()).toBe(before);
    // The route refuses the same value.
    expect((await s.call("jules", "POST", "/api/tasks/dates", { noteId: note.id, blockId: "t-22y7ne", due: "next friday" })).status).toBe(400);
  });

  it("refuses a value with a newline: the block id stays on its task", async () => {
    const before = onDisk();
    const out = await agentSets({ blockId: "t-22y7ne", due: "2026-10-20\n- [ ] injected" });
    expect(out.success).toBe(false);
    expect(onDisk()).toBe(before);
    expect(onDisk()).toContain("- [/] partial checkout spike !p1 ^t-22y7ne\n");
  });

  it("writes a real date, as the route does, and keeps the task object's due in step", async () => {
    // Promoted tasks carry a task object; its due follows the line.
    s.built.store.ensureTaskObject(note.id, "t-22y7ne");
    const out = await agentSets({ blockId: "t-22y7ne", due: "2026-10-20" });
    expect(out.success).toBe(true);
    expect(onDisk()).toContain("- [/] partial checkout spike !p1 due:2026-10-20 ^t-22y7ne\n");
    const parsed = s.built.store.index.get(note.id)!.tasks.find((t) => t.blockId === "t-22y7ne")!;
    expect(parsed.due).toBe("2026-10-20");
    expect(parsed.text).toBe("partial checkout spike");
    expect(s.built.store.taskObjectByBlock(note.id, "t-22y7ne")?.due).toBe("2026-10-20");
  });

  it("names a task by its text too, and clears a date with null", async () => {
    expect((await agentSets({ text: "wire the payment form", start: "2026-10-13" })).success).toBe(true);
    expect(onDisk()).toContain("- [ ] wire the payment form start:2026-10-13\n");
    expect((await agentSets({ text: "wire the payment form", start: null })).success).toBe(true);
    expect(onDisk()).toContain("- [ ] wire the payment form\n");
  });
});
