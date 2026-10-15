/**
 * Task edits name the task, never just a line (audit COR-001, COR-009,
 * WEB-004). Every surface that ticks, re-dates, promotes, schedules or books a
 * task sends its block id or its text; the line it saw is a hint. The note can
 * move between the snapshot and the click (an Obsidian edit, a decision
 * appended above), and the edit must then find the task or answer 409, never
 * change the task that slid into its place.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.ORRAMA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-task-identity-"));
process.env.ORRAMA_VAULT_DIR = path.join(process.env.ORRAMA_DATA_DIR, "vault");
process.env.ORRAMA_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.ORRAMA_SECRET_KEY = "test-secret-key-0123456789abcdef";

await import("../src/seed.js");
const { buildServer } = await import("../src/main.js");

type Built = Awaited<ReturnType<typeof buildServer>>;
let built: Built;
let token = "";

const api = async (method: string, url: string, body?: unknown) => {
  const res = await built.app.inject({
    method: method as "GET",
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
  });
  return { status: res.statusCode, json: (() => { try { return res.json(); } catch { return null; } })() };
};
/** Write a note through the API (standing in for Obsidian or the editor) and return its id. */
const put = async (rel: string, content: string) => {
  const r = await api("PUT", "/api/vault/note", { path: rel, content });
  expect(r.status).toBe(200);
  return r.json.id as string;
};
const body = (id: string) => built.store.index.get(id)!.content.replace(/^---\n[\s\S]*?\n---\n/, "");
const taskOf = (id: string, text: string) => built.store.index.get(id)!.tasks.find((t) => t.text === text)!;

beforeAll(async () => {
  built = await buildServer();
  token = (await built.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "jules@orrama.dev", password: "orrama-demo" } })).json().token;
});
afterAll(async () => {
  await built.app.close();
});

describe("a stale snapshot never edits the wrong task (COR-001)", () => {
  it("a tick sent with a stale line finds its task where it is now", async () => {
    const id = await put("Notes/list.md", "- [ ] first task\n- [ ] second task\n- [ ] third task\n");
    const seen = taskOf(id, "third task"); // the Dashboard's snapshot
    await put("Notes/list.md", "- [ ] new urgent task\n- [ ] first task\n- [ ] second task\n- [ ] third task\n");
    const r = await api("POST", "/api/tasks/check", { noteId: id, line: seen.line, text: seen.text, checked: true });
    expect(r.status).toBe(200);
    expect(body(id)).toBe("- [ ] new urgent task\n- [ ] first task\n- [ ] second task\n- [x] third task\n");
  });

  it("a line that now holds another task, and no task with the text, is a 409 and nothing changes", async () => {
    const id = await put("Notes/gone.md", "- [ ] Pay rent\n- [ ] Call bank\n");
    const seen = taskOf(id, "Call bank");
    await put("Notes/gone.md", "- [ ] Book dentist\n- [ ] Pay rent\n");
    const before = body(id);
    const r = await api("POST", "/api/tasks/check", { noteId: id, line: seen.line, text: seen.raw, checked: true });
    expect(r.status).toBe(409);
    expect(body(id)).toBe(before);
  });

  it("a line alone is refused before anything is read", async () => {
    const id = await put("Notes/bare.md", "- [ ] one\n- [ ] two\n");
    for (const [url, extra] of [
      ["/api/tasks/check", { checked: true }],
      ["/api/tasks/status", { status: "blocked" }],
      ["/api/tasks/dates", { due: "2026-11-01" }],
      ["/api/tasks/promote", {}],
      ["/api/tasks/schedule", { date: "2026-11-01" }],
      ["/api/tasks/blocks", { date: "2026-11-01", startMin: 600 }],
    ] as const) {
      const r = await api("POST", url, { noteId: id, line: 1, ...extra });
      expect(r.status, url).toBe(400);
    }
    expect(body(id)).toBe("- [ ] one\n- [ ] two\n");
  });

  it("a block id that is gone is a 409 — the line it came with is not tried", async () => {
    const id = await put("Notes/blocked.md", "- [ ] first task\n- [ ] second task\n- [ ] third task\n");
    const second = taskOf(id, "second task");
    const promoted = await api("POST", "/api/tasks/promote", { noteId: id, line: second.line, text: second.raw });
    expect(promoted.status).toBe(200);
    await put("Notes/blocked.md", "- [ ] first task\n- [ ] third task\n");
    const r = await api("POST", "/api/tasks/status", { noteId: id, line: second.line, blockId: promoted.json.blockId, status: "blocked" });
    expect(r.status).toBe(409);
    expect(body(id)).toBe("- [ ] first task\n- [ ] third task\n");
  });

  it("re-dating, scheduling and booking find the moved task too", async () => {
    const id = await put("Notes/plan.md", "- [ ] write intro\n- [ ] write outro\n");
    const seen = taskOf(id, "write outro");
    await put("Notes/plan.md", "- [ ] read paper\n- [ ] write intro\n- [ ] write outro\n");
    expect((await api("POST", "/api/tasks/dates", { noteId: id, line: seen.line, text: seen.text, due: "2026-11-02" })).status).toBe(200);
    expect(body(id)).toContain("- [ ] write outro due:2026-11-02\n");
    expect(body(id)).toContain("- [ ] write intro\n");
    const sched = await api("POST", "/api/tasks/schedule", { noteId: id, line: seen.line, text: seen.text, date: "2026-11-01" });
    expect(sched.status).toBe(200);
    expect(taskOf(id, "write outro").blockId).toBe(sched.json.blockId);
    const intro = taskOf(id, "write intro");
    const blk = await api("POST", "/api/tasks/blocks", { noteId: id, line: intro.line + 1, text: intro.text, date: "2026-11-03", startMin: 600 });
    expect(blk.status).toBe(200);
    expect(taskOf(id, "write intro").blockId).toBeTruthy();
    expect(taskOf(id, "read paper").blockId).toBeUndefined();
  });
});

describe("a promoted line copied with its block id (COR-009)", () => {
  it("the copy is its own task: ticking it ticks it, and promoting it gives it its own id", async () => {
    const id = await put("Notes/dup.md", "- [ ] alpha ^t-aaaaaa\n- [ ] beta ^t-aaaaaa\n");
    const tasks = built.store.index.get(id)!.tasks;
    expect(tasks.map((t) => [t.text, t.blockId])).toEqual([["alpha", "t-aaaaaa"], ["beta", undefined]]);

    const beta = taskOf(id, "beta");
    expect((await api("POST", "/api/tasks/check", { noteId: id, line: beta.line, text: beta.raw, checked: true })).status).toBe(200);
    expect(body(id)).toBe("- [ ] alpha ^t-aaaaaa\n- [x] beta ^t-aaaaaa\n");

    // An edit naming the id at the copy's line is refused, not applied to alpha.
    const r = await api("POST", "/api/tasks/check", { noteId: id, line: beta.line, blockId: "t-aaaaaa", text: beta.raw, checked: false });
    expect(r.status).toBe(409);
    expect(body(id)).toBe("- [ ] alpha ^t-aaaaaa\n- [x] beta ^t-aaaaaa\n");

    const p = await api("POST", "/api/tasks/promote", { noteId: id, line: beta.line, text: beta.raw });
    expect(p.status).toBe(200);
    expect(p.json.blockId).not.toBe("t-aaaaaa");
    expect(body(id)).toBe(`- [ ] alpha ^t-aaaaaa\n- [x] beta ^${p.json.blockId}\n`);
    // Two task objects now, one per line, each mirroring its own checkbox.
    expect(built.store.taskObjectByBlock(id, "t-aaaaaa")?.status ?? "todo").toBe("todo");
    expect(built.store.taskObjectByBlock(id, p.json.blockId)?.status).toBe("done");
  });
});
