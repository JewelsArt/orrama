/**
 * Which tasks "Plan my week" and the Planning backlog consider yours.
 *
 * The whole-vault plan kept only tasks that belonged to a project AND were
 * @-assigned to you by name, so 61 of Jules's 173 open tasks were invisible to
 * it: 53 in notes outside any project (his deadlines note alone held 26), 8
 * unassigned inside projects. Now a task is yours when it is assigned to you,
 * or assigned to nobody in a note you can edit; the whole-vault plan takes
 * every open task, and a team plan still keeps to that team's projects.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isoLocal } from "@basalt/core";

process.env.BASALT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "basalt-plan-scope-"));
process.env.BASALT_VAULT_DIR = path.join(process.env.BASALT_DATA_DIR, "vault");
process.env.BASALT_JWT_SECRET = "test-secret";
process.env.BASALT_SECRET_KEY = "test-secret-key-0123456789abcdef";

const { buildServer } = await import("../src/main.js");
let app: Awaited<ReturnType<typeof buildServer>>["app"];
const tokens: Record<string, string> = {};

const call = async (who: string, method: string, url: string, body?: unknown) =>
  (
    await app.inject({
      method: method as "GET",
      url,
      headers: { authorization: `Bearer ${tokens[who]}` },
      ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
    })
  ).json();

type Task = { text: string; forYou: boolean; project: string | null };
const tasksOf = (plan: { assignees: { tasks: Task[] }[] }) => plan.assignees.flatMap((a) => a.tasks);
const find = (plan: { assignees: { tasks: Task[] }[] }, text: string) => tasksOf(plan).find((t) => t.text.includes(text));

beforeAll(async () => {
  await import("../src/seed.js");
  app = (await buildServer()).app;
  for (const who of ["jules", "erin"]) {
    const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: `${who}@basalt.dev`, password: "basalt-demo" } });
    tokens[who] = r.json().token;
  }
  const put = (p: string, content: string) => call("jules", "PUT", "/api/vault/note", { path: p, content });
  // Outside any project, in a folder Engineering edits.
  await put("Engineering/Deadlines.md", "# Deadlines\n\n- [ ] renew passport NOPROJECT-TASK\n");
  // Inside the Atlas project: one for nobody, one for erin.
  await put("Engineering/Atlas Extra.md", "---\ntags: [project/atlas]\n---\n# Extra\n\n- [ ] tidy the backlog UNASSIGNED-IN-PROJECT\n- [ ] review the RFC @erin ERINS-TASK\n");
  // At the vault root, which Engineering may read but not edit.
  await put("Reading List.md", "# Reading list\n\n- [ ] read the paper READONLY-TASK\n");
});

afterAll(async () => {
  await app.close();
  fs.rmSync(process.env.BASALT_DATA_DIR!, { recursive: true, force: true });
});

describe("GET /api/plan (the whole vault)", () => {
  it("includes open tasks outside any project, and marks unassigned ones yours", async () => {
    const plan = await call("jules", "GET", "/api/plan");
    expect(find(plan, "NOPROJECT-TASK")).toMatchObject({ project: null, forYou: true });
    expect(find(plan, "UNASSIGNED-IN-PROJECT")?.forYou).toBe(true);
    expect(find(plan, "ERINS-TASK")?.forYou).toBe(false); // someone else's
  });

  it("does not hand you an unassigned task in a note you can only read", async () => {
    const plan = await call("erin", "GET", "/api/plan");
    expect(find(plan, "READONLY-TASK")).toBeDefined(); //          erin can see it…
    expect(find(plan, "READONLY-TASK")?.forYou).toBe(false); // …but it is not hers to plan
    expect(find(plan, "NOPROJECT-TASK")?.forYou).toBe(true); //   Engineering edits this folder
    expect(find(plan, "ERINS-TASK")?.forYou).toBe(true);
  });
});

describe("POST /api/plan/auto", () => {
  it("proposes time for tasks outside projects and unassigned ones, not other people's", async () => {
    const from = isoLocal(new Date());
    const to = isoLocal(new Date(Date.now() + 13 * 86_400_000));
    const res = await call("jules", "POST", "/api/plan/auto", { from, to });
    const texts = (res.proposals as { text: string }[]).map((p) => p.text).join("\n");
    expect(texts).toContain("NOPROJECT-TASK");
    expect(texts).toContain("UNASSIGNED-IN-PROJECT");
    expect(texts).not.toContain("ERINS-TASK");
  });
});

describe("GET /api/plan/:team", () => {
  it("still keeps a team plan to that team's projects", async () => {
    const plan = await call("jules", "GET", "/api/plan/engineering");
    expect(find(plan, "NOPROJECT-TASK")).toBeUndefined();
    expect(find(plan, "UNASSIGNED-IN-PROJECT")).toBeDefined();
  });
});
