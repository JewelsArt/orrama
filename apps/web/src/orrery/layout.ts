/**
 * Where every file sits (structure.md §2.16), ported from the prototype that Jules approved on
 * 9 October (`~/orrama-redesign/orrery/orrery.js`). World coordinates: Orr at the origin, the
 * rim at radius 958 of a 1000 circle.
 *
 * Kind: rings by what a file is (projects nearest Orr, then people and companies, then notes and
 * conversations, reviews and templates on the rim), the angle by life area, each a slice that
 * grows with the area by count^0.8 so one big area cannot swallow the circle. Inside an area each
 * topic gets a share of the angle by its size; dots are sized from the room each ring has.
 *
 * Steps: one thing in the middle, ring 1 everything one step away grouped by how it relates,
 * ring 2 what several things in ring 1 share nearest and the rest further out.
 */
import { AREAS, GROUP_ORDER, groupOf, otherEnd, type Model } from "./model.js";

export const TAU = Math.PI * 2;
const PHI = (Math.sqrt(5) - 1) / 2;

/** The rings' radii: projects, people and companies, notes and conversations, reviews and templates, the rim. */
export const BAND = { proj: [175, 262], ppl: [298, 425], note: [462, 868], rest: [892, 922], rim: 958 } as const;
export type Band = readonly [number, number];

export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
/** A fixed pseudo-random number in [0, 1) per (k, seed): the same layout every time. */
export function hash(k: number, seed: number): number {
  const h = Math.sin(k * 12.9898 + seed * 78.233) * 43758.5453;
  return h - Math.floor(h);
}

/** Which ring a kind of file lives in. */
export const bandOf = (t: number): Band => (t === 0 ? BAND.proj : t === 1 || t === 2 ? BAND.ppl : t === 5 ? BAND.rest : BAND.note);

/** Spread `ids` evenly over a ring sector, a golden-angle walk with a little jitter. */
export function packSector(ids: readonly number[], a0: number, a1: number, r0: number, r1: number, X: Float32Array, Y: Float32Array, jitter = 0.42): void {
  const n = ids.length;
  if (!n) return;
  if (n === 1) {
    const am = (a0 + a1) / 2;
    const rm = (r0 + r1) / 2;
    X[ids[0]!] = rm * Math.cos(am);
    Y[ids[0]!] = rm * Math.sin(am);
    return;
  }
  const cell = Math.sqrt((0.5 * Math.abs(a1 - a0) * (r1 * r1 - r0 * r0)) / n);
  const seed = a0 * 1000 + r0;
  for (let k = 0; k < n; k++) {
    const t = (k + 0.5) / n;
    let r = Math.sqrt(r0 * r0 + t * (r1 * r1 - r0 * r0));
    const f = (k * PHI + 0.5) % 1;
    let a = a0 + (0.04 + 0.92 * f) * (a1 - a0);
    if (jitter) {
      r = clamp(r + (hash(k, seed) - 0.5) * cell * jitter * 2, r0, r1);
      a = a + (hash(k + 7919, seed) - 0.5) * (cell / Math.max(r, 1)) * jitter * 2;
    }
    X[ids[k]!] = r * Math.cos(a);
    Y[ids[k]!] = r * Math.sin(a);
  }
}

/** Pack a sector, then hand the places out by angle, so each file lands near its topic. */
function packByAngle(ids: number[], a0: number, a1: number, r0: number, r1: number, X: Float32Array, Y: Float32Array, angleOf: (i: number) => number): void {
  if (!ids.length) return;
  const px = new Float32Array(ids.length);
  const py = new Float32Array(ids.length);
  const slots = ids.map((_, k) => k);
  packSector(slots, a0, a1, r0, r1, px, py);
  const pts = slots.map((k) => {
    let a = Math.atan2(py[k]!, px[k]!);
    while (a < a0) a += TAU;
    while (a > a0 + TAU) a -= TAU;
    return { k, a };
  });
  pts.sort((p, q) => p.a - q.a);
  const order = ids.slice().sort((i, j) => angleOf(i) - angleOf(j));
  order.forEach((id, k) => {
    X[id] = px[pts[k]!.k]!;
    Y[id] = py[pts[k]!.k]!;
  });
}

export interface KindLayout {
  X: Float32Array;
  Y: Float32Array;
  RAD: Float32Array;
  /** The room each file has in its ring: the free layout's unit of length. */
  SPC: Float32Array;
  areaSpan: [number, number][];
  topicSpan: [number, number][];
}

/** The angle Kind starts from: School at the top left, then clockwise. */
const START = -Math.PI / 2 - 0.62;

export function layoutKind(m: Model): KindLayout {
  const nodes = m.nodes;
  const n = nodes.length;
  const X = new Float32Array(n);
  const Y = new Float32Array(n);
  const RAD = new Float32Array(n);
  const SPC = new Float32Array(n);

  // area spans: count^0.8, each at least a sliver, rescaled to fill the circle
  const gapA = 0.05;
  const span = TAU - gapA * AREAS.length;
  const wts = m.areaCount.map((c) => Math.pow(c, 0.8));
  const tw = wts.reduce((s, w) => s + w, 0) || 1;
  const raw = wts.map((w) => Math.max(0.32, (span * w) / tw));
  const scale = span / raw.reduce((s, w) => s + w, 0);
  const areaSpan: [number, number][] = [];
  let a = START;
  for (const w of raw) {
    areaSpan.push([a, a + w * scale]);
    a += w * scale + gapA;
  }

  // topic spans inside each area, by size
  const gapC = 0.006;
  const per = m.topics.map(() => ({ proj: [] as number[], ppl: [] as number[], note: [] as number[], rest: [] as number[] }));
  for (const d of nodes) per[d.cl]![d.t === 0 ? "proj" : d.t === 1 || d.t === 2 ? "ppl" : d.t === 5 ? "rest" : "note"].push(d.i);
  const topicSpan: [number, number][] = [];
  m.areaTopics.forEach((cls, ai) => {
    const sizes = cls.map((c) => 2 + per[c]!.note.length + 3 * per[c]!.proj.length);
    const tot = sizes.reduce((s, v) => s + v, 0) || 1;
    let a0 = areaSpan[ai]![0];
    const wa = areaSpan[ai]![1] - areaSpan[ai]![0] - gapC * Math.max(0, cls.length - 1);
    cls.forEach((c, k) => {
      const w = (wa * sizes[k]!) / tot;
      topicSpan[c] = [a0, a0 + w];
      a0 += w + gapC;
    });
  });

  const room = (band: Band, count: number) => Math.sqrt((0.5 * TAU * (band[1] * band[1] - band[0] * band[0])) / Math.max(1, count));
  const cnt = { proj: 0, ppl: 0, note: 0, rest: 0 };
  for (const p of per) {
    cnt.proj += p.proj.length;
    cnt.ppl += p.ppl.length;
    cnt.note += p.note.length;
    cnt.rest += p.rest.length;
  }
  const sp = { proj: room(BAND.proj, cnt.proj), note: room(BAND.note, cnt.note) };

  // well-linked notes lean towards the middle, loosely, so they do not draw a ring of their own
  const leanIn = (ids: number[]) => {
    ids.sort((p, q) => nodes[q]!.deg - nodes[p]!.deg || p - q);
    const key = new Map<number, number>();
    ids.forEach((id, k) => key.set(id, k / Math.max(1, ids.length) + hash(id, 7)));
    ids.sort((p, q) => key.get(p)! - key.get(q)!);
  };
  per.forEach((p, c) => {
    leanIn(p.note);
    packSector(p.note, topicSpan[c]![0], topicSpan[c]![1], BAND.note[0], BAND.note[1], X, Y);
  });
  const mid = (c: number) => (topicSpan[c]![0] + topicSpan[c]![1]) / 2;
  const areaRoom = AREAS.map(() => ({ ppl: 0, rest: 0 }));
  AREAS.forEach((_, ai) => {
    let ppl: number[] = [];
    let rest: number[] = [];
    let proj: number[] = [];
    for (const c of m.areaTopics[ai]!) {
      ppl = ppl.concat(per[c]!.ppl);
      rest = rest.concat(per[c]!.rest);
      proj = proj.concat(per[c]!.proj);
    }
    const [s0, s1] = areaSpan[ai]!;
    packByAngle(proj, s0 + 0.03, s1 - 0.03, BAND.proj[0], BAND.proj[1], X, Y, (i) => mid(nodes[i]!.cl) - nodes[i]!.deg * 1e-7);
    packByAngle(ppl, s0 + 0.01, s1 - 0.01, BAND.ppl[0], BAND.ppl[1], X, Y, (i) => mid(nodes[i]!.cl) + (nodes[i]!.t === 2 ? -0.0001 : 0) - nodes[i]!.deg * 1e-7);
    packByAngle(rest, s0 + 0.01, s1 - 0.01, BAND.rest[0], BAND.rest[1], X, Y, (i) => mid(nodes[i]!.cl) + i * 1e-9);
    // people and reviews take the room their own area has (Work holds far more people than School)
    const sector = (band: Band, c: number) => Math.sqrt((0.5 * (s1 - s0) * (band[1] * band[1] - band[0] * band[0])) / Math.max(1, c));
    areaRoom[ai] = { ppl: sector(BAND.ppl, ppl.length), rest: sector(BAND.rest, rest.length) };
  });

  for (let i = 0; i < n; i++) {
    const d = nodes[i]!;
    const g = Math.sqrt(d.deg + 1);
    const ar = areaRoom[d.area]!;
    SPC[i] = d.t === 0 ? sp.proj : d.t === 1 || d.t === 2 ? ar.ppl : d.t === 5 ? ar.rest : sp.note;
    if (d.t === 0) RAD[i] = clamp(sp.proj * clamp(0.2 + 0.035 * g, 0.22, 0.42), 7, 30);
    else if (d.t === 1 || d.t === 2) RAD[i] = clamp(ar.ppl * clamp(0.17 + 0.04 * g, 0.2, 0.46), 2, 22);
    else if (d.t === 5) RAD[i] = clamp(ar.rest * 0.24, 1.2, 4);
    else RAD[i] = clamp(sp.note * (0.12 + 0.045 * g), 1.6, Math.min(16, sp.note * 0.8));
  }
  return { X, Y, RAD, SPC, areaSpan, topicSpan };
}

export interface StepsLayout {
  center: number;
  X: Float32Array;
  Y: Float32Array;
  RAD: Float32Array;
  /** 3 the middle, 1 ring 1, 2 ring 2, 0 not shown. */
  ON: Uint8Array;
  /** How many things in ring 1 lead to a ring-2 file. */
  VIA: Uint16Array;
  groups: Map<string, number[]>;
  order: string[];
  spans: Map<string, [number, number]>;
  ring1: number[];
  ring2: number[];
  /** Ring 2 files that two or more things in ring 1 share. */
  strong: number[];
  parent: Map<number, number>;
  gOf: Map<number, string>;
  r1a: number;
  r1b: number;
  r2a: number;
  r2b: number;
  s1: number;
  s2: number;
}

/**
 * Steps around `center`. `keep` decides who may appear (reviews and templates only with the
 * switch); `lite` is the phone's lighter Steps: ring 1 and only what ring 1 shares.
 */
export function layoutSteps(m: Model, center: number, keep: (i: number) => boolean, lite = false): StepsLayout {
  const nodes = m.nodes;
  const n = nodes.length;
  const X = new Float32Array(n);
  const Y = new Float32Array(n);
  const RAD = new Float32Array(n);
  const ON = new Uint8Array(n);
  const VIA = new Uint16Array(n);
  ON[center] = 3;
  const groups = new Map<string, number[]>();
  const gOf = new Map<number, string>();
  for (const e of m.adj[center]!) {
    const o = otherEnd(m, e, center);
    if (ON[o] || !keep(o)) continue;
    const g = groupOf(m, center, e);
    (groups.get(g) ?? groups.set(g, []).get(g)!).push(o);
    ON[o] = 1;
    gOf.set(o, g);
  }
  const rank = (s: string) => {
    const k = GROUP_ORDER.indexOf(s);
    return k < 0 ? GROUP_ORDER.length : k;
  };
  const order = [...groups.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  let ring1: number[] = [];
  for (const g of order) {
    groups.get(g)!.sort((a, b) => nodes[b]!.deg - nodes[a]!.deg || a - b);
    ring1 = ring1.concat(groups.get(g)!);
  }
  // ring 2: one more step out
  const parent = new Map<number, number>();
  let ring2: number[] = [];
  for (const p of ring1) {
    for (const e of m.adj[p]!) {
      const o = otherEnd(m, e, p);
      if (ON[o] === 1 || ON[o] === 3 || !keep(o)) continue;
      if (ON[o] === 2) {
        VIA[o]!++;
        continue;
      }
      ON[o] = 2;
      VIA[o] = 1;
      parent.set(o, p);
      ring2.push(o);
    }
  }
  if (lite) {
    for (const o of ring2) if (VIA[o]! < 2) ON[o] = 0;
    ring2 = ring2.filter((o) => ON[o] === 2);
  }
  // group spans: what a group holds, and what hangs off it one step further
  const n2g = new Map(order.map((g) => [g, 0]));
  for (const o of ring2) {
    const g = gOf.get(parent.get(o)!)!;
    n2g.set(g, n2g.get(g)! + 1);
  }
  const gw = order.map((g) => 0.5 + Math.sqrt(groups.get(g)!.length + 0.35 * n2g.get(g)!));
  const tw = gw.reduce((s, v) => s + v, 0) || 1;
  const gap = order.length > 1 ? 0.07 : 0;
  const span = TAU - gap * order.length;
  let a = -Math.PI / 2 - (order.length === 1 ? Math.PI * 0.5 : 0.3);
  const spans = new Map<string, [number, number]>();
  order.forEach((g, k) => {
    const w = (span * gw[k]!) / tw;
    spans.set(g, [a, a + w]);
    a += w + gap;
  });
  const n1 = ring1.length;
  const r1a = 230;
  const r1b = n1 > 60 ? 480 : n1 > 24 ? 410 : 340;
  for (const g of order) packSector(groups.get(g)!, spans.get(g)![0], spans.get(g)![1], r1a, r1b, X, Y);

  // ring 2: what several things in ring 1 share sits nearer, the rest further out; each keeps to its parent's angle
  const r2a = r1b + 80;
  const r2b = 930;
  const placeByParent = (list: number[], sp: [number, number], r0: number, r1: number) => {
    if (!list.length) return;
    const px = new Float32Array(list.length);
    const py = new Float32Array(list.length);
    const slots = list.map((_, k) => k);
    packSector(slots, sp[0], sp[1], r0, r1, px, py);
    const rel = (ang: number) => {
      let d = ang - sp[0];
      while (d < 0) d += TAU;
      while (d >= TAU) d -= TAU;
      return d;
    };
    const pts = slots.map((k) => ({ k, ang: rel(Math.atan2(py[k]!, px[k]!)) })).sort((p, q) => p.ang - q.ang);
    const pa = new Map(list.map((o) => [o, rel(Math.atan2(Y[parent.get(o)!]!, X[parent.get(o)!]!))]));
    list.sort((o1, o2) => pa.get(o1)! - pa.get(o2)! || o1 - o2);
    list.forEach((o, k) => {
      X[o] = px[pts[k]!.k]!;
      Y[o] = py[pts[k]!.k]!;
    });
  };
  const strong: number[] = [];
  const byG = new Map(order.map((g) => [g, { strong: [] as number[], weak: [] as number[] }]));
  for (const o of ring2) {
    const shared = VIA[o]! >= 2;
    byG.get(gOf.get(parent.get(o)!)!)![shared ? "strong" : "weak"].push(o);
    if (shared) strong.push(o);
  }
  for (const g of order) {
    const { strong: st, weak: wk } = byG.get(g)!;
    const sp = spans.get(g)!;
    if (st.length && wk.length) {
      const f = clamp(st.length / (st.length + wk.length), 0.22, 0.6);
      const rm = Math.sqrt(r2a * r2a + f * (r2b * r2b - r2a * r2a));
      placeByParent(st, sp, r2a, rm);
      placeByParent(wk, sp, rm + 8, r2b);
    } else placeByParent(st.length ? st : wk, sp, r2a, r2b);
  }
  const room = (r0: number, r1: number, count: number) => Math.sqrt((0.5 * TAU * (r1 * r1 - r0 * r0)) / Math.max(1, count));
  const s1 = room(r1a, r1b, n1);
  const s2 = room(r2a, r2b, ring2.length);
  for (let i = 0; i < n; i++) {
    if (!ON[i]) continue;
    const d = nodes[i]!;
    const g2 = Math.sqrt(d.deg + 1);
    if (ON[i] === 3) RAD[i] = d.t === 0 ? 46 : 40;
    else if (ON[i] === 1) RAD[i] = clamp(s1 * (0.16 + 0.03 * g2), 4, d.t === 0 ? 24 : 18);
    else RAD[i] = clamp(s2 * (0.12 + 0.06 * Math.sqrt(VIA[i]!)), 1.5, 10);
  }
  return { center, X, Y, RAD, ON, VIA, groups, order, spans, ring1, ring2, strong, parent, gOf, r1a, r1b, r2a, r2b, s1, s2 };
}
