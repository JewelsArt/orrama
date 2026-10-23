/**
 * The Orrery's canvas: the renderer, the live web and the moves (structure.md §2.16), ported
 * from the prototype Jules picked on 9 October (take B, "a brain in each slice").
 *
 * One object holds everything that changes per frame, and React talks to it through methods,
 * never through a closure that a render captured: what the page asks for takes effect on the
 * next frame (WEB-008 was a slider read through a stale closure). The frame loop runs only while
 * something moves. Drawing never sizes the canvas, never reads layout and never asks the CSS for
 * colours: the canvas is sized when its box changes, colours are read when the theme or the
 * colour-vision mode changes, and the controls' boxes are handed in by the page; links and dots
 * go out in a few batched strokes and fills, however many there are (WEB-016).
 *
 * How it moves:
 *   - the free layout (physics.ts): the web settles, and a drag reheats only its neighbourhood;
 *   - pointing: what a file links to leans towards it on springs and swings back (the ripple);
 *   - transitions: opening (files come out of Orr, projects first), Steps and back (ring by ring
 *     with a small overshoot), zooms. With reduced motion every change is instant and a drag
 *     moves only the file you hold.
 */
import { otherEnd, type Model } from "./model.js";
import { BAND, clamp, hash, layoutKind, layoutSteps, TAU, type KindLayout, type StepsLayout } from "./layout.js";
import { Field, PB, settleKind, settleTicks } from "./physics.js";

export type View = "kind" | "steps";
export type Blank = "empty" | "error" | "reading" | null;

/** What the page shows around the canvas. */
export interface Snapshot {
  view: View;
  sel: number;
  center: number;
  area: number;
  topic: number;
  rest: boolean;
  blank: Blank;
  /** Files placed so far during the reveal, and of how many; null when not revealing. */
  reveal: { got: number; of: number } | null;
  /** What Back returns to after an area or a topic: the file that was selected. */
  backSel: number;
}

/** Something the page should turn into an address (and then hand back through `show`). */
export type Intent = { kind: "steps"; i: number } | { kind: "area"; area: number } | { kind: "topic"; topic: number } | { kind: "out" } | { kind: "home" };

export interface Target {
  center?: number;
  area?: number;
  topic?: number;
}

export interface Hooks {
  onChange?: (s: Snapshot) => void;
  onIntent?: (i: Intent) => void;
}

interface Colors {
  ink: string;
  ink2: string;
  ink3: string;
  line2: string;
  surface: string;
  accent: string;
  warn: string;
  prog: string;
  area: string[];
  font: string;
}

/** A box on the stage, in CSS pixels from its top left: the controls, which names keep clear of. */
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

type Ctx = CanvasRenderingContext2D;
type Cam = { x: number; y: number; k: number };

const HEAD_D =
  "M430.88 142.85C430.88 186.64 395.38 222.13 351.6 222.13C307.82 222.13 272.32 186.64 272.32 142.85C272.32 99.07 307.82 63.58 351.6 63.58C395.38 63.58 430.88 99.07 430.88 142.85ZM389.92 142.85C389.92 121.69 372.77 104.53 351.6 104.53C330.44 104.53 313.28 121.69 313.28 142.85C313.28 164.02 330.44 181.17 351.6 181.17C372.77 181.17 389.92 164.02 389.92 142.85Z";
const HEAD_STOPS = ["#FEE28C", "#FED884", "#FEC97B", "#FEB56F", "#FEA267", "#FD8E66", "#FE7867", "#FE6668", "#FD5968"];

/** The ripple's springs. */
const PA = { home: 64, damp: 8.5, couple: 120, push: 2400 };
/** About this many of the strongest links on screen at once, scaled by the map's size and the zoom. */
export const WEB_BUDGET = 1200;
/** How long the reveal takes when the notes had to be read first. */
const REVEAL_MS = 1800;

/** Laid-out vaults, by the data's fingerprint: coming back to the Orrery opens at once. */
const settled = new Map<string, [Float32Array, Float32Array]>();
/** For tests: forget the laid-out vaults. */
export const forgetLayouts = () => settled.clear();

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const back = (t: number) => {
  const c1 = 1.25;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};

export interface EngineOptions {
  /** A 2-D context to draw on instead of the canvas's own (tests count what it is asked to do). */
  context?: Ctx | null;
  reducedMotion?: boolean;
  /** Where the colours are read from (the page's root). */
  styleRoot?: Element;
  /** Settle in slices of this many ms (0: at once, as tests do). */
  sliceMs?: number;
}

export class OrreryEngine {
  readonly canvas: HTMLCanvasElement;
  private ctx: Ctx | null;
  private hooks: Hooks;
  private styleRoot: Element;
  private reduceMotion: boolean;
  private sliceMs: number;

  private M: Model | null = null;
  private sig = "";
  private K: KindLayout | null = null;
  private S: StepsLayout | null = null;
  /** The whole vault's settled web: where Kind returns to. */
  private KB: [Float32Array, Float32Array] | null = null;
  private WORDER: Int32Array = new Int32Array(0);

  /** Positions, sizes and strengths on screen (interpolated during a transition), and their physics. */
  private f: Field | null = null;
  // the ripple's springs (offsets from home) and where things are drawn
  private DX = new Float32Array(0);
  private DY = new Float32Array(0);
  private SVX = new Float32Array(0);
  private SVY = new Float32Array(0);
  private FX = new Float32Array(0);
  private FY = new Float32Array(0);
  private ACT = new Uint8Array(0);
  private MASK = new Uint8Array(0);
  private LX = new Float32Array(0);
  private LY = new Float32Array(0);
  private SX = new Float32Array(0);
  private SY = new Float32Array(0);

  private st = { view: "kind" as View, sel: -1, hover: -1, center: -1, area: -1, topic: -1, rest: false, blank: "reading" as Blank, cam: { x: 0, y: 0, k: 1 } as Cam };
  private backTo: { sel: number; cam: Cam } | null = null;
  private reveal: { got: number; total: number } | null = null;

  private anim = 0;
  private raf = 0;
  private last = 0;
  private visible = true;
  private active: number[] = [];
  private gridDirty = true;
  private sim = { on: false, alpha: 0, target: 0, list: [] as number[], all: true, fixed: -1, frame: 0 };
  private VIS: number[] = [];
  private TCX: Float32Array | null = null;
  private TCY: Float32Array | null = null;
  private orderCache: number[] | null = null;
  private labelTargets: [Box, ["area" | "topic" | "file", number]][] = [];
  private textW = new Map<string, number>();
  private obstacles: Box[] = [];

  private W = 0;
  private H = 0;
  private DPR = 1;
  private Rpx = 300;
  private colors: Colors = { ink: "#1B1813", ink2: "#4E473D", ink3: "#6B6357", line2: "#DCD4C6", surface: "#FFFFFF", accent: "#1967D4", warn: "#7F6000", prog: "#1B1813", area: [], font: "Figtree, system-ui, sans-serif" };
  private headPath: Path2D | null;

  private ndrag: { i: number; x: number; y: number; moved: boolean; n: number; mask?: number[] } | null = null;
  private pan: { x: number; y: number; cx: number; cy: number } | null = null;
  /** Fingers on the map, for a pinch. */
  private touches = new Map<number, [number, number]>();
  private pinch: { d0: number; k0: number; w: [number, number] } | null = null;
  private moved = false;
  private lastClick = 0;
  private lastPtr: [number, number] | null = null;
  private cursor = "";
  private settling = 0;
  private cleanup: (() => void)[] = [];

  /** The last frame's cost while something moved (ms), for the 10,000-file measurement. */
  readonly perf = { sim: 0, draw: 0, frames: 0, nSim: 0, webDrawn: 0 };

  constructor(canvas: HTMLCanvasElement, hooks: Hooks = {}, opts: EngineOptions = {}) {
    this.canvas = canvas;
    this.hooks = hooks;
    this.ctx = opts.context !== undefined ? opts.context : canvas.getContext("2d");
    this.styleRoot = opts.styleRoot ?? document.documentElement;
    this.sliceMs = opts.sliceMs ?? 12;
    const mq = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
    this.reduceMotion = opts.reducedMotion ?? !!mq?.matches;
    if (mq && opts.reducedMotion === undefined) {
      const onMq = () => (this.reduceMotion = mq.matches);
      mq.addEventListener?.("change", onMq);
      this.cleanup.push(() => mq.removeEventListener?.("change", onMq));
    }
    this.headPath = typeof Path2D === "function" ? new Path2D(HEAD_D) : null;
    this.readColors();
    this.listen();
  }

  /* ------------------------------------------------------------------ the page's side */

  snapshot(): Snapshot {
    return {
      view: this.st.view,
      sel: this.st.sel,
      center: this.st.center,
      area: this.st.area,
      topic: this.st.topic,
      rest: this.st.rest,
      blank: this.st.blank,
      reveal: this.reveal ? { got: this.reveal.got, of: this.reveal.total } : null,
      backSel: this.backTo?.sel ?? -1,
    };
  }
  private changed() {
    this.hooks.onChange?.(this.snapshot());
  }

  /** The canvas's box changed: size the backing store (only here) and redraw. */
  resize(w: number, h: number, dpr = typeof devicePixelRatio === "number" ? devicePixelRatio : 1): void {
    if (!w || !h || (w === this.W && h === this.H && dpr === this.DPR)) return;
    this.W = w;
    this.H = h;
    this.DPR = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.Rpx = Math.max(120, Math.min(w, h) / 2 - (w < 560 ? 14 : 56));
    this.draw();
  }

  /** Read the theme's colours. Called at start and when the theme or colour vision changes. */
  /** Each area's colour, read from its token: the model's areas, which the person names and orders. */
  private areaColors(cs: CSSStyleDeclaration): string[] {
    return (this.M?.areas ?? []).map((a, k) => cs.getPropertyValue(a.v).trim() || this.colors.area[k] || "#888");
  }

  readColors(): void {
    const cs = getComputedStyle(this.styleRoot);
    const c = this.colors;
    const v = (name: string, fb: string) => cs.getPropertyValue(name).trim() || fb;
    this.colors = {
      ink: v("--ink", c.ink),
      ink2: v("--ink-2", c.ink2),
      ink3: v("--ink-3", c.ink3),
      line2: v("--line-2", c.line2),
      surface: v("--surface", c.surface),
      accent: v("--accent", c.accent),
      warn: v("--warn", c.warn),
      prog: v("--prog", v("--ink", c.prog)),
      area: this.areaColors(cs),
      font: v("--font", c.font),
    };
    this.textW.clear();
    this.draw();
  }

  /** The controls on the stage, which names keep clear of. */
  setObstacles(boxes: Box[]): void {
    this.obstacles = boxes;
    this.draw();
  }

  /** Nothing to show yet, or nothing to show at all: Orr alone in the middle. */
  setBlank(kind: Blank): void {
    this.settling++;
    this.st.blank = kind;
    this.reveal = null;
    this.sim.on = false;
    if (this.anim) cancelAnimationFrame(this.anim), (this.anim = 0);
    this.f?.ALPHA.fill(0);
    this.changed();
    this.draw();
  }

  get model(): Model | null {
    return this.M;
  }

  /**
   * Show a vault. The first one comes out of Orr (`reveal` when the notes had to be read first:
   * slower, with a count); a later one (live sync) moves what was there to where it now goes.
   * Resolves once it is laid out; the settle runs in slices so the page keeps answering.
   */
  async setModel(m: Model, sig: string, opts: { reveal?: boolean } = {}): Promise<void> {
    if (sig === this.sig && this.M && !this.st.blank) return;
    const prev = this.M && !this.st.blank ? this.M : null;
    const prevF = prev ? this.f : null;
    const prevPos = prev && prevF ? new Map(prev.nodes.map((d) => [d.id, [prevF.X[d.i]!, prevF.Y[d.i]!] as const])) : null;
    const selId = prev && this.st.sel >= 0 ? prev.nodes[this.st.sel]!.id : null;
    const centerId = prev && this.st.center >= 0 ? prev.nodes[this.st.center]!.id : null;
    const token = ++this.settling;
    const rest = this.st.rest;
    const shown = (i: number) => m.nodes[i]!.t !== 5 || rest;

    const K = layoutKind(m);
    const E = m.ea.length;
    // links by strength: a meaning counts more, and so do well-linked ends
    const sc = new Float32Array(E);
    for (let e = 0; e < E; e++) sc[e] = (m.rels[m.er[e]!]!.typed ? 2.2 : 1) * Math.sqrt((m.adj[m.ea[e]!]!.length + 1) * (m.adj[m.eb[e]!]!.length + 1));
    const worder = new Int32Array(E);
    for (let e = 0; e < E; e++) worder[e] = e;
    worder.sort((a, b) => sc[b]! - sc[a]! || a - b);

    // settle (or take it from the cache) before anything changes on screen; a warm start keeps
    // what was there where it was
    const key = `${sig}|${rest ? 1 : 0}`;
    let KB = settled.get(key) ?? null;
    if (!KB) {
      let fromX: Float32Array | undefined;
      let fromY: Float32Array | undefined;
      if (prevPos && this.st.view === "kind") {
        fromX = new Float32Array(K.X);
        fromY = new Float32Array(K.Y);
        for (const d of m.nodes) {
          const p = prevPos.get(d.id);
          if (p) (fromX[d.i] = p[0]), (fromY[d.i] = p[1]);
        }
      }
      KB = await settleKind(m, K, shown, { fromX, fromY, ticks: prev ? 40 : settleTicks(m.nodes.length), a0: prev ? 0.3 : 1, sliceMs: this.sliceMs, stale: () => token !== this.settling });
      if (!KB || token !== this.settling) return; // something newer arrived meanwhile
      settled.set(key, KB);
      if (settled.size > 4) settled.delete(settled.keys().next().value!);
    }
    if (token !== this.settling) return;

    this.M = m;
    this.sig = sig;
    // The areas may have changed with the data: a rename, a new one, another order.
    this.colors = { ...this.colors, area: this.areaColors(getComputedStyle(this.canvas)) };
    this.K = K;
    this.KB = [new Float32Array(KB[0]), new Float32Array(KB[1])];
    this.WORDER = worder;
    this.alloc(m);
    const f = this.f!;
    this.st.sel = selId ? m.nodes.findIndex((d) => d.id === selId) : -1;
    const keepCenter = centerId ? m.nodes.findIndex((d) => d.id === centerId) : -1;
    this.st.hover = -1;
    this.st.blank = null;
    f.domainsKind(K);

    if (prevPos) {
      // live sync: from where things were to where they go now
      for (const d of m.nodes) {
        const p = prevPos.get(d.id);
        f.X[d.i] = p ? p[0] : 0;
        f.Y[d.i] = p ? p[1] : 0;
        f.RAD[d.i] = K.RAD[d.i]!;
        f.ALPHA[d.i] = p && shown(d.i) ? 1 : 0;
      }
      if (this.st.view === "steps" && keepCenter >= 0) this.goSteps(keepCenter);
      else {
        this.st.view = "kind";
        this.st.center = -1;
        this.S = null;
        this.animateTo(this.KB[0], this.KB[1], K.RAD, this.kindAlpha(), null, () => this.topicCentres(), { dur: 520 });
      }
      this.changed();
      return;
    }
    this.st.view = "kind";
    this.st.center = -1;
    this.S = null;
    f.X.set(this.KB[0]);
    f.Y.set(this.KB[1]);
    f.RAD.set(K.RAD);
    f.ALPHA.set(this.kindAlpha());
    this.topicCentres();
    this.buildGrid();
    this.changed();
    if (opts.reveal) this.startReveal();
    else if (!this.reduceMotion && this.visible) this.assemble();
    else this.draw();
  }

  /** Go to an address's level: Steps around `center`, a topic, an area, or the whole vault. */
  show(t: Target): void {
    if (!this.M || this.st.blank) return;
    if (t.center !== undefined && t.center >= 0) {
      if (this.st.view !== "steps" || this.st.center !== t.center) this.goSteps(t.center);
      return;
    }
    if (this.st.view === "steps") this.goKind(true);
    if (t.topic !== undefined && t.topic >= 0) {
      if (this.st.topic !== t.topic) this.zoomToTopic(t.topic);
    } else if (t.area !== undefined && t.area >= 0) {
      if (this.st.area !== t.area || this.st.topic >= 0) this.zoomToArea(t.area);
    } else if (this.st.area >= 0 || this.st.topic >= 0) this.backToVault();
  }

  /** Select a file (or nothing, -1), as a click does. */
  select(i: number): void {
    this.st.sel = i;
    this.changed();
    this.draw();
  }

  /** Fly to a file and select it (Find, a panel row). */
  flyTo(i: number): void {
    const f = this.f;
    if (!this.M || !f) return;
    if (this.st.view === "steps" && (!this.S || !this.S.ON[i])) {
      this.st.sel = i;
      this.hooks.onIntent?.({ kind: "steps", i });
      return;
    }
    if (this.M.nodes[i]!.t === 5 && !this.st.rest) this.setRest(true);
    this.st.sel = i;
    const k = Math.max(this.st.cam.k, 2.4);
    this.animateTo(f.X, f.Y, f.RAD, f.ALPHA, { x: f.X[i]!, y: f.Y[i]!, k });
    this.changed();
  }

  /** Reviews and templates on or off. */
  setRest(on: boolean): void {
    if (on === this.st.rest) return;
    this.st.rest = on;
    this.orderCache = null;
    const f = this.f;
    if (this.M && f && !this.st.blank) {
      if (this.st.view === "steps" && this.S) this.goSteps(this.S.center);
      else this.animateTo(f.X, f.Y, f.RAD, this.kindAlpha(), null);
    }
    this.changed();
  }

  zoomBy(k: number): void {
    const f = this.f;
    if (!f) return;
    this.animateTo(f.X, f.Y, f.RAD, f.ALPHA, { x: this.st.cam.x, y: this.st.cam.y, k: clamp(this.st.cam.k * k, 0.5, 16) });
  }
  /** `0`: the whole circle again, nothing else changed. */
  fit(): void {
    const f = this.f;
    if (!f) return;
    this.animateTo(f.X, f.Y, f.RAD, f.ALPHA, { x: 0, y: 0, k: 1 });
  }

  /** Orr (or the zoom's head): back to the whole vault. */
  home(): void {
    if (this.st.view === "steps" || this.st.area >= 0) this.hooks.onIntent?.({ kind: "home" });
    else {
      this.st.sel = -1;
      this.fit();
      this.changed();
    }
  }

  /** Esc: out one level (Steps, a topic, an area), else let go of the selection. */
  escape(): void {
    if (this.st.view === "steps" || this.st.area >= 0) this.hooks.onIntent?.({ kind: "out" });
    else if (this.st.sel >= 0) this.select(-1);
  }

  /** Arrow keys: the next file that way, selected, and brought on screen if it was off. */
  step(dir: { x: number; y: number }): void {
    const f = this.f;
    if (!this.M || !f || this.st.blank) return;
    this.positions();
    const from = this.st.sel >= 0 && f.ALPHA[this.st.sel]! > 0.3 ? this.st.sel : -1;
    let best = -1;
    if (from < 0) {
      const c = this.toWorld(this.W / 2, this.H / 2);
      let bd = Infinity;
      for (let i = 0; i < f.n; i++) {
        if (f.ALPHA[i]! < 0.3) continue;
        const d = (this.LX[i]! - c[0]) ** 2 + (this.LY[i]! - c[1]) ** 2;
        if (d < bd) (bd = d), (best = i);
      }
    } else {
      const pts: { id: number; x: number; y: number }[] = [];
      for (let i = 0; i < f.n; i++) if (f.ALPHA[i]! >= 0.3) pts.push({ id: i, x: this.LX[i]!, y: this.LY[i]! });
      best = nearestInDirection({ id: from, x: this.LX[from]!, y: this.LY[from]! }, pts, dir)?.id ?? from;
    }
    if (best < 0) return;
    this.st.sel = best;
    const p = this.toScreen(this.LX[best]!, this.LY[best]!);
    const margin = 48;
    if (p[0] < margin || p[0] > this.W - margin || p[1] < margin || p[1] > this.H - margin) (this.st.cam.x = this.LX[best]!), (this.st.cam.y = this.LY[best]!);
    this.changed();
    this.draw();
  }

  /** Where a file is on screen, in CSS pixels from the canvas's top left. */
  screenOf(i: number): [number, number] {
    this.positions();
    return this.toScreen(this.LX[i]!, this.LY[i]!);
  }
  /** Where a file sits in the world (tests: it stays in its slice and ring). */
  worldOf(i: number): [number, number] {
    return [this.f!.X[i]! + this.DX[i]!, this.f!.Y[i]! + this.DY[i]!];
  }
  /** Is a transition or the web still moving? */
  get busy(): boolean {
    return !!this.anim || this.sim.on || this.active.length > 0 || !!this.reveal;
  }

  /** Average time of one free-layout step over every shown file (ms). */
  benchSim(n: number): number {
    const f = this.f!;
    const l = f.movers();
    const t0 = performance.now();
    for (let k = 0; k < n; k++) f.step(l, 0.1);
    return (performance.now() - t0) / n;
  }
  /** Average time of one full redraw (ms). */
  benchDraw(n: number): number {
    const t0 = performance.now();
    for (let k = 0; k < n; k++) this.draw();
    return (performance.now() - t0) / n;
  }

  destroy(): void {
    this.settling++;
    if (this.anim) cancelAnimationFrame(this.anim);
    if (this.raf) cancelAnimationFrame(this.raf);
    this.anim = 0;
    this.raf = 0;
    this.visible = false;
    for (const fn of this.cleanup) fn();
    this.cleanup = [];
  }

  /* ------------------------------------------------------------------ data in */

  private alloc(m: Model) {
    const n = m.nodes.length;
    this.f = new Field(m);
    this.DX = new Float32Array(n);
    this.DY = new Float32Array(n);
    this.SVX = new Float32Array(n);
    this.SVY = new Float32Array(n);
    this.FX = new Float32Array(n);
    this.FY = new Float32Array(n);
    this.ACT = new Uint8Array(n);
    this.MASK = new Uint8Array(n);
    this.LX = new Float32Array(n);
    this.LY = new Float32Array(n);
    this.SX = new Float32Array(n);
    this.SY = new Float32Array(n);
    this.active = [];
    this.sim.on = false;
    this.sim.list = [];
    this.sim.fixed = -1;
    this.orderCache = null;
    this.gridDirty = true;
  }

  /** Reviews and templates are shown only with the switch. */
  private shown(i: number): boolean {
    return this.M!.nodes[i]!.t !== 5 || this.st.rest;
  }
  private kindAlpha(): Float32Array {
    const a = new Float32Array(this.M!.nodes.length);
    for (let i = 0; i < a.length; i++) a[i] = this.shown(i) ? 1 : 0;
    return a;
  }

  /* ------------------------------------------------------------------ physics */

  private heat(alpha: number, list?: number[]) {
    if (this.reduceMotion || !this.f) return;
    const was = this.sim.on;
    this.sim.alpha = Math.max(this.sim.alpha, alpha);
    this.sim.on = true;
    // a local reheat narrows a whole-vault settle still running: the drag matters more than the last of the settling
    if (list) (this.sim.all = false), (this.sim.list = list);
    else if (!was || this.sim.all) (this.sim.all = true), (this.VIS = this.f.movers());
    this.schedule();
  }
  private neighbours(i: number): number[] {
    const M = this.M!;
    return M.adj[i]!.map((e) => otherEnd(M, e, i));
  }
  /** A drag reheats what is near and what is linked, two steps out; the rest stays where it is. */
  private neighbourhood(i: number): number[] {
    const f = this.f!;
    const seen = new Uint8Array(f.n);
    const out = [i];
    seen[i] = 1;
    let frontier = [i];
    for (let hop = 0; hop < 2 && out.length < 1500; hop++) {
      const next: number[] = [];
      for (const fr of frontier) {
        const nb = this.neighbours(fr);
        for (let k = 0; k < nb.length && k < 60 && out.length < 1500; k++) {
          const j = nb[k]!;
          if (!seen[j] && f.ALPHA[j]! >= 0.05) (seen[j] = 1), out.push(j), next.push(j);
        }
      }
      frontier = next;
    }
    const x = f.X[i]!;
    const y = f.Y[i]!;
    const R = f.medSpc * 9;
    f.gridBuild(f.cs);
    const rc = Math.ceil(R / f.GS);
    const cx = f.cellOf(x);
    const cy = f.cellOf(y);
    for (let gy = Math.max(0, cy - rc); gy <= Math.min(f.GN - 1, cy + rc); gy++)
      for (let gx = Math.max(0, cx - rc); gx <= Math.min(f.GN - 1, cx + rc); gx++)
        for (let j = f.GH![gy * f.GN + gx]!; j >= 0; j = f.GNEXT[j]!) {
          if (seen[j]) continue;
          const dx = f.X[j]! - x;
          const dy = f.Y[j]! - y;
          if (dx * dx + dy * dy < R * R) (seen[j] = 1), out.push(j);
        }
    this.gridDirty = true;
    return out.filter((k) => !f.FIXD[k]);
  }

  /* --- the ripple: springs to home, coupled along the links */
  private activate(i: number) {
    if (!this.ACT[i]) {
      this.ACT[i] = 1;
      this.FX[i] = 0;
      this.FY[i] = 0;
      this.active.push(i);
    }
  }
  private stepSprings(dt: number) {
    const M = this.M!;
    const f = this.f!;
    const { DX, DY, SVX: VX, SVY: VY, FX, FY } = this;
    const { X, Y, RAD, ALPHA } = f;
    if (this.gridDirty) {
      f.gridBuild(Math.max(24, f.medSpc * 2.2), DX, DY);
      this.gridDirty = false;
    }
    const act = this.active;
    for (const i of act) (FX[i] = 0), (FY[i] = 0);
    const n0 = act.length;
    for (let q = 0; q < n0; q++) {
      const i = act[q]!;
      if (Math.abs(DX[i]!) + Math.abs(DY[i]!) < 3) continue;
      const px = X[i]! + DX[i]!;
      const py = Y[i]! + DY[i]!;
      const R = RAD[i]! + 1.6 * f.medSpc + 6;
      const rc = Math.ceil((R + 40) / f.GS);
      const cx = f.cellOf(px);
      const cy = f.cellOf(py);
      for (let gy = Math.max(0, cy - rc); gy <= Math.min(f.GN - 1, cy + rc); gy++)
        for (let gx = Math.max(0, cx - rc); gx <= Math.min(f.GN - 1, cx + rc); gx++)
          for (let j = f.GH![gy * f.GN + gx]!; j >= 0; j = f.GNEXT[j]!) {
            if (j === i) continue;
            const vx = X[j]! + DX[j]! - px;
            const vy = Y[j]! + DY[j]! - py;
            const d = Math.sqrt(vx * vx + vy * vy);
            const Rm = R + RAD[j]!;
            if (d >= Rm || d < 0.01) continue;
            // only what it has come closer to than at home: at rest nothing pushes
            const hx = X[j]! - X[i]!;
            const hy = Y[j]! - Y[i]!;
            const dh = Math.min(Rm, Math.sqrt(hx * hx + hy * hy));
            if (d >= dh) continue;
            const fo = (PA.push * (dh - d)) / Rm;
            this.activate(j);
            FX[j]! += (vx / d) * fo;
            FY[j]! += (vy / d) * fo;
          }
    }
    const keep: number[] = [];
    let q = 0;
    for (; q < this.active.length && q < 9000; q++) {
      const i = this.active[q]!;
      let mx = 0;
      let my = 0;
      let cnt = 0;
      const A = M.adj[i]!;
      for (const e of A) {
        const j = otherEnd(M, e, i);
        if (ALPHA[j]! < 0.05) continue;
        mx += DX[j]!;
        my += DY[j]!;
        cnt++;
      }
      let ax = FX[i]! - PA.home * DX[i]! - PA.damp * VX[i]!;
      let ay = FY[i]! - PA.home * DY[i]! - PA.damp * VY[i]!;
      if (cnt) (ax += PA.couple * (mx / cnt - DX[i]!)), (ay += PA.couple * (my / cnt - DY[i]!));
      VX[i]! += ax * dt;
      VY[i]! += ay * dt;
      DX[i]! += VX[i]! * dt;
      DY[i]! += VY[i]! * dt;
      const m2 = Math.abs(DX[i]!) + Math.abs(DY[i]!);
      if (m2 > 3)
        for (let k = 0; k < A.length && k < 120; k++) {
          const j = otherEnd(M, A[k]!, i);
          if (ALPHA[j]! >= 0.05) this.activate(j);
        }
      if (m2 > 0.1 || Math.abs(VX[i]!) + Math.abs(VY[i]!) > 1 || FX[i] || FY[i]) keep.push(i);
      else (DX[i] = 0), (DY[i] = 0), (VX[i] = 0), (VY[i] = 0), (this.ACT[i] = 0);
    }
    for (; q < this.active.length; q++) keep.push(this.active[q]!);
    this.active = keep;
  }
  /** Pointing at a file: what it links to leans in, and the springs carry it a step further. */
  private ripple(i: number) {
    const f = this.f;
    if (i < 0 || !f || this.ndrag || this.reduceMotion) return;
    const nb = this.neighbours(i);
    const px = f.X[i]! + this.DX[i]!;
    const py = f.Y[i]! + this.DY[i]!;
    const mx = Math.min(nb.length, 300);
    for (let q = 0; q < mx; q++) {
      const j = nb[q]!;
      if (f.ALPHA[j]! < 0.05) continue;
      const vx = px - f.X[j]! - this.DX[j]!;
      const vy = py - f.Y[j]! - this.DY[j]!;
      const d = Math.sqrt(vx * vx + vy * vy) || 1;
      const kick = Math.min(150, d * 0.9) * (nb.length > 40 ? 0.6 : 1);
      this.SVX[j]! += (vx / d) * kick;
      this.SVY[j]! += (vy / d) * kick;
      this.activate(j);
    }
    this.gridDirty = true;
    this.schedule();
  }

  private schedule() {
    if (!this.raf && this.visible && this.M) this.raf = requestAnimationFrame((t) => this.tick(t));
  }
  /** Runs only while something moves: the web settling, or the ripple's springs. */
  private tick(now: number) {
    this.raf = 0;
    const f = this.f;
    if (!this.M || !f || !this.visible) return;
    const dt = this.last ? Math.min(0.033, (now - this.last) / 1000) : 0.016;
    this.last = now;
    const springing = this.active.length > 0;
    const simming = this.sim.on && !this.anim;
    const t0 = performance.now();
    if (simming) {
      this.sim.alpha += (this.sim.target - this.sim.alpha) * PB.alphaDecay;
      f.step(this.sim.all ? this.VIS : this.sim.list, this.sim.alpha, this.sim.fixed);
      this.gridDirty = true;
      this.sim.frame++;
      if (this.sim.frame % 12 === 0) (this.orderCache = null), this.buildGrid();
      if (this.sim.alpha < 0.004 && this.sim.target === 0 && this.sim.fixed < 0) {
        this.sim.on = false;
        this.buildGrid();
        this.topicCentres();
        this.orderCache = null;
        for (const i of this.VIS) (f.VX[i] = 0), (f.VY[i] = 0);
        for (const i of this.sim.list) (f.VX[i] = 0), (f.VY[i] = 0);
        if (this.st.view === "kind") this.KB = [new Float32Array(f.X), new Float32Array(f.Y)];
      }
    }
    if (springing) {
      this.stepSprings(dt / 2); // two half steps: stiff springs stay stable
      this.stepSprings(dt / 2);
    }
    const t1 = performance.now();
    if (!this.anim && (springing || simming || this.ndrag)) {
      this.draw();
      this.perf.sim = t1 - t0;
      this.perf.draw = performance.now() - t1;
      this.perf.frames++;
      this.perf.nSim = simming ? (this.sim.all ? this.VIS.length : this.sim.list.length) : 0;
    }
    if (this.active.length || this.sim.on || this.ndrag) this.schedule();
    else this.last = 0;
  }

  /* ------------------------------------------------------------------ camera, hits */

  private scale() {
    return (this.Rpx / 1000) * this.st.cam.k;
  }
  private toScreen(wx: number, wy: number): [number, number] {
    const s = this.scale();
    return [this.W / 2 + (wx - this.st.cam.x) * s, this.H / 2 + (wy - this.st.cam.y) * s];
  }
  private toWorld(sx: number, sy: number): [number, number] {
    const s = this.scale();
    return [this.st.cam.x + (sx - this.W / 2) / s, this.st.cam.y + (sy - this.H / 2) / s];
  }
  private dotR(i: number) {
    return this.f!.RAD[i]! * (this.Rpx / 1000) * Math.pow(this.st.cam.k, 0.6);
  }
  private headR() {
    return clamp(64 * this.scale(), 22, 120);
  }
  /** Where things are now: home plus the spring offset; LX in the world, SX on screen. */
  private positions() {
    const f = this.f;
    if (!f) return;
    const s = this.scale();
    const ox = this.W / 2 - this.st.cam.x * s;
    const oy = this.H / 2 - this.st.cam.y * s;
    for (let i = 0; i < f.n; i++) {
      const x = f.X[i]! + this.DX[i]!;
      const y = f.Y[i]! + this.DY[i]!;
      this.LX[i] = x;
      this.LY[i] = y;
      this.SX[i] = ox + x * s;
      this.SY[i] = oy + y * s;
    }
  }
  private grid = new Map<number, number[]>();
  private static readonly GCELL = 40;
  private gkey(gx: number, gy: number) {
    return (gx + 1000) * 4096 + (gy + 1000);
  }
  private buildGrid() {
    const f = this.f;
    this.grid.clear();
    if (!f) return;
    const G = OrreryEngine.GCELL;
    for (let i = 0; i < f.n; i++) {
      if (f.ALPHA[i]! < 0.05) continue;
      const k = this.gkey(Math.floor(f.X[i]! / G), Math.floor(f.Y[i]! / G));
      const cell = this.grid.get(k);
      if (cell) cell.push(i);
      else this.grid.set(k, [i]);
    }
  }
  /** The file under a point: within 6 px of its dot; a small dot gets a 14 px reach (§2.16). */
  hit(sx: number, sy: number): number {
    const f = this.f;
    if (!this.M || !f || this.st.blank) return -1;
    this.positions();
    const w = this.toWorld(sx, sy);
    const s = this.scale();
    const G = OrreryEngine.GCELL;
    const reach = Math.max(G, 14 / s) + 20;
    let best = -1;
    let bd = Infinity;
    for (let gx = Math.floor((w[0] - reach) / G); gx <= Math.floor((w[0] + reach) / G); gx++)
      for (let gy = Math.floor((w[1] - reach) / G); gy <= Math.floor((w[1] + reach) / G); gy++) {
        const cell = this.grid.get(this.gkey(gx, gy));
        if (!cell) continue;
        for (const i of cell) {
          if (f.ALPHA[i]! < 0.3) continue;
          const dx = (this.LX[i]! - w[0]) * s;
          const dy = (this.LY[i]! - w[1]) * s;
          const r = this.dotR(i);
          const d = Math.sqrt(dx * dx + dy * dy) - r;
          if (d < Math.max(6, 14 - r) && d < bd) (bd = d), (best = i);
        }
      }
    return best;
  }

  /* ------------------------------------------------------------------ drawing */

  private focusOf(): number {
    const S = this.st.view === "steps" ? this.S : null;
    if (S) return this.st.hover >= 0 && this.st.hover !== S.center ? this.st.hover : this.st.sel !== S.center ? this.st.sel : -1;
    return this.st.sel >= 0 ? this.st.sel : this.st.hover;
  }
  private hoverMatters() {
    return this.st.sel < 0 || (this.st.view === "steps" && !!this.S && this.st.sel === this.S.center);
  }
  /** In Steps, names drop the middle's own name. */
  shortName(i: number): string {
    const nm = this.M!.nodes[i]!.name;
    if (this.st.view !== "steps" || !this.S || i === this.S.center) return nm;
    const c = this.M!.nodes[this.S.center]!.name;
    const out = nm.replace(` · ${c}`, "").replace(`${c}: `, "");
    return out.length >= 3 ? out : nm;
  }
  private measure(ctx: Ctx, font: string, text: string): number {
    const key = `${font}\0${text}`;
    let w = this.textW.get(key);
    if (w === undefined) {
      ctx.font = font;
      w = ctx.measureText(text).width;
      if (this.textW.size > 20000) this.textW.clear();
      this.textW.set(key, w);
    }
    return w;
  }

  draw(): void {
    const ctx = this.ctx;
    if (!ctx || !this.W) return;
    const C = this.colors;
    ctx.setTransform(this.DPR, 0, 0, this.DPR, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = C.surface; // the map is a box on the ground
    ctx.fillRect(0, 0, this.W, this.H);
    const s = this.scale();
    const c0 = this.toScreen(0, 0);
    const f = this.f;
    if (!this.M || !f || this.st.blank) {
      ctx.strokeStyle = C.ink3;
      ctx.globalAlpha = 0.2;
      ctx.setLineDash([2, 5]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const r of [BAND.proj[1] + 12, BAND.ppl[1] + 16, BAND.note[1] + 12]) {
        ctx.moveTo(c0[0] + r * s, c0[1]);
        ctx.arc(c0[0], c0[1], r * s, 0, TAU);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = this.st.blank === "error" ? 0.28 : 1;
      this.drawHead(ctx, c0[0], c0[1], this.headR());
      ctx.globalAlpha = 1;
      return;
    }
    const M = this.M;
    const K = this.K!;
    const { ALPHA } = f;
    this.positions();
    const focus = this.focusOf();
    let hi: Uint8Array | null = null;
    if (focus >= 0) {
      hi = new Uint8Array(M.nodes.length);
      hi[focus] = 1;
      for (const o of this.neighbours(focus)) hi[o] = 1;
    }
    const S = this.st.view === "steps" ? this.S : null;
    const boxes: number[][] = [];

    // guides: the rings, dotted
    ctx.lineWidth = 1;
    ctx.strokeStyle = C.ink3;
    ctx.globalAlpha = 0.22;
    ctx.setLineDash([2, 5]);
    ctx.beginPath();
    for (const r of S ? [S.r1b + 30, 945] : [BAND.proj[1] + 12, BAND.ppl[1] + 16, BAND.note[1] + 12]) {
      ctx.moveTo(c0[0] + r * s, c0[1]);
      ctx.arc(c0[0], c0[1], r * s, 0, TAU);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    if (!S) {
      // the rim: one arc per life area, in its colour
      ctx.lineCap = "round";
      ctx.lineWidth = Math.max(3, 3.5 * Math.min(2, Math.sqrt(this.st.cam.k)));
      K.areaSpan.forEach((sp, ai) => {
        if (!M.areaCount[ai]) return;
        ctx.strokeStyle = C.area[ai]!;
        ctx.globalAlpha = this.st.area >= 0 && this.st.area !== ai ? 0.35 : 1;
        ctx.beginPath();
        ctx.arc(c0[0], c0[1], BAND.rim * s, sp[0] + 0.004, sp[1] - 0.004);
        ctx.stroke();
      });
      ctx.globalAlpha = 1;
      ctx.lineCap = "butt";
    }

    // the web: the strongest links; then all of the focused file's own
    this.drawWeb(ctx, focus, !!S);
    if (focus >= 0) {
      // many lines thin out, so a busy thing shows a fan and not a black bundle
      const nAdj = M.adj[focus]!.length;
      const la = clamp(0.75 * Math.sqrt(14 / Math.max(1, nAdj)), 0.25, 0.75);
      const lw = nAdj > 24 ? 1.1 : 1.6;
      const pull = S ? 0.9 : 0.5;
      const px = this.SX[focus]!;
      const py = this.SY[focus]!;
      ctx.strokeStyle = C.ink;
      ctx.globalAlpha = la;
      for (const typed of [true, false]) {
        ctx.beginPath();
        for (const e of M.adj[focus]!) {
          if (M.rels[M.er[e]!]!.typed !== typed) continue;
          const o = otherEnd(M, e, focus);
          if (ALPHA[o]! < 0.05) continue;
          const qx = this.SX[o]!;
          const qy = this.SY[o]!;
          ctx.moveTo(px, py);
          ctx.quadraticCurveTo(c0[0] + ((px + qx) / 2 - c0[0]) * pull, c0[1] + ((py + qy) / 2 - c0[1]) * pull, qx, qy);
        }
        ctx.lineWidth = typed ? lw : Math.min(1.1, lw);
        ctx.setLineDash(typed ? [] : [3, 4]);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }

    // dots: the many small ones in batches by colour and strength, the larger glyphs one by one
    const pad = 30;
    const batches = new Map<string, { color: string; alpha: number; pts: number[] }>();
    const big: [number, number][] = [];
    for (let i = 0; i < M.nodes.length; i++) {
      if (ALPHA[i]! < 0.03) continue;
      const x = this.SX[i]!;
      const y = this.SY[i]!;
      if (x < -pad || x > this.W + pad || y < -pad || y > this.H + pad) continue;
      const d = M.nodes[i]!;
      let al = ALPHA[i]!;
      if (hi && !hi[i]) al *= 0.22;
      else if (!hi && this.st.area >= 0 && d.area !== this.st.area && !S) al *= 0.25;
      const r = this.dotR(i);
      if (d.t === 3 || d.t === 5 || (r < 3.4 && (d.t === 1 || d.t === 2 || d.t === 4))) {
        let color: string;
        if (d.t === 3) color = d.tone === 0 ? C.ink : d.tone === 1 ? C.ink2 : C.ink3;
        else if (d.t === 5) (color = C.ink3), (al *= 0.5);
        else color = d.t === 4 || d.tone === 2 ? C.ink3 : C.ink2;
        if (d.tone === 2 && d.t !== 5) al *= 0.8;
        const key = `${color}|${Math.round(al * 40)}`;
        let b = batches.get(key);
        if (!b) batches.set(key, (b = { color, alpha: Math.round(al * 40) / 40, pts: [] }));
        b.pts.push(i);
      } else big.push([i, al]);
    }
    for (const b of batches.values()) {
      ctx.globalAlpha = b.alpha;
      ctx.fillStyle = b.color;
      ctx.beginPath();
      for (const i of b.pts) {
        const r = this.dotR(i);
        const x = this.SX[i]!;
        const y = this.SY[i]!;
        if (M.nodes[i]!.t === 2) ctx.rect(x - r, y - r, r * 2, r * 2);
        else {
          ctx.moveTo(x + r, y);
          ctx.arc(x, y, r, 0, TAU);
        }
      }
      ctx.fill();
    }
    for (const [i, al] of big) {
      ctx.globalAlpha = al;
      this.drawGlyph(ctx, i, this.SX[i]!, this.SY[i]!, this.dotR(i));
    }
    ctx.globalAlpha = 1;
    // the selection ring
    if (this.st.sel >= 0 && ALPHA[this.st.sel]! > 0.05) {
      ctx.strokeStyle = C.accent;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(this.SX[this.st.sel]!, this.SY[this.st.sel]!, this.dotR(this.st.sel) + 6, 0, TAU);
      ctx.stroke();
    }
    // Orr in the middle (Kind)
    if (!S) {
      const hr = this.headR();
      ctx.fillStyle = C.surface;
      ctx.beginPath();
      ctx.arc(c0[0], c0[1], hr * 1.18, 0, TAU);
      ctx.fill();
      this.drawHead(ctx, c0[0], c0[1], hr);
      boxes.push([c0[0] - hr * 1.2, c0[1] - hr * 1.2, c0[0] + hr * 1.2, c0[1] + hr * 1.2]);
    }
    this.drawLabels(ctx, focus, hi, S, s, c0, boxes);
  }

  /** Names, most important first, never on top of each other, never under the controls. */
  private drawLabels(ctx: Ctx, focus: number, hi: Uint8Array | null, S: StepsLayout | null, s: number, c0: [number, number], boxes: number[][]) {
    const M = this.M!;
    const K = this.K!;
    const f = this.f!;
    const C = this.colors;
    const { W, H } = this;
    for (const b of this.obstacles) boxes.push([b.left - 4, b.top - 4, b.right + 4, b.bottom + 4]);
    type Cand = { t: string; x: number; y: number; size: number; w: number; c: string; p: number; a: "c" | "l" | "r"; k: "area" | "cl" | "grp" | "sel" | "nb" | "item"; target?: ["area" | "topic" | "file", number]; proj?: boolean; ring?: number };
    const cands: Cand[] = [];
    const cam = this.st.cam.k;
    if (!S) {
      // on a narrow screen the area names sit just inside the rim, so none falls off the edge
      const narrow = W < 560;
      K.areaSpan.forEach((sp, ai) => {
        if (!M.areaCount[ai]) return;
        const am = (sp[0] + sp[1]) / 2;
        const rr = narrow ? BAND.note[1] * s - 4 : BAND.rim * s + 18;
        const a = narrow ? "c" : Math.cos(am) > 0.3 ? "l" : Math.cos(am) < -0.3 ? "r" : "c";
        cands.push({ t: `${M.areas[ai]!.name}  ${fmt(M.areaCount[ai]!)}`, x: c0[0] + Math.cos(am) * rr, y: c0[1] + Math.sin(am) * rr + 4, size: narrow ? 12 : 13, w: 750, c: narrow ? C.ink : C.ink2, p: 1000, a, k: "area", target: ["area", ai] });
      });
      // topics: name and count, where their notes gather
      for (const c of M.topics) {
        if (!c.n) continue;
        const sp = K.topicSpan[c.id]!;
        const am = (sp[0] + sp[1]) / 2;
        const arcLen = (((sp[1] - sp[0]) * (BAND.note[0] + BAND.note[1])) / 2) * s;
        if (!(arcLen > 26 || cam > 1.6) || (this.st.area >= 0 && c.area !== this.st.area)) continue;
        // neighbouring topics take turns, nearer and further out, so more names fit
        const kth = M.areaTopics[c.area]!.indexOf(c.id);
        const rr = (BAND.note[0] + (0.34 + 0.32 * (kth % 2)) * (BAND.note[1] - BAND.note[0])) * s;
        let lx = c0[0] + Math.cos(am) * rr;
        let ly = c0[1] + Math.sin(am) * rr + 4;
        if (this.TCX && !this.anim && !Number.isNaN(this.TCX[c.id]!)) {
          const p = this.toScreen(this.TCX[c.id]!, this.TCY![c.id]!);
          lx = p[0];
          ly = p[1] + 4;
        }
        cands.push({ t: `${c.name}  ${fmt(c.n)}`, x: lx, y: ly, size: 12.5, w: 700, c: C.ink, p: 600 + Math.min(300, c.n), a: "c", k: "cl", target: ["topic", c.id] });
      }
    } else {
      for (const g of S.order) {
        const sp = S.spans.get(g)!;
        const am = (sp[0] + sp[1]) / 2;
        const rr = (S.r1b + 30) * s;
        const a = Math.cos(am) > 0.3 ? "l" : Math.cos(am) < -0.3 ? "r" : "c";
        cands.push({ t: `${g}  ${fmt(S.groups.get(g)!.length)}`, x: c0[0] + Math.cos(am) * rr, y: c0[1] + Math.sin(am) * rr + 4, size: 12.5, w: 700, c: C.ink, p: 1000, a, k: "grp" });
      }
      cands.push({ t: M.nodes[S.center]!.name, x: this.SX[S.center]!, y: this.SY[S.center]! - this.dotR(S.center) - 12, size: 15, w: 750, c: C.ink, p: 2100, a: "c", k: "sel", target: ["file", S.center] });
    }
    if (focus >= 0 && f.ALPHA[focus]! > 0.05) {
      cands.push({ t: this.shortName(focus), x: this.SX[focus]!, y: this.SY[focus]! - this.dotR(focus) - 11, size: 14, w: 750, c: C.ink, p: 2000, a: "c", k: "sel", target: ["file", focus] });
      this.neighbours(focus)
        .sort((a, b) => M.nodes[b]!.deg - M.nodes[a]!.deg || a - b)
        .slice(0, 26)
        .forEach((o, k) => {
          if (f.ALPHA[o]! < 0.05) return;
          cands.push({ t: this.shortName(o), x: this.SX[o]!, y: this.SY[o]! + this.dotR(o) + 13, size: 12, w: 650, c: C.ink, p: 1500 - k, a: "c", k: "nb", target: ["file", o] });
        });
    }
    // the biggest things get names, more of them as you zoom in
    const budget = S ? Math.round(clamp(36 * cam, 36, 400)) : Math.round(clamp(14 * cam * cam, 14, 400));
    const projCap = S ? 1e9 : Math.round(clamp(5 * cam * cam, 5, 400));
    // in Steps a few names are kept for what ring 1 shares, so the far ring is never anonymous
    const r2cap = S ? Math.round(clamp(8 * cam * cam, 8, 300)) : 0;
    const r1cap = S ? budget - Math.min(r2cap, S.strong.length) : 1e9;
    let order: number[];
    if (S) {
      order = S.ring1.slice().sort((a, b) => M.nodes[b]!.deg - M.nodes[a]!.deg || a - b);
      order = order.concat(S.strong.slice().sort((a, b) => S.VIA[b]! - S.VIA[a]! || M.nodes[b]!.deg - M.nodes[a]!.deg || a - b).slice(0, r2cap));
    } else if (this.orderCache && !this.anim) order = this.orderCache;
    else {
      order = [];
      for (let j = 0; j < M.nodes.length; j++) if (f.ALPHA[j]! > 0.5) order.push(j);
      const weight = (i: number) => {
        const d = M.nodes[i]!;
        return d.deg * (d.t === 0 ? 4 : d.t === 2 ? 2.5 : d.t === 1 ? 1.6 : 1);
      };
      order.sort((a, b) => weight(b) - weight(a) || a - b);
      if (!this.anim) this.orderCache = order;
    }
    for (let q = 0; q < order.length && q < budget * 3; q++) {
      const id = order[q]!;
      if (id === focus || (S && id === S.center)) continue;
      if (hi && !hi[id]) continue;
      if (!hi && !S && this.st.area >= 0 && M.nodes[id]!.area !== this.st.area) continue;
      if (f.ALPHA[id]! < 0.3) continue;
      const x = this.SX[id]!;
      const y = this.SY[id]!;
      if (x < 0 || x > W || y < 0 || y > H) continue;
      const nd = M.nodes[id]!;
      cands.push({ t: this.shortName(id), x, y: y + this.dotR(id) + 13, size: nd.t === 0 ? 12.5 : 11.5, w: nd.t === 0 ? 700 : 600, c: nd.t === 3 || nd.t === 4 ? C.ink2 : C.ink, p: 400 - q, a: "c", k: "item", target: ["file", id], proj: nd.t === 0, ring: S ? S.ON[id] : 0 });
    }
    cands.sort((a, b) => b.p - a.p);
    let placed = 0;
    let projN = 0;
    let r1N = 0;
    let r2N = 0;
    this.labelTargets = [];
    ctx.textBaseline = "alphabetic";
    ctx.lineJoin = "round";
    for (const cd of cands) {
      if (cd.k === "item" && (placed > budget || (cd.proj && projN >= projCap) || (cd.ring === 1 && r1N >= r1cap) || (cd.ring === 2 && r2N >= r2cap))) continue;
      const font = `${cd.w} ${cd.size}px ${C.font}`;
      const tw = this.measure(ctx, font, cd.t);
      let x0 = cd.a === "l" ? cd.x : cd.a === "r" ? cd.x - tw : cd.x - tw / 2;
      if (cd.k === "area") x0 = clamp(x0, 6, W - tw - 6); // area names slide along the edge rather than drop
      const plate = cd.k === "cl" || cd.k === "grp";
      const box = plate ? [x0 - 9, cd.y - cd.size - 4, x0 + tw + 9, cd.y + 9] : cd.k === "item" ? [x0 - 6, cd.y - cd.size - 2, x0 + tw + 6, cd.y + 6] : [x0 - 3, cd.y - cd.size, x0 + tw + 3, cd.y + 4];
      if ((box[0]! < 2 || box[2]! > W - 2 || box[1]! < 2 || box[3]! > H - 2) && cd.k !== "sel") continue;
      let clash = false;
      for (const o of boxes) {
        if (!(box[2]! < o[0]! || box[0]! > o[2]! || box[3]! < o[1]! || box[1]! > o[3]!)) {
          clash = true;
          break;
        }
      }
      if (clash && cd.k !== "sel") continue;
      boxes.push(box);
      if (cd.target) this.labelTargets.push([{ left: box[0]!, top: box[1]!, right: box[2]!, bottom: box[3]! }, cd.target]);
      ctx.font = font;
      if (plate) {
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = C.surface;
        this.roundRect(ctx, x0 - 7, cd.y - cd.size - 2, tw + 14, cd.size + 9, 6);
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = C.line2;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = cd.c;
        ctx.fillText(cd.t, x0, cd.y);
        continue;
      }
      ctx.lineWidth = 4;
      ctx.strokeStyle = C.surface;
      ctx.strokeText(cd.t, x0, cd.y);
      ctx.fillStyle = cd.c;
      ctx.fillText(cd.t, x0, cd.y);
      if (cd.k === "item") {
        placed++;
        if (cd.proj) projN++;
        if (cd.ring === 1) r1N++;
        if (cd.ring === 2) r2N++;
      }
    }
  }

  /** Only the strongest links, about 1,200 on screen, more as you zoom in: two strokes in all. */
  private drawWeb(ctx: Ctx, focus: number, steps: boolean) {
    const M = this.M!;
    const f = this.f!;
    const E = this.WORDER.length;
    const budget = Math.round(WEB_BUDGET * clamp((this.W * this.H) / (960 * 820), 0.25, 1.4) * Math.pow(this.st.cam.k, 0.8));
    let base = clamp(0.2 * Math.sqrt(600 / Math.max(300, Math.min(budget, E))) * Math.pow(this.st.cam.k, 0.3), 0.07, 0.2);
    if (focus >= 0) base *= 0.45;
    if (steps) base *= 0.6;
    const c = steps && this.S ? this.S.center : -1;
    const { SX, SY, W, H } = this;
    const { ALPHA } = f;
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.strokeStyle = this.colors.ink;
    let drawn = 0;
    for (let pass = 0; pass < 2; pass++) {
      ctx.beginPath();
      drawn = 0;
      for (let q = 0; q < E && drawn < budget; q++) {
        const i = this.WORDER[q]!;
        const a = M.ea[i]!;
        const b = M.eb[i]!;
        if (ALPHA[a]! < 0.3 || ALPHA[b]! < 0.3) continue;
        const x1 = SX[a]!;
        const y1 = SY[a]!;
        const x2 = SX[b]!;
        const y2 = SY[b]!;
        if ((x1 < 0 && x2 < 0) || (x1 > W && x2 > W) || (y1 < 0 && y2 < 0) || (y1 > H && y2 > H)) continue;
        drawn++;
        if (M.rels[M.er[i]!]!.typed !== (pass === 1)) continue;
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
      }
      // in Steps the middle's own links are always there
      if (c >= 0 && pass === 1)
        for (const e of M.adj[c]!) {
          const o = otherEnd(M, e, c);
          if (ALPHA[o]! < 0.3) continue;
          ctx.moveTo(SX[c]!, SY[c]!);
          ctx.lineTo(SX[o]!, SY[o]!);
        }
      ctx.globalAlpha = pass === 1 ? Math.min(0.36, base * 1.6) : base;
      ctx.stroke();
    }
    this.perf.webDrawn = drawn;
    ctx.globalAlpha = 1;
  }
  private roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  /** A project is a progress ring, a person a ring, a company a rounded square, a conversation an open circle. */
  private drawGlyph(ctx: Ctx, i: number, x: number, y: number, r: number) {
    const d = this.M!.nodes[i]!;
    const C = this.colors;
    if (d.t === 0) {
      const w = Math.max(1.6, r * 0.34);
      const p = d.project;
      const prog = p && p.total ? p.done / p.total : 0;
      ctx.lineWidth = w;
      ctx.strokeStyle = C.line2;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TAU);
      ctx.stroke();
      if (prog > 0) {
        ctx.strokeStyle = p?.status === "at risk" ? C.warn : !p?.status || p.status === "on track" || p.status === "completed" ? C.prog : C.ink3;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.arc(x, y, r, -Math.PI / 2, -Math.PI / 2 + TAU * prog);
        ctx.stroke();
        ctx.lineCap = "butt";
      }
      ctx.fillStyle = C.surface;
      ctx.beginPath();
      ctx.arc(x, y, r - w / 2, 0, TAU);
      ctx.fill();
    } else if (d.t === 1 || d.t === 2) {
      ctx.fillStyle = C.surface;
      ctx.strokeStyle = C.ink2;
      ctx.lineWidth = r > 7 ? 1.6 : 1.2;
      if (d.t === 1) {
        ctx.beginPath();
        ctx.arc(x, y, r, 0, TAU);
      } else this.roundRect(ctx, x - r, y - r, r * 2, r * 2, r * 0.3);
      ctx.fill();
      ctx.stroke();
      if (r >= 9) {
        const parts = d.name.trim().split(/\s+/);
        const ini = ((parts[0]?.[0] ?? "") + (parts.length > 1 ? (parts[parts.length - 1]![0] ?? "") : "")).toUpperCase();
        ctx.fillStyle = C.ink2;
        ctx.font = `700 ${Math.round(r * 0.78)}px ${C.font}`;
        ctx.textAlign = "center";
        ctx.fillText(ini, x, y + r * 0.28);
        ctx.textAlign = "start";
      }
    } else {
      ctx.strokeStyle = C.ink2;
      ctx.lineWidth = Math.max(1, r * 0.4);
      ctx.beginPath();
      ctx.arc(x, y, Math.max(1.2, r * 0.8), 0, TAU);
      ctx.stroke();
    }
  }
  private drawHead(ctx: Ctx, cx: number, cy: number, r: number) {
    if (!this.headPath) {
      ctx.fillStyle = HEAD_STOPS[4]!;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, TAU);
      ctx.fill();
      return;
    }
    const k = r / 79.28;
    ctx.save();
    ctx.translate(cx - 351.6 * k, cy - 142.85 * k);
    ctx.scale(k, k);
    const g = ctx.createLinearGradient(294.27, 94.31, 410.06, 190.38);
    HEAD_STOPS.forEach((c, i) => g.addColorStop(i / 8, c));
    ctx.fillStyle = g;
    ctx.fill(this.headPath, "evenodd");
    ctx.restore();
  }

  /** Where each topic's notes are now, for its name. */
  private topicCentres() {
    const M = this.M!;
    const f = this.f!;
    const m = M.topics.length;
    const sx = new Float64Array(m);
    const sy = new Float64Array(m);
    const c = new Float64Array(m);
    for (let i = 0; i < f.n; i++) {
      const d = M.nodes[i]!;
      if (d.t !== 3 || f.ALPHA[i]! < 0.5) continue;
      sx[d.cl]! += f.X[i]!;
      sy[d.cl]! += f.Y[i]!;
      c[d.cl]!++;
    }
    this.TCX = new Float32Array(m);
    this.TCY = new Float32Array(m);
    for (let k = 0; k < m; k++) {
      this.TCX[k] = c[k] ? sx[k]! / c[k]! : NaN;
      this.TCY[k] = c[k] ? sy[k]! / c[k]! : NaN;
    }
  }

  /* ------------------------------------------------------------------ transitions */

  private animateTo(tx: Float32Array, ty: Float32Array, trad: Float32Array, talpha: Float32Array, cam: Cam | null, done?: () => void, o: { delay?: Float32Array; dur?: number; back?: boolean } = {}) {
    const f = this.f!;
    this.orderCache = null;
    const n = f.n;
    const fx = new Float32Array(f.X);
    const fy = new Float32Array(f.Y);
    const fr = new Float32Array(f.RAD);
    const fa = new Float32Array(f.ALPHA);
    tx = new Float32Array(tx);
    ty = new Float32Array(ty);
    trad = new Float32Array(trad);
    talpha = new Float32Array(talpha);
    const c0 = { ...this.st.cam };
    const t0 = performance.now();
    const dur = this.reduceMotion || !this.visible ? 0 : (o.dur ?? 520);
    const dl = o.delay;
    let maxDl = 0;
    if (dl) for (let k = 0; k < dl.length; k++) if (dl[k]! > maxDl) maxDl = dl[k]!;
    if (this.anim) cancelAnimationFrame(this.anim);
    this.anim = 0;
    const finish = () => {
      this.anim = 0;
      this.orderCache = null;
      this.gridDirty = true;
      this.buildGrid();
      this.rehover();
      this.draw();
      this.schedule();
      done?.();
    };
    if (!dur) {
      f.X.set(tx);
      f.Y.set(ty);
      f.RAD.set(trad);
      f.ALPHA.set(talpha);
      if (cam) this.st.cam = { ...cam };
      finish();
      return;
    }
    const step = (now: number) => {
      const T = clamp((now - t0) / (dur + maxDl), 0, 1);
      const E = ease(T);
      for (let i = 0; i < n; i++) {
        const t = dl ? clamp((now - t0 - dl[i]!) / dur, 0, 1) : clamp((now - t0) / dur, 0, 1);
        const e = o.back ? back(t) : ease(t);
        const ea = ease(t);
        f.X[i] = fx[i]! + (tx[i]! - fx[i]!) * e;
        f.Y[i] = fy[i]! + (ty[i]! - fy[i]!) * e;
        f.RAD[i] = fr[i]! + (trad[i]! - fr[i]!) * ea;
        f.ALPHA[i] = fa[i]! + (talpha[i]! - fa[i]!) * ea;
      }
      if (cam) this.st.cam = { x: c0.x + (cam.x - c0.x) * E, y: c0.y + (cam.y - c0.y) * E, k: c0.k + (cam.k - c0.k) * E };
      this.draw();
      if (T < 1) this.anim = requestAnimationFrame(step);
      else finish();
    };
    this.anim = requestAnimationFrame(step);
  }

  /** Opening: every file comes out of Orr to its place, projects first, the rim last. */
  private assemble() {
    const M = this.M!;
    const f = this.f!;
    const n = f.n;
    const tx = new Float32Array(f.X);
    const ty = new Float32Array(f.Y);
    const tr = new Float32Array(this.K!.RAD);
    const ta = this.kindAlpha();
    const delay = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = M.nodes[i]!.t;
      const ring = t === 0 ? 0 : t === 1 || t === 2 ? 1 : t === 5 ? 3 : 2;
      delay[i] = ring * 140 + hash(i, 5) * 260;
      const a = Math.atan2(ty[i]!, tx[i]!);
      f.X[i] = Math.cos(a) * 40;
      f.Y[i] = Math.sin(a) * 40;
      f.RAD[i] = this.K!.RAD[i]! * 0.4;
      f.ALPHA[i] = 0;
    }
    // the web keeps settling for a moment after it lands
    this.animateTo(tx, ty, tr, ta, null, () => this.heat(0.08), { delay, dur: 760, back: true });
  }

  /** Loading: files arrive projects first, each out of Orr to its place, with a count. */
  private startReveal() {
    const M = this.M!;
    const f = this.f!;
    const K = this.K!;
    const n = f.n;
    const ka = this.kindAlpha();
    const keys = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const d = M.nodes[i]!;
      const ring = d.t === 0 ? 0 : d.t === 1 || d.t === 2 ? 1 : 2;
      keys[i] = ring + hash(i, 13) * 0.999 + (ring === 2 ? hash(d.cl, 3) * 0.3 : 0);
    }
    const ord = Array.from({ length: n }, (_, j) => j).sort((a, b) => keys[a]! - keys[b]!);
    const dur = this.reduceMotion || !this.visible ? 0 : REVEAL_MS;
    const dl = new Float32Array(n);
    ord.forEach((j, r) => (dl[j] = (r / n) * dur));
    let total = 0;
    for (let i = 0; i < n; i++) if (ka[i]) total++;
    const hx = new Float32Array(f.X);
    const hy = new Float32Array(f.Y);
    const t0 = performance.now();
    this.reveal = { got: 0, total };
    this.changed();
    const frame = (now: number) => {
      const r = this.reveal;
      if (!r || this.f !== f) return;
      const el = now - t0;
      const done = !dur || el > dur + 700;
      let got = 0;
      for (let i = 0; i < n; i++) {
        const p = done ? 1 : clamp((el - dl[i]!) / 700, 0, 1);
        if (p > 0.5 && ka[i]) got++;
        const e = p === 0 ? 0 : back(p);
        const a = Math.atan2(hy[i]!, hx[i]!);
        f.X[i] = Math.cos(a) * 40 + (hx[i]! - Math.cos(a) * 40) * e;
        f.Y[i] = Math.sin(a) * 40 + (hy[i]! - Math.sin(a) * 40) * e;
        f.RAD[i] = K.RAD[i]! * (0.4 + 0.6 * Math.min(1, p));
        f.ALPHA[i] = ka[i]! * Math.min(1, p * 1.6);
      }
      const before = r.got;
      r.got = Math.min(got, r.total);
      this.orderCache = null;
      if (done) {
        this.anim = 0;
        this.reveal = null;
        f.X.set(hx);
        f.Y.set(hy);
        this.buildGrid();
        this.topicCentres();
        this.changed();
        this.draw();
        this.heat(0.08);
        return;
      }
      this.draw();
      if (Math.floor(r.got / 20) !== Math.floor(before / 20)) this.changed();
      this.anim = requestAnimationFrame(frame);
    };
    if (!dur) frame(t0 + 1e9);
    else this.anim = requestAnimationFrame(frame);
  }

  private goSteps(i: number) {
    const M = this.M!;
    const f = this.f!;
    if (this.st.view === "kind" && !this.anim) this.KB = [new Float32Array(f.X), new Float32Array(f.Y)];
    const lite = this.W > 0 && this.W < 560;
    const S = (this.S = layoutSteps(M, i, (j) => this.shown(j)));
    this.st.view = "steps";
    this.st.center = i;
    this.st.sel = i;
    this.st.area = -1;
    this.st.topic = -1;
    this.backTo = null;
    this.sim.on = false;
    f.domainsSteps(S);
    const n = f.n;
    const ta = new Float32Array(n);
    const tx = new Float32Array(n);
    const ty = new Float32Array(n);
    const tr = new Float32Array(n);
    const dl = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      if (S.ON[k]) {
        tx[k] = S.X[k]!;
        ty[k] = S.Y[k]!;
        tr[k] = S.RAD[k]!;
        // the phone shows ring 1 and only what ring 1 shares
        ta[k] = S.ON[k] === 2 && S.VIA[k]! < 2 ? (lite ? 0 : 0.55) : 1;
        dl[k] = S.ON[k] === 3 ? 0 : (S.ON[k] === 1 ? 90 : 220) + hash(k, 3) * 120;
      } else {
        tx[k] = f.X[k]! * 1.25;
        ty[k] = f.Y[k]! * 1.25;
        tr[k] = f.RAD[k]!;
        ta[k] = 0;
      }
    }
    this.DX.fill(0);
    this.DY.fill(0);
    this.SVX.fill(0);
    this.SVY.fill(0);
    this.ACT.fill(0);
    this.active = [];
    this.animateTo(tx, ty, tr, ta, { x: 0, y: 0, k: 1 }, () => this.heat(0.06), { delay: dl, back: true, dur: 620 });
    this.changed();
  }
  private goKind(keepSel: boolean) {
    const M = this.M!;
    const f = this.f!;
    this.st.view = "kind";
    this.st.center = -1;
    this.S = null;
    if (!keepSel) this.st.sel = -1;
    const dl = new Float32Array(f.n);
    for (let k = 0; k < f.n; k++) {
      const t = M.nodes[k]!.t;
      dl[k] = (t === 0 ? 0 : t === 1 || t === 2 ? 70 : 140) + hash(k, 4) * 120;
    }
    this.sim.on = false;
    f.domainsKind(this.K!);
    const home = this.KB ?? [this.K!.X, this.K!.Y];
    this.animateTo(home[0], home[1], this.K!.RAD, this.kindAlpha(), { x: 0, y: 0, k: 1 }, () => (this.heat(0.05), this.topicCentres()), { delay: dl, back: true, dur: 620 });
    this.changed();
  }
  // going into an area or a topic remembers where you were, so Back (or Esc, or Orr) brings it back
  private remember() {
    if (this.st.area < 0 && this.st.topic < 0) this.backTo = { sel: this.st.sel, cam: { ...this.st.cam } };
  }
  private backToVault() {
    const f = this.f!;
    const b = this.backTo ?? { sel: -1, cam: { x: 0, y: 0, k: 1 } };
    this.st.area = -1;
    this.st.topic = -1;
    this.backTo = null;
    if (this.st.sel < 0) this.st.sel = b.sel;
    this.animateTo(f.X, f.Y, f.RAD, f.ALPHA, b.cam);
    this.changed();
  }
  private zoomToArea(ai: number) {
    const f = this.f!;
    this.remember();
    this.st.topic = -1;
    this.st.sel = -1;
    const sp = this.K!.areaSpan[ai]!;
    const am = (sp[0] + sp[1]) / 2;
    const w = sp[1] - sp[0];
    const rr = (BAND.ppl[0] + BAND.rim) / 2;
    const k = clamp(1.25 / Math.max(0.35, Math.sin(Math.min(Math.PI / 2, w / 2))), 1.4, 3.2);
    this.st.area = ai;
    this.animateTo(f.X, f.Y, f.RAD, f.ALPHA, { x: Math.cos(am) * rr, y: Math.sin(am) * rr, k });
    this.changed();
  }
  private zoomToTopic(cid: number) {
    const f = this.f!;
    this.remember();
    this.st.topic = cid;
    this.st.area = this.M!.topics[cid]!.area;
    this.st.sel = -1;
    const sp = this.K!.topicSpan[cid]!;
    const am = (sp[0] + sp[1]) / 2;
    const rr = (BAND.note[0] + BAND.note[1]) / 2;
    const w = (sp[1] - sp[0]) * rr;
    let tx = Math.cos(am) * rr;
    let ty = Math.sin(am) * rr;
    if (this.TCX && !Number.isNaN(this.TCX[cid]!)) (tx = this.TCX[cid]!), (ty = this.TCY![cid]!);
    this.animateTo(f.X, f.Y, f.RAD, f.ALPHA, { x: tx, y: ty, k: clamp(900 / Math.max(200, w + 250), 1.8, 5) });
    this.changed();
  }
  private rehover() {
    if (!this.lastPtr || this.ndrag || this.pan) return;
    const h = this.hit(this.lastPtr[0], this.lastPtr[1]);
    if (h !== this.st.hover) {
      this.st.hover = h;
      this.setCursor(h >= 0 ? "grab" : "default");
      this.ripple(h);
    }
  }

  /* ------------------------------------------------------------------ pointer, wheel */

  private setCursor(c: string) {
    if (c !== this.cursor) (this.cursor = c), (this.canvas.style.cursor = c);
  }
  private local(ev: { clientX: number; clientY: number }): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [ev.clientX - r.left, ev.clientY - r.top];
  }
  private listen() {
    const c = this.canvas;
    const on = <K extends keyof HTMLElementEventMap>(type: K, fn: (e: HTMLElementEventMap[K]) => void, o?: AddEventListenerOptions) => {
      c.addEventListener(type, fn as EventListener, o);
      this.cleanup.push(() => c.removeEventListener(type, fn as EventListener, o));
    };
    on("pointerdown", (ev) => this.onDown(ev));
    on("pointermove", (ev) => this.onMove(ev));
    on("pointerup", (ev) => this.onUp(ev));
    on("pointercancel", () => this.onCancel());
    on("pointerleave", () => {
      this.lastPtr = null;
      if (!this.pan && !this.ndrag && this.st.hover >= 0) {
        this.st.hover = -1;
        if (this.hoverMatters()) this.draw();
      }
    });
    on("wheel", (ev) => this.onWheel(ev), { passive: false });
    // the theme or colour vision changed: read the colours again (never per frame)
    if (typeof MutationObserver === "function") {
      const mo = new MutationObserver(() => this.readColors());
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-vision", "style"] });
      this.cleanup.push(() => mo.disconnect());
    }
    if (typeof IntersectionObserver === "function") {
      const io = new IntersectionObserver((es) => {
        this.visible = !!es[es.length - 1]?.isIntersecting && !document.hidden;
        if (this.visible) (this.last = 0), this.schedule();
      });
      io.observe(c);
      this.cleanup.push(() => io.disconnect());
    }
    const onVis = () => {
      this.visible = !document.hidden;
      if (this.visible) (this.last = 0), this.schedule();
    };
    document.addEventListener("visibilitychange", onVis);
    this.cleanup.push(() => document.removeEventListener("visibilitychange", onVis));
  }
  private onDown(ev: PointerEvent) {
    if (ev.button !== 0 || !this.M || this.st.blank) return;
    const [sx, sy] = this.local(ev);
    this.touches.set(ev.pointerId, [sx, sy]);
    if (this.touches.size === 2) {
      // a second finger: a pinch, not a drag
      if (this.ndrag?.moved) this.release();
      this.ndrag = null;
      this.pan = null;
      const [a, b] = [...this.touches.values()] as [[number, number], [number, number]];
      this.pinch = { d0: Math.max(1, Math.hypot(a[0] - b[0], a[1] - b[1])), k0: this.st.cam.k, w: this.toWorld((a[0] + b[0]) / 2, (a[1] + b[1]) / 2) };
      this.moved = true;
      return;
    }
    const h = this.anim ? -1 : this.hit(sx, sy);
    this.moved = false;
    try {
      this.canvas.setPointerCapture?.(ev.pointerId);
    } catch {
      /* a synthetic pointer has nothing to capture */
    }
    if (h >= 0) this.ndrag = { i: h, x: ev.clientX, y: ev.clientY, moved: false, n: 0 };
    else this.pan = { x: ev.clientX, y: ev.clientY, cx: this.st.cam.x, cy: this.st.cam.y };
  }
  private onMove(ev: PointerEvent) {
    const f = this.f;
    if (!this.M || !f || this.st.blank) return;
    const [sx, sy] = this.local(ev);
    this.lastPtr = [sx, sy];
    if (this.touches.has(ev.pointerId)) this.touches.set(ev.pointerId, [sx, sy]);
    if (this.pinch && this.touches.size >= 2) {
      // zoom about the fingers' midpoint, keeping what was under it under it
      const [a, b] = [...this.touches.values()] as [[number, number], [number, number]];
      const mx = (a[0] + b[0]) / 2;
      const my = (a[1] + b[1]) / 2;
      this.st.cam.k = clamp((this.pinch.k0 * Math.hypot(a[0] - b[0], a[1] - b[1])) / this.pinch.d0, 0.5, 16);
      const s = this.scale();
      this.st.cam.x = this.pinch.w[0] - (mx - this.W / 2) / s;
      this.st.cam.y = this.pinch.w[1] - (my - this.H / 2) / s;
      this.draw();
      return;
    }
    const nd = this.ndrag;
    if (nd) {
      if (!nd.moved && Math.abs(ev.clientX - nd.x) + Math.abs(ev.clientY - nd.y) > 4) {
        nd.moved = true;
        this.setCursor("grabbing");
      }
      if (nd.moved && !f.FIXD[nd.i]) {
        const w = this.toWorld(sx, sy);
        this.dragTo(nd.i, w[0], w[1]);
        this.schedule();
        if (this.reduceMotion) this.draw();
      }
      return;
    }
    if (this.pan) {
      const dx = ev.clientX - this.pan.x;
      const dy = ev.clientY - this.pan.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) this.moved = true;
      if (this.moved) {
        const s = this.scale();
        this.st.cam.x = this.pan.cx - dx / s;
        this.st.cam.y = this.pan.cy - dy / s;
        this.draw();
      }
      return;
    }
    const h = this.hit(sx, sy);
    if (h !== this.st.hover) {
      this.st.hover = h;
      this.ripple(h);
      if (this.hoverMatters()) this.draw();
    }
    let onName = false;
    if (h < 0) for (const [b] of this.labelTargets) if (sx >= b.left && sx <= b.right && sy >= b.top && sy <= b.bottom) onName = true;
    const c0 = this.toScreen(0, 0);
    const onOrr = this.st.view === "kind" && h < 0 && Math.hypot(sx - c0[0], sy - c0[1]) < this.headR() * 1.1;
    this.setCursor(h >= 0 ? "grab" : onName || onOrr ? "pointer" : "default");
  }
  /** The file goes where you put it, inside its slice; its neighbourhood wakes up and rearranges around it. */
  private dragTo(i: number, ux: number, uy: number) {
    const f = this.f!;
    const nd = this.ndrag!;
    f.X[i] = ux - this.DX[i]!;
    f.Y[i] = uy - this.DY[i]!;
    f.VX[i] = 0;
    f.VY[i] = 0;
    f.wall(i);
    this.sim.fixed = i;
    this.sim.target = this.reduceMotion ? 0 : 0.3;
    if (nd.n++ % 6 === 0 && (!nd.mask || nd.mask.length < 3000)) {
      nd.mask = nd.mask ?? [];
      for (const k of this.neighbourhood(i))
        if (!this.MASK[k]) {
          this.MASK[k] = 1;
          nd.mask.push(k);
        }
    }
    if (!this.reduceMotion) this.heat(0.12, nd.mask);
    this.gridDirty = true;
  }
  private release() {
    const f = this.f!;
    const nd = this.ndrag;
    this.ndrag = null;
    if (nd?.mask) for (const k of nd.mask) this.MASK[k] = 0;
    this.sim.fixed = -1;
    this.sim.target = 0;
    // with reduced motion only the held file moved; the rest updates now, at once
    if (this.reduceMotion && nd?.mask) {
      for (let t = 0; t < 60; t++) f.step(nd.mask, 0.3 * Math.pow(0.95, t));
      this.topicCentres();
    }
    this.buildGrid();
    this.draw();
    this.schedule();
  }
  private onCancel() {
    if (this.ndrag) this.release();
    this.pan = null;
    this.touches.clear();
    this.pinch = null;
  }
  private onUp(ev: PointerEvent) {
    this.touches.delete(ev.pointerId);
    if (this.pinch) {
      if (this.touches.size < 2) this.pinch = null;
      return;
    }
    if (!this.M || this.st.blank) return;
    const [sx, sy] = this.local(ev);
    if (this.ndrag) {
      if (this.ndrag.moved) {
        this.release();
        this.setCursor("grab");
        return;
      }
      this.ndrag = null; // no move: it's a click on the file
    } else if (this.pan) {
      this.pan = null;
      if (this.moved) return;
    } else return;
    const now = performance.now();
    const dbl = now - this.lastClick < 320;
    this.lastClick = now;
    let h = this.hit(sx, sy);
    const c0 = this.toScreen(0, 0);
    if (h < 0 && this.st.view === "kind" && Math.hypot(sx - c0[0], sy - c0[1]) < this.headR() * 1.1) return this.home();
    // every name is a target: an area flies to the area, a topic to its notes, a file's name selects it.
    // Area and topic names sit on plates over the dots, so they win; a file's name counts where no dot is.
    for (let k = this.labelTargets.length - 1; k >= 0; k--) {
      const [b, tg] = this.labelTargets[k]!;
      if (h >= 0 && tg[0] === "file") continue;
      if (sx >= b.left && sx <= b.right && sy >= b.top && sy <= b.bottom) {
        if (tg[0] === "area") return this.hooks.onIntent?.({ kind: "area", area: tg[1] });
        if (tg[0] === "topic") return this.hooks.onIntent?.({ kind: "topic", topic: tg[1] });
        h = tg[1];
        break;
      }
    }
    if (h >= 0) {
      if (dbl && h === this.st.sel) return this.hooks.onIntent?.({ kind: "steps", i: h });
      this.select(h);
    } else if (dbl) {
      const f = this.f!;
      const w = this.toWorld(sx, sy);
      this.animateTo(f.X, f.Y, f.RAD, f.ALPHA, { x: w[0], y: w[1], k: clamp(this.st.cam.k * 2, 0.5, 16) });
    } else this.select(this.st.view === "steps" && this.S ? this.S.center : -1);
  }
  private onWheel(ev: WheelEvent) {
    ev.preventDefault();
    if (!this.M || this.st.blank) return;
    const [sx, sy] = this.local(ev);
    const before = this.toWorld(sx, sy);
    const k = Math.exp(-ev.deltaY * (ev.ctrlKey ? 0.01 : 0.0018));
    this.st.cam.k = clamp(this.st.cam.k * k, 0.5, 16);
    const after = this.toWorld(sx, sy);
    this.st.cam.x += before[0] - after[0];
    this.st.cam.y += before[1] - after[1];
    this.draw();
  }
}

/** "1,149": thousands with a comma, as on the boards. */
export function fmt(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * The keyboard's next file: the nearest one that lies in `dir` from `from`, with sideways
 * distance counting double, so ArrowRight prefers the file straight across over a closer one
 * far above. Null when nothing lies that way.
 */
export function nearestInDirection<N extends { id: number | string; x: number; y: number }>(from: N, nodes: N[], dir: { x: number; y: number }): N | null {
  let best: N | null = null;
  let bestScore = Infinity;
  for (const n of nodes) {
    const vx = n.x - from.x;
    const vy = n.y - from.y;
    const along = vx * dir.x + vy * dir.y;
    if (along <= 0) continue; // behind, beside, or `from` itself
    const across = Math.abs(vx * dir.y - vy * dir.x);
    const score = along + 2 * across;
    if (score < bestScore) {
      bestScore = score;
      best = n;
    }
  }
  return best;
}
