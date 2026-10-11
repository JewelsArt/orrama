/**
 * Notes home's pins and counts (GET /api/notes/overview, R7). A pin is the note's own front
 * matter, `pinned: true`; like every surface, the answer is the reader's readable vault only —
 * a note you can't read is not pinned for you, and is not counted.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.BASALT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "basalt-notes-overview-"));
process.env.BASALT_VAULT_DIR = path.join(process.env.BASALT_DATA_DIR, "vault");
process.env.BASALT_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.BASALT_SECRET_KEY = "test-secret-key-0123456789abcdef";

const { buildServer } = await import("../src/main.js");
let app: Awaited<ReturnType<typeof buildServer>>["app"];
const tokens: Record<string, string> = {};

const as = async (who: string, method: string, url: string, body?: unknown) => {
  const res = await app.inject({ method: method as "GET", url, headers: { authorization: `Bearer ${tokens[who]}` }, ...(body ? { payload: body as object } : {}) });
  expect(res.statusCode).toBe(200);
  return res.json();
};

beforeAll(async () => {
  await import("../src/seed.js");
  app = (await buildServer()).app;
  for (const who of ["jules", "erin"]) {
    const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: `${who}@basalt.dev`, password: "basalt-demo" } });
    tokens[who] = r.json().token;
  }
});
afterAll(async () => {
  await app.close();
  fs.rmSync(process.env.BASALT_DATA_DIR!, { recursive: true, force: true });
});

describe("GET /api/notes/overview", () => {
  it("lists the notes pinned in their front matter, by title, and only the ones you can read", async () => {
    const pin = (p: string, title: string, pinned: string) =>
      as("jules", "PUT", "/api/vault/note", { path: p, content: `---\ntitle: ${title}\npinned: ${pinned}\n---\n# ${title}\n`, create: true });
    const zed = await pin("Shared/Zed plan.md", "Zed plan", "true");
    const alpha = await pin("Shared/Alpha plan.md", "Alpha plan", "yes");
    await pin("Shared/Not pinned.md", "Not pinned", "false");
    const mine = await pin("Personal/jules/Private.md", "Private", "true");

    const jules = await as("jules", "GET", "/api/notes/overview");
    expect(jules.pinned).toEqual([alpha.id, mine.id, zed.id]);

    const erin = await as("erin", "GET", "/api/notes/overview");
    expect(erin.pinned).not.toContain(mine.id); // Personal/jules is jules's alone
    expect(erin.notes).toBeLessThan(jules.notes);
  });

  it("counts conversations apart from notes written, and open and done tasks", async () => {
    const before = await as("jules", "GET", "/api/notes/overview");
    await as("jules", "PUT", "/api/vault/note", { path: "Shared/Chat about plans.md", content: "---\ntype: claude-session\n---\n- [ ] not a task, a transcript\n", create: true });
    await as("jules", "PUT", "/api/vault/note", { path: "Shared/Todo.md", content: "# Todo\n- [ ] one\n- [x] two\n- [x] three\n", create: true });
    const after = await as("jules", "GET", "/api/notes/overview");
    expect(after.conversations).toBe(before.conversations + 1);
    expect(after.notes).toBe(before.notes + 1);
    expect(after.openTasks).toBe(before.openTasks + 1);
    expect(after.doneTasks).toBe(before.doneTasks + 2);
  });
});
