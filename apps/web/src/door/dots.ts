/**
 * The door's dots (take B, structure.md §2.14), ported from the prototype
 * (~/orrama-redesign/signin/door.js).
 *
 * Before you're in, your files are anonymous dots in a soft halo round Orr's head: no names, no
 * counts, no slices. They lean towards the pointer, every key lights one, and while the server
 * checks they light up one after another. Getting in gathers them into your vault around his
 * head: one slice per life area, sized by how many notes it really holds, a coloured rim, projects
 * first. Nothing moves unless something happens; with reduced motion nothing animates.
 *
 * The halo has a fixed number of dots, because before sign-in nothing about the vault may show.
 * Once in, the shape comes from the server (`shape.ts`): the first `min(notes, MAX_DOTS)` dots
 * take a note's place and the rest fade, so a small vault gathers as a small vault.
 */

export const MAX_DOTS = 520;
/** Below this width the door is the phone's: halo above, form below. */
export const NARROW = 560;

/** One life area of the signed-in vault, as the gather draws it. */
export interface AreaShape {
  /** A colour token, e.g. "--c3". */
  color: string;
  notes: number;
  projects: number;
  people: number;
}
/** What the gather needs: areas in drawing order, with counts. Never names. */
export interface VaultShape {
  areas: AreaShape[];
}

interface Dot {
  /** 0 a project, 1 a person, 2 any other note (only meaningful once gathered) */
  kind: number;
  /** loose: angle and radius factor in the halo */
  la: number;
  lr: number;
  /** gathered: angle and radius factor in its slice, or null to fade out */
  ha: number;
  hr: number;
  fade: boolean;
  /** pointer lean: offset and velocity */
  ox: number;
  oy: number;
  vx: number;
  vy: number;
  x: number;
  y: number;
  glow: number;
  /** 0–1: first run brings the dots in as the notes are counted */
  vis: number;
  /** where in the count this dot arrives (0–1) */
  at: number;
  r: number;
  /** gather delay, ms: projects first */
  dl: number;
}

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** Overshoots a touch, so a dot lands rather than stops. */
const backEase = (t: number) => 1 + 2.25 * Math.pow(t - 1, 3) + 1.25 * Math.pow(t - 1, 2);

/** A seeded generator: the halo looks the same on every visit. */
function seeded(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
}

/** Radius bands, as fractions of the halo: projects near the head, people next, notes outside. */
const BAND: [number, number][] = [
  [0.22, 0.3],
  [0.34, 0.46],
  [0.5, 0.92],
];

/**
 * Each area's arc, clockwise from just left of the top, with a small gap between areas. An
 * area's share is its note count to the power 0.8, so a big area does not swallow the small ones.
 * Areas with no notes get no slice.
 */
export function areaSpans(counts: number[], gap = 0.05): ([number, number] | null)[] {
  const live = counts.filter((c) => c > 0);
  if (live.length === 0) return counts.map(() => null);
  const span = Math.PI * 2 - gap * live.length;
  const total = live.reduce((t, c) => t + Math.pow(c, 0.8), 0);
  let a = -Math.PI / 2 - 0.62;
  return counts.map((c) => {
    if (c <= 0) return null;
    const w = (span * Math.pow(c, 0.8)) / total;
    const s: [number, number] = [a, a + w];
    a += w + gap;
    return s;
  });
}

/**
 * Which area and kind each of the first dots stands for. With more notes than dots, each dot
 * stands for several and the areas keep their proportions; projects and people keep theirs
 * inside an area. Returns one entry per dot that stays.
 */
export function assignDots(shape: VaultShape, max = MAX_DOTS): { area: number; kind: number }[] {
  const total = shape.areas.reduce((t, a) => t + a.notes, 0);
  if (total === 0) return [];
  const scale = Math.min(1, max / total);
  const out: { area: number; kind: number }[] = [];
  shape.areas.forEach((a, area) => {
    if (a.notes <= 0) return;
    const n = Math.max(1, Math.round(a.notes * scale));
    const projects = Math.min(n, Math.round(a.projects * scale));
    const people = Math.min(n - projects, Math.round(a.people * scale));
    for (let i = 0; i < n; i++) out.push({ area, kind: i < projects ? 0 : i < projects + people ? 1 : 2 });
  });
  return out.slice(0, max);
}

export interface DotsOptions {
  /** the lock: the vault is folded away, so the dots are dimmer */
  dim?: boolean;
  /** first run: no dots until the notes are counted */
  hidden?: boolean;
  reduce?: boolean;
}

/**
 * Draws the dots on a canvas filling `root`. Colours come from the tokens on `root`, so the
 * theme and the colour-vision profile apply. A canvas without a 2D context (a test DOM) still
 * works: it just draws nothing.
 */
export class DoorDots {
  private readonly ctx: CanvasRenderingContext2D | null;
  private dots: Dot[] = [];
  private spans: ([number, number] | null)[] = [];
  private areaCol: string[] = [];
  private areaColResolved: string[] = [];
  private colors = { ink: "#6B6357", orr: "#D9731F", sun: "#F39A4E" };
  private W = 0;
  private H = 0;
  private ptr: [number, number] | null = null;
  private phase: "loose" | "gather" = "loose";
  private t0 = 0;
  private sparks: { d: Dot; t: number }[] = [];
  private raf = 0;
  private thinking: ReturnType<typeof setInterval> | undefined;
  private dead = false;
  private readonly ro: ResizeObserver | null = null;
  private readonly offMove: () => void;

  constructor(
    private readonly root: HTMLElement,
    private readonly cv: HTMLCanvasElement,
    private readonly opts: DotsOptions = {},
  ) {
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = cv.getContext("2d");
    } catch {
      ctx = null;
    }
    this.ctx = ctx;
    const rnd = seeded(77);
    for (let i = 0; i < MAX_DOTS; i++) {
      const kind = rnd() < 0.05 ? 0 : rnd() < 0.17 ? 1 : 2;
      const band = BAND[kind]!;
      {
        const hr = Math.sqrt(lerp(band[0] ** 2, band[1] ** 2, rnd()));
        this.dots.push({
          kind,
          la: rnd() * Math.PI * 2,
          lr: 0.55 + hr * 0.75 + (rnd() - 0.5) * 0.35,
          ha: 0,
          hr,
          fade: false,
          ox: 0,
          oy: 0,
          vx: 0,
          vy: 0,
          x: 0,
          y: 0,
          glow: 0,
          vis: opts.hidden ? 0 : 1,
          at: rnd(),
          r: kind === 0 ? 4.2 : kind === 1 ? 2.6 : 1.5 + rnd() * 1.4,
          dl: kind * 160 + rnd() * 380,
        });
      }
    }
    const move = (ev: PointerEvent) => {
      const r = this.cv.getBoundingClientRect();
      this.ptr = [ev.clientX - r.left, ev.clientY - r.top];
      this.kick();
    };
    const leave = () => {
      this.ptr = null;
      this.kick();
    };
    root.addEventListener("pointermove", move, { passive: true });
    root.addEventListener("pointerleave", leave);
    this.offMove = () => {
      root.removeEventListener("pointermove", move);
      root.removeEventListener("pointerleave", leave);
    };
    if (typeof ResizeObserver === "function") {
      this.ro = new ResizeObserver(() => this.resize());
      this.ro.observe(root);
    }
    this.resize();
  }

  get narrow() {
    return this.W > 0 && this.W < NARROW;
  }

  destroy() {
    this.dead = true;
    clearInterval(this.thinking);
    if (this.raf) cancelAnimationFrame(this.raf);
    this.ro?.disconnect();
    this.offMove();
  }

  /** A key was pressed: one dot lights and ties itself to its neighbours for a moment. */
  spark() {
    if (this.phase === "gather" || this.opts.reduce) return;
    const d = this.dots[Math.floor(Math.random() * this.dots.length)]!;
    if (d.vis < 0.5) return;
    d.glow = 1;
    this.sparks.push({ d, t: performance.now() });
    this.kick();
  }

  /** While the server checks: dots light one after another, so you know it's working. */
  think(on: boolean) {
    clearInterval(this.thinking);
    this.thinking = undefined;
    if (on && !this.opts.reduce) this.thinking = setInterval(() => this.spark(), 140);
  }

  /** First run: the fraction of the notes counted so far; each dot arrives at its turn. */
  reveal(f: number) {
    for (const d of this.dots) d.vis = clamp((f - d.at * 0.9) * 8, 0, 1);
    this.kick();
  }

  /**
   * In: the dots gather into the vault. With a shape they find their area's slice and the rim
   * draws in; without one (the server was slow to say) they close into the halo, uncoloured.
   */
  gather(shape: VaultShape | null) {
    this.think(false);
    const assigned = shape ? assignDots(shape) : null;
    this.spans = shape ? areaSpans(shape.areas.map((a) => a.notes)) : [];
    this.areaCol = shape ? shape.areas.map((a) => a.color) : [];
    const rnd = seeded(101);
    this.dots.forEach((d, i) => {
      const a = assigned ? assigned[i] : undefined;
      if (assigned && !a) {
        d.fade = true;
        d.ha = d.la;
        return;
      }
      if (!a) {
        d.ha = d.la;
        return;
      }
      const sp = this.spans[a.area]!;
      const band = BAND[a.kind]!;
      d.kind = a.kind;
      d.ha = lerp(sp[0] + 0.03, sp[1] - 0.03, rnd());
      d.hr = Math.sqrt(lerp(band[0] ** 2, band[1] ** 2, rnd()));
      d.r = a.kind === 0 ? 4.2 : a.kind === 1 ? 2.6 : 1.5 + rnd() * 1.4;
      d.dl = a.kind * 160 + rnd() * 380;
    });
    this.phase = "gather";
    this.t0 = performance.now();
    this.readColours();
    this.kick();
  }

  private readColours() {
    const cs = getComputedStyle(this.root);
    const v = (name: string, or: string) => cs.getPropertyValue(name).trim() || or;
    this.colors = { ink: v("--ink-3", "#6B6357"), orr: v("--orr-deep", "#D9731F"), sun: v("--sun", "#F39A4E") };
    this.areaColResolved = this.areaCol.map((c) => v(c, "#888"));
  }

  private R() {
    return Math.min(this.W, this.H) * (this.narrow ? 0.62 : 0.47);
  }
  private centre(): [number, number] {
    return [this.W / 2, this.narrow ? this.H * 0.3 : this.H * 0.5];
  }
  private loose(d: Dot): [number, number] {
    const [cx, cy] = this.centre();
    const r = d.lr * this.R();
    return [cx + Math.cos(d.la) * r, cy + Math.sin(d.la) * r];
  }
  private home(d: Dot): [number, number] {
    const [cx, cy] = this.centre();
    const r = this.R();
    return [cx + Math.cos(d.ha) * d.hr * r, cy + Math.sin(d.ha) * d.hr * r];
  }

  private resize() {
    const r = this.root.getBoundingClientRect();
    if (!r.width) return;
    const dpr = window.devicePixelRatio || 1;
    this.W = r.width;
    this.H = r.height;
    this.cv.width = Math.round(this.W * dpr);
    this.cv.height = Math.round(this.H * dpr);
    this.cv.style.width = `${this.W}px`;
    this.cv.style.height = `${this.H}px`;
    this.ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.readColours();
    this.paint(performance.now());
  }

  private kick() {
    if (!this.raf && !this.dead && this.ctx) this.raf = requestAnimationFrame((now) => this.frame(now));
  }
  private frame(now: number) {
    this.raf = 0;
    if (this.paint(now)) this.kick();
  }

  /** One frame. Returns whether anything is still moving. */
  private paint(now: number): boolean {
    const ctx = this.ctx;
    if (!this.W || !ctx) return false;
    const reduce = !!this.opts.reduce;
    const gathered = this.phase === "gather";
    const T = gathered ? (reduce ? 1e9 : now - this.t0) : 0;
    const [cx, cy] = this.centre();
    const rr = this.R();
    const narrow = this.narrow;
    let moving = false;
    ctx.clearRect(0, 0, this.W, this.H);

    if (gathered) {
      const grow = clamp((T - 500) / 900, 0, 1);
      ctx.lineWidth = narrow ? 3 : 4;
      ctx.lineCap = "round";
      ctx.globalAlpha = 1;
      this.spans.forEach((sp, k) => {
        if (!sp) return;
        ctx.strokeStyle = this.areaColResolved[k] ?? this.colors.ink;
        ctx.beginPath();
        ctx.arc(cx, cy, rr * 0.96, sp[0] + 0.004, sp[0] + 0.004 + (sp[1] - sp[0] - 0.008) * grow);
        ctx.stroke();
      });
      if (grow < 1) moving = true;
    }

    const dim = this.opts.dim && !gathered ? 0.7 : 1;
    for (const d of this.dots) {
      let vis = d.vis;
      let p: [number, number];
      if (gathered) {
        const t = clamp((T - d.dl) / 900, 0, 1);
        if (d.fade) vis *= 1 - t;
        const e = backEase(t);
        const a = this.loose(d);
        const b = d.fade ? a : this.home(d);
        p = [lerp(a[0], b[0], e), lerp(a[1], b[1], e)];
        if (t < 1) moving = true;
      } else p = this.loose(d);
      if (vis <= 0.001) continue;

      let tx = 0;
      let ty = 0;
      if (this.ptr && !gathered && !reduce) {
        const dx = this.ptr[0] - p[0];
        const dy = this.ptr[1] - p[1];
        const dd = Math.sqrt(dx * dx + dy * dy);
        if (dd < 160 && dd > 1) {
          const m = (1 - dd / 160) * 26;
          tx = (dx / dd) * m;
          ty = (dy / dd) * m;
        }
      }
      d.vx += ((tx - d.ox) * 120 - d.vx * 11) / 60;
      d.vy += ((ty - d.oy) * 120 - d.vy * 11) / 60;
      d.ox += d.vx / 60;
      d.oy += d.vy / 60;
      if (Math.abs(d.vx) + Math.abs(d.vy) > 0.05 || Math.abs(tx - d.ox) + Math.abs(ty - d.oy) > 0.05) moving = true;
      d.x = p[0] + d.ox;
      d.y = p[1] + d.oy;
      if (d.glow > 0) {
        d.glow = Math.max(0, d.glow - 0.018);
        moving = true;
      }
      const base = gathered ? 0.9 : 0.26 * dim;
      ctx.globalAlpha = Math.min(1, base + d.glow) * vis;
      ctx.fillStyle = d.glow > 0.05 ? this.colors.sun : gathered && d.kind === 0 && !d.fade && this.spans.length ? this.colors.orr : this.colors.ink;
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.r * (1 + d.glow * 1.4) * (gathered ? 1.15 : 1) * (narrow ? 0.8 : 1), 0, Math.PI * 2);
      ctx.fill();
    }

    // A lit dot ties itself to its three nearest neighbours, and lets go.
    this.sparks = this.sparks.filter((s) => now - s.t < 900);
    for (const s of this.sparks) {
      const age = (now - s.t) / 900;
      const near = this.dots
        .filter((o) => o !== s.d && o.vis >= 0.5)
        .map((o) => [(o.x - s.d.x) ** 2 + (o.y - s.d.y) ** 2, o] as const)
        .sort((a, b) => a[0] - b[0])
        .slice(0, 3);
      ctx.strokeStyle = this.colors.orr;
      ctx.lineWidth = 1.2;
      ctx.globalAlpha = 0.55 * (1 - age);
      for (const [, o] of near) {
        ctx.beginPath();
        ctx.moveTo(s.d.x, s.d.y);
        ctx.lineTo(o.x, o.y);
        ctx.stroke();
      }
      moving = true;
    }
    ctx.globalAlpha = 1;
    return moving;
  }
}
