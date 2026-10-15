/**
 * The Dashboard's "Booked" hours and its agenda count the blocks in your own
 * calendar, whoever the task is assigned to (audit COR-003). They used to
 * select blocks through `task_objects.assigneeId = me`, which is set only for
 * a line carrying an `@username` that matches an account — so a block on any
 * task without an @mention, even one "Plan my week" booked, was 0 h and absent
 * from the agenda, while a block someone else booked on a task mentioning you
 * showed up as yours. A block is a row of its booker's calendar note.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { isoLocal } from "@orrama/core";

process.env.ORRAMA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-home-booked-"));
process.env.ORRAMA_VAULT_DIR = path.join(process.env.ORRAMA_DATA_DIR, "vault");
process.env.ORRAMA_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.ORRAMA_SECRET_KEY = "test-secret-key-0123456789abcdef";

const VAULT = process.env.ORRAMA_VAULT_DIR;
fs.mkdirSync(path.join(VAULT, "Shared"), { recursive: true });
fs.writeFileSync(path.join(VAULT, "Shared/Work.md"), "# Work\n\n- [ ] alpha unassigned step\n- [ ] beta step @erin\n- [ ] gamma step @erin\n");
await import("../src/seed.js");
const { buildServer } = await import("../src/main.js");

let b: Awaited<ReturnType<typeof buildServer>>;
const tokens: Record<string, string> = {};
const call = async (who: string, method: "GET" | "POST", url: string, payload?: Record<string, unknown>) => {
  const res = await b.app.inject({ method, url, headers: { authorization: `Bearer ${tokens[who]}` }, ...(payload ? { payload } : {}) });
  return { status: res.statusCode, body: res.json() };
};
type Home = { stats: { weekHours: number }; agenda: { kind: string; title: string; date: string; startMin: number | null }[] };
const home = async (who: string) => (await call(who, "GET", "/api/home")).body as Home;
const taskRows = (h: Home) => h.agenda.filter((r) => r.kind === "task").map((r) => r.title).sort();
const today = isoLocal(new Date());

beforeAll(async () => {
  b = await buildServer();
  for (const who of ["jules", "erin"]) {
    tokens[who] = (await b.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: `${who}@orrama.dev`, password: "orrama-demo" } })).json().token;
  }
  const work = b.store.index.getByPath("Shared/Work.md")!.id;
  const book = async (who: string, text: string, startMin: number) => {
    const r = await call(who, "POST", "/api/tasks/blocks", { noteId: work, text, date: today, startMin, durationMin: 120 });
    expect(r.status, `${who} books ${text}`).toBe(200);
  };
  await book("jules", "alpha unassigned step", 20 * 60); // no @mention: jules's own block
  await book("jules", "beta step @erin", 16 * 60); // mentions erin, booked by jules: his block
  await book("erin", "gamma step @erin", 9 * 60); // erin's own block, in erin's calendar
});
afterAll(async () => {
  await b.app.close();
  fs.rmSync(process.env.ORRAMA_DATA_DIR!, { recursive: true, force: true });
});

it("a block on a task with no @mention counts as booked and is on the agenda", async () => {
  const h = await home("jules");
  expect(taskRows(h)).toEqual(["alpha unassigned step", "beta step"]);
  expect(h.stats.weekHours).toBe(4);
});

it("a block in another user's calendar note is not yours, whoever the task names", async () => {
  const h = await home("erin");
  expect(taskRows(h)).toEqual(["gamma step"]);
  expect(h.stats.weekHours).toBe(2);
});

it("a block on a task whose note you can no longer read is not shown", async () => {
  const work = b.store.index.getByPath("Shared/Work.md")!;
  const put = await b.app.inject({
    method: "PUT",
    url: "/api/vault/note",
    headers: { authorization: `Bearer ${tokens["jules"]}` },
    payload: { path: work.path, content: `${work.content}\n#only/marketing\n` },
  });
  expect(put.statusCode).toBe(200);
  const h = await home("erin");
  expect(taskRows(h)).toEqual([]);
  expect(h.stats.weekHours).toBe(0);
});
