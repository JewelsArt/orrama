/**
 * Planning answers at once; the model's estimates arrive after (P1).
 *
 * `GET /api/plan` asked the model to estimate every open task before it
 * answered (6 s on average on Jules's vault, 15 Oct), and cached the answer per
 * whole task listing, so ticking any one task paid the whole call again. Now the
 * plan answers with the heuristic for any task the cache doesn't know, the
 * model is asked about those after the response, one call at a time, and each
 * estimate is kept per task.
 *
 * The cache also stays bounded in time and size (audit AI-014): expired entries
 * used to be skipped on read but never deleted, and the map grew for as long as
 * the launchd agent ran.
 */
import { afterAll, describe, expect, it } from "vitest";
import { bootAi } from "./helpers/aiServer.js";

// A short model timeout, so the slow call below gives up inside the test.
process.env.ORRAMA_PLAN_AI_TIMEOUT_MS = "3000";
// The server first: it sets the environment the server modules read on import.
const s = await bootAi("plan-estimate-cache");
afterAll(() => s.close());
const { EstimateCache, EstimateRefiner, refiner } = await import("../src/routes/plan.js");
const { tables } = await import("../src/db.js");

describe("EstimateCache", () => {
  it("holds at most its cap, dropping the oldest", () => {
    const c = new EstimateCache(60_000, 3);
    for (let i = 0; i < 10; i++) c.set(`task ${i}`, i, 1000 + i);
    expect(c.size).toBe(3);
    expect(c.get("task 6", 1100)).toBeUndefined();
    expect(c.get("task 9", 1100)).toBe(9);
    expect(c.get("task 7", 1100)).toBe(7);
  });

  it("removes an entry it finds expired", () => {
    const c = new EstimateCache(1000, 10);
    c.set("a", 1, 0);
    c.set("b", 2, 500);
    expect(c.get("a", 999)).toBe(1);
    expect(c.get("a", 1000)).toBeUndefined();
    expect(c.size).toBe(1);
    expect(c.get("b", 1000)).toBe(2);
  });

  it("an entry set again counts as new", () => {
    const c = new EstimateCache(60_000, 2);
    c.set("a", 1, 0);
    c.set("b", 2, 1);
    c.set("a", 3, 2); // refreshed: now the newest
    c.set("c", 4, 3);
    expect(c.get("a", 4)).toBe(3);
    expect(c.get("b", 4)).toBeUndefined();
  });
});

describe("EstimateRefiner", () => {
  const cfg = { provider: "openai-compatible", apiKey: "k", model: "m", baseUrl: null } as const;

  it("asks one call at a time, and keeps at most its cache's cap", async () => {
    let out = 0;
    let most = 0;
    const calls: string[][] = [];
    const r = new EstimateRefiner(new EstimateCache(60_000, 3), async (_c, lines) => {
      calls.push(lines);
      most = Math.max(most, ++out);
      await new Promise((ok) => setTimeout(ok, 20));
      out--;
      return lines.map(() => 2);
    });
    r.want("a", cfg, "task a", 1);
    r.start();
    r.want("b", cfg, "task b", 1); // queued while the first call is out
    r.start();
    r.want("c", cfg, "task c", 1);
    r.want("d", cfg, "task d", 1);
    r.start();
    await r.settled();
    expect(most).toBe(1);
    expect(calls).toEqual([["task a"], ["task b", "task c", "task d"]]);
    expect(r.cache.size).toBe(3);
    expect(r.known("a")).toBeUndefined(); // the oldest went
    expect(r.known("d")).toBe(2);
    // Asked again once it has gone, and only it.
    expect(r.want("a", cfg, "task a", 1)).toBe(true);
    r.start();
    await r.settled();
    expect(calls.at(-1)).toEqual(["task a"]);
  });

  it("a failed call leaves those tasks to the heuristic, and they are not asked again at once", async () => {
    let calls = 0;
    const r = new EstimateRefiner(new EstimateCache(60_000, 10), async () => {
      calls++;
      throw new Error("provider down");
    });
    expect(r.want("a", cfg, "task a", 1.5)).toBe(true);
    r.start();
    await r.settled();
    expect(r.known("a")).toBeUndefined();
    expect(r.want("a", cfg, "task a", 1.5)).toBe(false);
    r.start();
    await r.settled();
    expect(calls).toBe(1);
  });
});

describe("GET /api/plan with a model configured", () => {
  const jules = s.aclUser("jules");
  const tasksOf = (plan: any) => plan.assignees.flatMap((a: any) => a.tasks);
  const task = (plan: any, text: string) => tasksOf(plan).find((t: any) => t.text === text);
  const asked = () => s.llm.requests.filter((r) => r.path === "/v1/chat/completions");
  const listing = (body: any) => String(body.messages.find((m: any) => m.role === "user")?.content ?? "").split("\n").filter(Boolean);
  // The provider estimates three hours per task, whatever it is sent.
  const three = (body: any) => ({ text: JSON.stringify(listing(body).map(() => 3)) });

  it("answers without waiting for a slow model, with the heuristic, and says it is refining", async () => {
    s.queue.push((body: any) => ({ ...three(body), delay: 10_000 }));
    const t0 = performance.now();
    const r = await s.call("jules", "GET", "/api/plan");
    const ms = performance.now() - t0;
    expect(r.status).toBe(200);
    expect(ms).toBeLessThan(1000);
    expect(r.json.refining).toBe(true);
    expect(r.json.source).toBe("heuristic");
    expect(tasksOf(r.json).length).toBeGreaterThan(0);
    expect(tasksOf(r.json).every((t: any) => t.refining)).toBe(true);

    // While that call is out, a new task is queued, not asked about in a second call.
    s.built.store.write(jules, "Shared/Later.md", "# Later\n\n- [ ] Write the appendix\n");
    const again = await s.call("jules", "GET", "/api/plan");
    expect(task(again.json, "Write the appendix").refining).toBe(true);
    await new Promise((ok) => setTimeout(ok, 200));
    expect(asked()).toHaveLength(1);
  });

  it("a failed refinement leaves the heuristic plan, and is not asked again on the next load", async () => {
    // The slow call above times out (3 s); the appendix is asked about next and the empty queue answers "done", not a list.
    await refiner.settled();
    const before = asked().length;
    expect(before).toBe(2);
    const r = await s.call("jules", "GET", "/api/plan");
    expect(r.json.refining).toBe(false);
    expect(r.json.source).toBe("heuristic");
    expect(tasksOf(r.json).every((t: any) => !t.refining)).toBe(true);
    expect(task(r.json, "Write the appendix").estimateHours).toBe(2); // the heuristic: 1.5 for no priority, + 3 words / 8, to the half hour
    await refiner.settled();
    expect(asked()).toHaveLength(before);
  }, 15_000);

  it("?refined=1 waits for the model, and the plan carries its estimates", async () => {
    s.built.store.write(jules, "Shared/Backlog.md", "# Backlog\n\n- [ ] Draft the survey\n- [ ] Clean the panel data !p1\n- [ ] Write the method section\n");
    s.queue.push(three);
    const first = await s.call("jules", "GET", "/api/plan");
    expect(first.json.refining).toBe(true);
    expect(task(first.json, "Draft the survey")).toMatchObject({ refining: true, estimateHours: 2 });
    const refined = await s.call("jules", "GET", "/api/plan?refined=1");
    expect(refined.json.refining).toBe(false);
    for (const text of ["Draft the survey", "Clean the panel data", "Write the method section"])
      expect(task(refined.json, text)).toMatchObject({ refining: false, estimateHours: 3 });
    expect(listing(asked().at(-1)!.body)).toHaveLength(3);
  });

  it("one changed task is one call, for that task only", async () => {
    const before = asked().length;
    s.built.store.write(jules, "Shared/Backlog.md", "# Backlog\n\n- [ ] Draft the survey\n- [ ] Clean the panel data !p1\n- [ ] Write the results section\n");
    s.queue.push(three);
    const r = await s.call("jules", "GET", "/api/plan");
    expect(task(r.json, "Draft the survey")).toMatchObject({ refining: false, estimateHours: 3 });
    expect(task(r.json, "Write the results section").refining).toBe(true);
    await refiner.settled();
    expect(asked()).toHaveLength(before + 1);
    const sent = listing(asked().at(-1)!.body);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Write the results section");
    // Ticking a task asks nothing at all.
    s.built.store.write(jules, "Shared/Backlog.md", "# Backlog\n\n- [x] Draft the survey\n- [ ] Clean the panel data !p1\n- [ ] Write the results section\n");
    const ticked = await s.call("jules", "GET", "/api/plan");
    expect(task(ticked.json, "Write the results section")).toMatchObject({ refining: false, estimateHours: 3 });
    await refiner.settled();
    expect(asked()).toHaveLength(before + 1);
  });

  it("without an AI key: heuristic only, nothing refining, nothing asked", async () => {
    const before = asked().length;
    s.built.db.update(tables.workspace).set({ aiKeyEncrypted: null }).run();
    s.built.store.write(jules, "Shared/Backlog.md", "# Backlog\n\n- [ ] Draft the discussion\n");
    const r = await s.call("jules", "GET", "/api/plan");
    expect(r.json.source).toBe("heuristic");
    expect(r.json.refining).toBe(false);
    expect(tasksOf(r.json).every((t: any) => !t.refining)).toBe(true);
    await refiner.settled();
    expect(asked()).toHaveLength(before);
  });
});
