/**
 * The canvas engine. Two audit tickets were about the old map, and these guard their classes:
 *   WEB-016: a frame resized the canvas, forced layout, re-read the CSS and stroked each edge on
 *            its own. A frame here does none of that, and its strokes don't grow with the links.
 *   WEB-008: a setting read through a closure the map was built with did nothing until a
 *            rebuild. What the page asks for here takes effect on the next frame.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetLayouts, OrreryEngine, type Intent, type Snapshot } from "./engine.js";
import { fixture, NOW } from "./fixture.js";
import { buildModel, signature } from "./model.js";

/** A 2-D context that only counts what it is asked to do. */
function fakeContext() {
  const calls = new Map<string, number>();
  const fills: string[] = [];
  let fillStyle = "";
  const ctx = new Proxy({} as Record<string | symbol, unknown>, {
    get(_t, k) {
      if (k === "fillStyle") return fillStyle;
      if (k === "measureText") return (s: string) => ({ width: s.length * 6 });
      if (k === "createLinearGradient") return () => ({ addColorStop() {} });
      return (..._a: unknown[]) => {
        calls.set(String(k), (calls.get(String(k)) ?? 0) + 1);
        if (k === "fillRect") fills.push(fillStyle);
      };
    },
    set(_t, k, v) {
      if (k === "fillStyle") fillStyle = String(v);
      return true;
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls, fills, reset: () => (calls.clear(), (fills.length = 0)) };
}

/** A canvas that counts how often its backing store is resized. */
function countingCanvas() {
  const c = document.createElement("canvas");
  let sets = 0;
  let w = 300;
  Object.defineProperty(c, "width", { get: () => w, set: (v) => ((w = v), sets++) });
  Object.defineProperty(c, "height", { get: () => 150, set: () => sets++ });
  return { canvas: c, sets: () => sets };
}

const model = (extraLinks: number, extraNotes = 60) => buildModel(fixture({ extraNotes, extraLinks }).graph, fixture({ extraNotes }).tree, fixture().projects, null, NOW);

async function engineWith(extraLinks = 0, hooks: { onIntent?: (i: Intent) => void; onChange?: (s: Snapshot) => void } = {}, extraNotes = 60) {
  const f = fakeContext();
  const { canvas, sets } = countingCanvas();
  const e = new OrreryEngine(canvas, hooks, { context: f.ctx, reducedMotion: true, sliceMs: 0 });
  e.resize(900, 700, 1);
  const m = model(extraLinks, extraNotes);
  await e.setModel(m, signature(m));
  return { e, f, sets, m };
}

beforeEach(() => forgetLayouts());
afterEach(() => vi.restoreAllMocks());

describe("a frame (WEB-016)", () => {
  it("never resizes the canvas: only a new size does", async () => {
    const { e, sets } = await engineWith();
    const before = sets();
    for (let k = 0; k < 20; k++) e.draw();
    e.resize(900, 700, 1); // the same size again
    expect(sets()).toBe(before);
    e.resize(901, 700, 1);
    expect(sets()).toBe(before + 2);
  });

  it("reads no CSS and no layout", async () => {
    const { e } = await engineWith();
    const style = vi.spyOn(window, "getComputedStyle");
    const rect = vi.spyOn(Element.prototype, "getBoundingClientRect");
    for (let k = 0; k < 10; k++) e.draw();
    expect(style).not.toHaveBeenCalled();
    expect(rect).not.toHaveBeenCalled();
  });

  it("strokes the links in a fixed number of passes, however many links there are", async () => {
    const few = await engineWith(0);
    few.f.reset();
    few.e.draw();
    const many = await engineWith(400);
    many.f.reset();
    many.e.draw();
    expect(many.m.ea.length).toBeGreaterThan(few.m.ea.length + 300);
    expect(many.f.calls.get("stroke")).toBe(few.f.calls.get("stroke"));
    expect(many.f.calls.get("lineTo")!).toBeGreaterThan(few.f.calls.get("lineTo")! + 300);
  });

  it("fills the many small dots in batches, not one by one", async () => {
    const few = await engineWith(0, {}, 20);
    few.f.reset();
    few.e.draw();
    const many = await engineWith(0, {}, 600);
    many.f.reset();
    many.e.draw();
    expect(many.m.nodes.length).toBeGreaterThan(few.m.nodes.length + 500);
    expect(many.f.calls.get("fill")!).toBeLessThanOrEqual(few.f.calls.get("fill")! + 4); // a few more strength steps at most
  });
});

describe("what the page asks for takes effect at once (WEB-008)", () => {
  it("the reviews switch shows reviews on the next frame, no rebuild", async () => {
    const { e, m } = await engineWith();
    const review = m.nodes.find((d) => d.t === 5)!.i;
    const [x, y] = e.screenOf(review);
    expect(e.hit(x, y)).not.toBe(review);
    e.setRest(true);
    expect(e.hit(x, y)).toBe(review);
  });

  it("a theme change is read once, when it happens, and drawn with", async () => {
    const { e, f } = await engineWith();
    document.documentElement.style.setProperty("--surface", "rgb(1, 2, 3)");
    document.documentElement.dataset.theme = "dark";
    await new Promise((r) => setTimeout(r, 0)); // the observer's callback
    f.reset();
    e.draw();
    expect(f.fills[0]).toBe("rgb(1, 2, 3)");
    document.documentElement.style.removeProperty("--surface");
    delete document.documentElement.dataset.theme;
  });
});

describe("levels and intents", () => {
  it("double-click asks for Steps; Esc asks to step out; the address answers with show()", async () => {
    const intents: Intent[] = [];
    let snap: Snapshot | null = null;
    const { e, m } = await engineWith(0, { onIntent: (i) => intents.push(i), onChange: (s) => (snap = s) });
    const p = m.nodes.find((d) => d.id === "p-kade")!.i;
    e.show({ center: p });
    expect(snap!.view).toBe("steps");
    expect(snap!.center).toBe(p);
    e.escape();
    expect(intents).toEqual([{ kind: "out" }]);
    e.show({});
    expect(snap!.view).toBe("kind");
    e.show({ area: 1 });
    expect(snap!.area).toBe(1);
    e.home();
    expect(intents.at(-1)).toEqual({ kind: "home" });
  });

  it("after an area, the selection you had comes back", async () => {
    let snap: Snapshot | null = null;
    const { e, m } = await engineWith(0, { onChange: (s) => (snap = s) });
    const ines = m.nodes.find((d) => d.id === "ines")!.i;
    e.select(ines);
    e.show({ area: 1 });
    expect(snap!.sel).toBe(-1);
    expect(snap!.backSel).toBe(ines);
    e.show({});
    expect(snap!.sel).toBe(ines);
  });

  it("two fingers pinch to zoom about their midpoint", async () => {
    const { e, m } = await engineWith();
    const c = e.canvas;
    c.getBoundingClientRect = () => ({ left: 0, top: 0, right: 900, bottom: 700, width: 900, height: 700, x: 0, y: 0, toJSON() {} }) as DOMRect;
    const ev = (type: string, id: number, x: number, y: number) => c.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, button: 0, pointerId: id, bubbles: true }));
    const i = m.nodes.find((d) => d.id === "n-arima")!.i;
    const before = e.screenOf(i);
    const dist = (p: [number, number]) => Math.hypot(p[0] - 450, p[1] - 350);
    ev("pointerdown", 1, 400, 350);
    ev("pointerdown", 2, 500, 350);
    ev("pointermove", 1, 350, 350);
    ev("pointermove", 2, 550, 350); // twice as far apart
    ev("pointerup", 1, 350, 350);
    ev("pointerup", 2, 550, 350);
    expect(dist(e.screenOf(i))).toBeCloseTo(dist(before) * 2, 0);
    expect(e.snapshot().sel).toBe(-1); // a pinch selects nothing
  });

  it("a file you drag stays in its slice and ring", async () => {
    const { e, m } = await engineWith();
    const i = m.nodes.find((d) => d.id === "n-arima")!.i;
    const [x, y] = e.screenOf(i);
    const c = e.canvas;
    c.getBoundingClientRect = () => ({ left: 0, top: 0, right: 900, bottom: 700, width: 900, height: 700, x: 0, y: 0, toJSON() {} }) as DOMRect;
    const ev = (type: string, cx: number, cy: number) => c.dispatchEvent(new PointerEvent(type, { clientX: cx, clientY: cy, button: 0, bubbles: true }));
    ev("pointerdown", x, y);
    ev("pointermove", x + 10, y);
    ev("pointermove", 450, 350); // towards Orr, across the rings
    const held = e.worldOf(i);
    expect(Math.hypot(held[0], held[1])).toBeGreaterThanOrEqual(462 - 1); // held inside the notes' ring
    ev("pointerup", 450, 350);
    const [wx, wy] = e.worldOf(i);
    expect(Math.hypot(wx, wy)).toBeGreaterThanOrEqual(462 - 1); // and still there once let go
  });
});
