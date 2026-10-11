/** Where every file sits: Kind's slices and rings, Steps' groups and rings, and the free web held inside them. */
import { describe, expect, it } from "vitest";
import { fixture, NOW } from "./fixture.js";
import { bandOf, BAND, layoutKind, layoutSteps, TAU } from "./layout.js";
import { buildModel, type Model } from "./model.js";
import { settleKind } from "./physics.js";

const model = (extra = 0) => buildModel(fixture({ extraNotes: extra, extraLinks: extra * 3 }).graph, fixture({ extraNotes: extra }).tree, fixture().projects, null, NOW);
const id = (m: Model, s: string) => m.nodes.find((d) => d.id === s)!.i;

/** Is the point inside the angle span [a0, a1] (with a little give) and the ring [r0, r1]? */
function inside(x: number, y: number, [a0, a1]: readonly [number, number], [r0, r1]: readonly [number, number], give = 1e-3) {
  const r = Math.hypot(x, y);
  let a = Math.atan2(y, x);
  while (a < a0 - give) a += TAU;
  while (a > a0 + TAU) a -= TAU;
  return r >= r0 - 0.5 && r <= r1 + 0.5 && a <= a1 + give;
}

describe("Kind", () => {
  const m = model(60);
  const K = layoutKind(m);
  it("every file sits in its life area's slice and its kind's ring", () => {
    for (const d of m.nodes) expect(inside(K.X[d.i]!, K.Y[d.i]!, K.areaSpan[d.area]!, bandOf(d.t)), d.name).toBe(true);
  });
  it("projects nearest Orr, then people and companies, then notes, reviews on the rim", () => {
    expect(BAND.proj[1]).toBeLessThan(BAND.ppl[0]);
    expect(BAND.ppl[1]).toBeLessThan(BAND.note[0]);
    expect(BAND.note[1]).toBeLessThan(BAND.rest[0]);
  });
  it("slices share the circle by count^0.8, so a big area grows more slowly than its count", () => {
    const w = K.areaSpan.map(([a, b]) => b - a);
    const ki = 4; // Knowledge holds the extra notes
    const pe = 3; // Personal
    expect(w[ki]! / w[pe]!).toBeLessThan(m.areaCount[ki]! / m.areaCount[pe]!);
    expect(w[ki]!).toBeGreaterThan(w[pe]!);
    const total = w.reduce((s, x) => s + x, 0);
    expect(total).toBeCloseTo(TAU - 0.05 * 5, 5);
  });
  it("two big areas share the circle as count^0.8, not as count", () => {
    const n = (id: string) => ({ id, title: id, folder: "", sector: null, tags: [], links: 0, tasks: 0, kind: "note" as const, description: "" });
    const ids = Array.from({ length: 150 }, (_, k) => `n${k}`);
    const tree = ids.map((id, k) => ({ id, path: `${id}.md`, folder: "", title: id, hash: id, mtimeMs: NOW, tags: [], openTasks: 0, category: k < 100 ? "knowledge" : "work" }));
    const K2 = layoutKind(buildModel({ nodes: ids.map(n), edges: [] }, tree, [], null, NOW));
    const w = K2.areaSpan.map(([a, b]) => b - a);
    expect(w[4]! / w[1]!).toBeCloseTo(Math.pow(2, 0.8), 3);
  });
  it("a topic's span lies inside its area's", () => {
    for (const t of m.topics) {
      const [a0, a1] = K.topicSpan[t.id]!;
      const [b0, b1] = K.areaSpan[t.area]!;
      expect(a0).toBeGreaterThanOrEqual(b0 - 1e-6);
      expect(a1).toBeLessThanOrEqual(b1 + 1e-6);
    }
  });
});

describe("the free web", () => {
  it("settles with every file still inside its slice and ring, and linked files drawn together", async () => {
    const m = model(120);
    const K = layoutKind(m);
    const [X, Y] = (await settleKind(m, K, () => true, { ticks: 120 }))!;
    for (const d of m.nodes) expect(inside(X[d.i]!, Y[d.i]!, K.areaSpan[d.area]!, bandOf(d.t), 0.02), d.name).toBe(true);
    // two linked notes in the same ring end nearer than they started
    const a = id(m, "n-arima");
    const b = id(m, "n-mase");
    expect(Math.hypot(X[a]! - X[b]!, Y[a]! - Y[b]!)).toBeLessThan(Math.hypot(K.X[a]! - K.X[b]!, K.Y[a]! - K.Y[b]!));
  });
  it("gives up when something newer arrives", async () => {
    const m = model(20);
    expect(await settleKind(m, layoutKind(m), () => true, { ticks: 50, sliceMs: 1e-9, stale: () => true })).toBeNull();
  });
});

describe("Steps", () => {
  const m = model();
  const keep = (j: number) => m.nodes[j]!.t !== 5;
  it("ring 1 is everything one step away, grouped by how it relates", () => {
    const S = layoutSteps(m, id(m, "p-kade"), keep);
    expect(S.order).toEqual(["involves", "its notes", "discussed in"]);
    expect(S.ring1.map((i) => m.nodes[i]!.name).sort()).toEqual(["Campaign brief", "Checking the KPI review", "Ines Vermaat", "KPI review", "Kade Social"]);
    expect(S.ON[id(m, "r-week")]).toBe(0); // reviews only with the switch
    for (const i of S.ring1) expect(Math.hypot(S.X[i]!, S.Y[i]!)).toBeGreaterThanOrEqual(S.r1a - 0.5);
  });
  it("ring 2 puts what several things in ring 1 share nearest, and names who they are", () => {
    // A links to B and C; B and C both link to D, and only B to E
    const n = (id: string) => ({ id, title: id, folder: "", sector: null, tags: [], links: 0, tasks: 0, kind: "note" as const, description: "" });
    const t = (id: string) => ({ id, path: `${id}.md`, folder: "", title: id, hash: id, mtimeMs: NOW, tags: [], openTasks: 0, category: "work" });
    const ids = ["A", "B", "C", "D", "E"];
    const g = { nodes: ids.map(n), edges: [["A", "B"], ["A", "C"], ["B", "D"], ["C", "D"], ["B", "E"]].map(([from, to]) => ({ from: from!, to: to! })) };
    const mm = buildModel(g, ids.map(t), [], null, NOW);
    const S = layoutSteps(mm, 0, () => true);
    expect(S.ring1).toEqual([1, 2]);
    expect(S.ring2.sort()).toEqual([3, 4]);
    expect(S.strong).toEqual([3]);
    expect(S.VIA[3]).toBe(2);
    expect(Math.hypot(S.X[3]!, S.Y[3]!)).toBeLessThan(Math.hypot(S.X[4]!, S.Y[4]!)); // the shared one sits nearer
  });
  it("on the phone only what ring 1 shares stays", () => {
    const n = (id: string) => ({ id, title: id, folder: "", sector: null, tags: [], links: 0, tasks: 0, kind: "note" as const, description: "" });
    const t = (id: string) => ({ id, path: `${id}.md`, folder: "", title: id, hash: id, mtimeMs: NOW, tags: [], openTasks: 0, category: "work" });
    const ids = ["A", "B", "C", "D", "E"];
    const g = { nodes: ids.map(n), edges: [["A", "B"], ["A", "C"], ["B", "D"], ["C", "D"], ["B", "E"]].map(([from, to]) => ({ from: from!, to: to! })) };
    const mm = buildModel(g, ids.map(t), [], null, NOW);
    expect(layoutSteps(mm, 0, () => true).ring2.sort()).toEqual([3, 4]);
    const lite = layoutSteps(mm, 0, () => true, true);
    expect(lite.ring2).toEqual([3]);
    expect(lite.ON[4]).toBe(0);
  });
});
