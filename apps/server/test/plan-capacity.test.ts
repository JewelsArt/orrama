/**
 * One person is one queue of work (audit COR-011). buildPlan laid tasks
 * end-to-end per `@name`, so the viewer's `@jules` tasks and their unmentioned
 * ones (both theirs: PlannedTask.forYou) were scheduled as two workers each
 * starting now — expectedFinish and atRisk too optimistic, and adding or
 * removing two characters flipped a task's verdict for the same workload.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";

process.env.ORRAMA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-plan-capacity-"));
process.env.ORRAMA_VAULT_DIR = path.join(process.env.ORRAMA_DATA_DIR, "vault");
process.env.ORRAMA_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.ORRAMA_SECRET_KEY = "test-secret-key-0123456789abcdef";

await import("../src/seed.js");
const { buildServer } = await import("../src/main.js");

let b: Awaited<ReturnType<typeof buildServer>>;
let token = "";
const call = async (method: "GET" | "PUT", url: string, payload?: Record<string, unknown>) =>
  (await b.app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) })).json();

/**
 * Due before anything the seeded demo vault holds (its tasks are due in 2026,
 * mentioned and not), so these are first in whichever queue they join.
 */
const due = (day: number) => `2020-01-0${day}`;
/** Sixteen words and !p1: a 6 h heuristic estimate each. */
const long = (name: string) => `${name} carefully draft review and rewrite every part of the long methods section today`;
const note = (mention: string) =>
  `# Crunch\n\n- [ ] ${long("ALPHA")} !p1 due:${due(3)}\n- [ ] ${long("BETA")} !p1 due:${due(3)}\n- [ ] ${long("GAMMA")} !p1 due:${due(3)}\n- [ ] ${long("DELTA")} ${mention}!p1 due:${due(5)}\n`;

type Planned = { text: string; assignee: string | null; forYou: boolean; expectedFinish: string; atRisk: boolean; estimateHours: number };
const planned = async (mention: string) => {
  await call("PUT", "/api/vault/note", { path: "Shared/Crunch.md", content: note(mention) });
  const plan = (await call("GET", "/api/plan")) as { assignees: { tasks: Planned[] }[] };
  return plan.assignees
    .flatMap((a) => a.tasks)
    .filter((t) => /^(ALPHA|BETA|GAMMA|DELTA) /.test(t.text))
    .map((t) => ({ name: t.text.split(" ")[0], expectedFinish: t.expectedFinish, atRisk: t.atRisk, forYou: t.forYou, est: t.estimateHours }))
    .sort((x, y) => x.name!.localeCompare(y.name!));
};

beforeAll(async () => {
  b = await buildServer();
  token = (await b.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "jules@orrama.dev", password: "orrama-demo" } })).json().token;
});
afterAll(async () => {
  await b.app.close();
  fs.rmSync(process.env.ORRAMA_DATA_DIR!, { recursive: true, force: true });
});

it("adding or removing @<own username> changes no task's expectedFinish or atRisk", async () => {
  const without = await planned("");
  const withMention = await planned("@jules ");
  expect(without.map((t) => t.est)).toEqual([6, 6, 6, 6]);
  expect(withMention.every((t) => t.forYou)).toBe(true);
  expect(withMention).toEqual(without);
});

it("the mentioned task queues behind the unmentioned ones, like any of the viewer's work", async () => {
  const tasks = await planned("@jules ");
  const delta = tasks.find((t) => t.name === "DELTA")!;
  const others = tasks.filter((t) => t.name !== "DELTA");
  // 24 h of work at 6 h a day, one person: DELTA, due last, finishes after all three others.
  for (const o of others) expect(delta.expectedFinish >= o.expectedFinish).toBe(true);
  expect(delta.expectedFinish > others[0]!.expectedFinish).toBe(true);
});

it("another account's tasks still form their own queue", async () => {
  await call("PUT", "/api/vault/note", {
    path: "Shared/Crunch.md",
    content: `# Crunch\n\n- [ ] ${long("ALPHA")} !p1 due:${due(3)}\n- [ ] ${long("BETA")} @erin !p1 due:${due(3)}\n`,
  });
  const plan = (await call("GET", "/api/plan")) as { assignees: { tasks: Planned[] }[] };
  const tasks = plan.assignees.flatMap((a) => a.tasks);
  const alpha = tasks.find((t) => t.text.startsWith("ALPHA "))!;
  const beta = tasks.find((t) => t.text.startsWith("BETA "))!;
  expect(beta.forYou).toBe(false);
  expect(beta.expectedFinish).toBe(alpha.expectedFinish); // two people, working in parallel
});
