/**
 * The plan's AI estimate cache stays bounded (audit AI-014).
 *
 * It was keyed on the whole task listing, so every tick or rename made a new
 * entry, and expired entries were skipped on read but never deleted: the map
 * grew for as long as the launchd agent ran (weeks between restarts).
 */
import { afterAll, describe, expect, it } from "vitest";
import { bootAi } from "./helpers/aiServer.js";

// The server first: it sets the environment the server modules read on import.
const s = await bootAi("plan-estimate-cache");
afterAll(() => s.close());
const { EstimateCache } = await import("../src/routes/plan.js");

describe("EstimateCache", () => {
  it("holds at most its cap, dropping the oldest", () => {
    const c = new EstimateCache(60_000, 3);
    for (let i = 0; i < 10; i++) c.set(`listing ${i}`, [i], 1000 + i);
    expect(c.size).toBe(3);
    expect(c.get("listing 6", 1100)).toBeUndefined();
    expect(c.get("listing 9", 1100)).toEqual([9]);
    expect(c.get("listing 7", 1100)).toEqual([7]);
  });

  it("removes an entry it finds expired", () => {
    const c = new EstimateCache(1000, 10);
    c.set("a", [1], 0);
    c.set("b", [2], 500);
    expect(c.get("a", 999)).toEqual([1]);
    expect(c.get("a", 1000)).toBeUndefined();
    expect(c.size).toBe(1);
    expect(c.get("b", 1000)).toEqual([2]);
  });

  it("an entry set again counts as new", () => {
    const c = new EstimateCache(60_000, 2);
    c.set("a", [1], 0);
    c.set("b", [2], 1);
    c.set("a", [3], 2); // refreshed: now the newest
    c.set("c", [4], 3);
    expect(c.get("a", 4)).toEqual([3]);
    expect(c.get("b", 4)).toBeUndefined();
  });
});

describe("Planning's estimate cache", () => {
  const jules = s.aclUser("jules");
  // The provider estimates one hour per task, whatever it is sent.
  const estimate = (body: any) => {
    const listing = String(body.messages.find((m: any) => m.role === "user")?.content ?? "");
    return { text: JSON.stringify(listing.split("\n").filter(Boolean).map(() => 1)) };
  };
  const planWith = async (task: string) => {
    s.built.store.write(jules, "Shared/Backlog.md", `# Backlog\n\n- [ ] ${task}\n`);
    s.queue.push(estimate);
    const r = await s.call("jules", "GET", "/api/plan");
    s.queue.length = 0;
    return r.json;
  };

  it("asks once per listing, and keeps at most 200 listings", async () => {
    expect((await planWith("listing 0")).source).toBe("ai");
    const asked = () => s.llm.requests.length;
    let before = asked();
    await planWith("listing 0");
    expect(asked()).toBe(before); // cached
    for (let i = 1; i <= 200; i++) await planWith(`listing ${i}`);
    before = asked();
    await planWith("listing 200");
    expect(asked()).toBe(before); // still cached
    await planWith("listing 0");
    expect(asked()).toBe(before + 1); // the oldest went
  }, 120_000);
});
