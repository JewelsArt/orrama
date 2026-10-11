/**
 * The free layout (take B, decided 9 October): a force layout held in its slice and its ring.
 * Links pull like springs, files push each other apart and never overlap, each file is kept
 * inside its domain (Kind: its life area's slice and its kind's ring; Steps: its relation group
 * and ring) by soft walls, and a faint pull to its place in the rings keeps each topic together.
 * A link to a file in another ring pulls only along the ring, so the rings stay full.
 *
 * A Field is one set of positions and velocities: the page's live one, or a private one the
 * whole vault is settled in before it is shown.
 */
import type { Model } from "./model.js";
import { bandOf, hash, TAU, type KindLayout, type StepsLayout } from "./layout.js";

/** The forces, as tuned on the prototype (its PB). */
export const PB = { link: 0.5, len: 0.9, across: 0.2, repel: 0.8, reach: 2.4, anchor: 0.014, anchorSteps: 0.16, wall: 1.2, decay: 0.6, alphaDecay: 0.025 };

export class Field {
  readonly n: number;
  X: Float32Array;
  Y: Float32Array;
  VX: Float32Array;
  VY: Float32Array;
  RAD: Float32Array;
  ALPHA: Float32Array;
  /** The room a file has in its ring: the unit of length for its forces. */
  SPC: Float32Array;
  /** Its domain: angles and radii it may not leave, and its place in the rings. */
  DA0: Float32Array;
  DA1: Float32Array;
  DR0: Float32Array;
  DR1: Float32Array;
  AX: Float32Array;
  AY: Float32Array;
  /** Pinned: the middle of Steps. */
  FIXD: Uint8Array;
  steps = false;
  medSpc = 30;
  cs = 40;
  // a grid over the positions, numbers not strings, so it is cheap to rebuild every step
  private readonly GOFF = 1400;
  GS = 40;
  GN = 70;
  GH: Int32Array | null = null;
  GNEXT: Int32Array;

  constructor(readonly m: Model) {
    const n = (this.n = m.nodes.length);
    this.X = new Float32Array(n);
    this.Y = new Float32Array(n);
    this.VX = new Float32Array(n);
    this.VY = new Float32Array(n);
    this.RAD = new Float32Array(n);
    this.ALPHA = new Float32Array(n);
    this.SPC = new Float32Array(n);
    this.DA0 = new Float32Array(n);
    this.DA1 = new Float32Array(n);
    this.DR0 = new Float32Array(n);
    this.DR1 = new Float32Array(n);
    this.AX = new Float32Array(n);
    this.AY = new Float32Array(n);
    this.FIXD = new Uint8Array(n);
    this.GNEXT = new Int32Array(n);
  }

  /** Kind: each file in its life area's slice and its kind's ring, homed on the rings. */
  domainsKind(K: KindLayout): void {
    const med: number[] = [];
    this.steps = false;
    for (let i = 0; i < this.n; i++) {
      const d = this.m.nodes[i]!;
      const b = bandOf(d.t);
      const as = K.areaSpan[d.area]!;
      this.FIXD[i] = 0;
      this.DA0[i] = as[0] + 0.012;
      this.DA1[i] = as[1] - 0.012;
      this.DR0[i] = b[0];
      this.DR1[i] = b[1];
      this.SPC[i] = K.SPC[i]!;
      this.AX[i] = K.X[i]!;
      this.AY[i] = K.Y[i]!;
      if (d.t === 3) med.push(K.SPC[i]!);
    }
    this.setMed(med);
  }

  /** Steps: each file in its relation group and its ring; the middle stays put. */
  domainsSteps(S: StepsLayout): void {
    this.steps = true;
    for (let i = 0; i < this.n; i++) {
      this.FIXD[i] = S.ON[i] === 3 ? 1 : 0;
      if (!S.ON[i] || S.ON[i] === 3) continue;
      const g = S.ON[i] === 1 ? S.gOf.get(i)! : S.gOf.get(S.parent.get(i)!)!;
      const sp = S.spans.get(g)!;
      this.DA0[i] = sp[0] + 0.01;
      this.DA1[i] = sp[1] - 0.01;
      if (S.ON[i] === 1) (this.DR0[i] = S.r1a), (this.DR1[i] = S.r1b), (this.SPC[i] = S.s1);
      else (this.DR0[i] = S.r2a), (this.DR1[i] = S.r2b), (this.SPC[i] = S.s2);
      this.AX[i] = S.X[i]!;
      this.AY[i] = S.Y[i]!;
    }
    this.setMed([S.s1, S.s2]);
  }

  private setMed(med: number[]) {
    med.sort((a, b) => a - b);
    this.medSpc = med.length ? med[Math.floor(med.length / 2)]! : 30;
    this.cs = Math.max(16, this.medSpc * PB.reach * 1.05);
  }

  cellOf(v: number): number {
    const c = Math.floor((v + this.GOFF) / this.GS);
    return c < 0 ? 0 : c >= this.GN ? this.GN - 1 : c;
  }
  /** Bucket every shown file by where it is (plus an offset, for the ripple's springs). */
  gridBuild(cs: number, DX?: Float32Array, DY?: Float32Array): void {
    this.GS = cs;
    this.GN = Math.ceil((2 * this.GOFF) / cs);
    if (!this.GH || this.GH.length < this.GN * this.GN) this.GH = new Int32Array(this.GN * this.GN);
    this.GH.fill(-1);
    for (let i = 0; i < this.n; i++) {
      if (this.ALPHA[i]! < 0.05) continue;
      const k = this.cellOf(this.Y[i]! + (DY ? DY[i]! : 0)) * this.GN + this.cellOf(this.X[i]! + (DX ? DX[i]! : 0));
      this.GNEXT[i] = this.GH[k]!;
      this.GH[k] = i;
    }
  }

  /** The files that move: shown and not pinned. */
  movers(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.n; i++) if (this.ALPHA[i]! >= 0.05 && !this.FIXD[i]) out.push(i);
    return out;
  }

  /** Back inside its domain, if it left it. */
  wall(i: number): void {
    const { X, Y, RAD, DR0, DR1, DA0, DA1 } = this;
    let r = Math.sqrt(X[i]! * X[i]! + Y[i]! * Y[i]!) || 0.01;
    const a = Math.atan2(Y[i]!, X[i]!);
    let r0 = DR0[i]! + RAD[i]! * 0.6;
    let r1 = DR1[i]! - RAD[i]! * 0.6;
    if (r1 < r0) r0 = r1 = (DR0[i]! + DR1[i]!) / 2;
    const mid = (DA0[i]! + DA1[i]!) / 2;
    const half = Math.max(0, (DA1[i]! - DA0[i]!) / 2 - (RAD[i]! * 0.6 + 1) / Math.max(r, 1));
    let da = a - mid;
    while (da > Math.PI) da -= TAU;
    while (da < -Math.PI) da += TAU;
    let hit = false;
    if (r < r0) (r = r0), (hit = true);
    else if (r > r1) (r = r1), (hit = true);
    if (da > half) (da = half), (hit = true);
    else if (da < -half) (da = -half), (hit = true);
    if (hit) {
      X[i] = r * Math.cos(mid + da);
      Y[i] = r * Math.sin(mid + da);
      this.VX[i]! *= 0.5;
      this.VY[i]! *= 0.5;
    }
  }

  /** One step for the files in `list` (`fixed` is the one under the hand). */
  step(list: readonly number[], alpha: number, fixed = -1): void {
    const m = this.m;
    const { X, Y, VX, VY, RAD, SPC, ALPHA, DR0, DR1, DA0, DA1, AX, AY, FIXD } = this;
    const ea = m.ea;
    const eb = m.eb;
    this.gridBuild(this.cs);
    const GH = this.GH!;
    const GN = this.GN;
    const GS = this.GS;
    const GNEXT = this.GNEXT;
    const ank = this.steps ? PB.anchorSteps : PB.anchor;
    for (let q = 0; q < list.length; q++) {
      const i = list[q]!;
      if (i === fixed || FIXD[i]) continue;
      const x = X[i]!;
      const y = Y[i]!;
      const u = SPC[i]!;
      const A = m.adj[i]!;
      const di = A.length + 1;
      let fx = 0;
      let fy = 0;
      const rr0 = Math.sqrt(x * x + y * y) || 1;
      const ux = x / rr0;
      const uy = y / rr0;
      for (let k = 0; k < A.length; k++) {
        const e = A[k]!;
        const j = ea[e] === i ? eb[e]! : ea[e]!;
        if (ALPHA[j]! < 0.05) continue;
        const dx = X[j]! - x;
        const dy = Y[j]! - y;
        const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const dj = m.adj[j]!.length + 1;
        if (DR0[j] !== DR0[i]) {
          // a link to another ring pulls only along the ring: it gathers files by angle
          const kk = (PB.link * PB.across * alpha * u * dj) / (di + dj) / d;
          const kx = dx * kk;
          const ky = dy * kk;
          const dot = kx * ux + ky * uy;
          fx += kx - dot * ux;
          fy += ky - dot * uy;
          continue;
        }
        const L0 = PB.len * 0.5 * (u + SPC[j]!) + RAD[i]! + RAD[j]!;
        const kk = (((d - L0) / d) * PB.link * alpha * dj) / (di + dj);
        fx += dx * kk;
        fy += dy * kk;
      }
      const R = PB.reach * u;
      const rc = Math.ceil(R / GS);
      const cx = this.cellOf(x);
      const cy = this.cellOf(y);
      const R2 = R * R;
      const gy1 = Math.min(GN - 1, cy + rc);
      const gx1 = Math.min(GN - 1, cx + rc);
      for (let gy = Math.max(0, cy - rc); gy <= gy1; gy++) {
        for (let gx = Math.max(0, cx - rc); gx <= gx1; gx++) {
          for (let j = GH[gy * GN + gx]!; j >= 0; j = GNEXT[j]!) {
            if (j === i) continue;
            let dx = x - X[j]!;
            let dy = y - Y[j]!;
            let d2 = dx * dx + dy * dy;
            if (d2 >= R2) continue;
            if (d2 < 0.0001) {
              dx = hash(i, j) - 0.5;
              dy = hash(j, i) - 0.5;
              d2 = dx * dx + dy * dy;
            }
            const d = Math.sqrt(d2);
            const t = 1 - d / R;
            const f = (PB.repel * u * (u / Math.max(d, u * 0.25)) * t * t * alpha) / d;
            fx += dx * f;
            fy += dy * f;
            const rr = RAD[i]! + RAD[j]! + 1.5;
            if (d < rr) {
              const c2 = ((rr - d) / d) * 0.35;
              fx += dx * c2;
              fy += dy * c2;
            }
          }
        }
      }
      // the faint pull to its place in the rings
      fx += (AX[i]! - x) * ank * alpha;
      fy += (AY[i]! - y) * ank * alpha;
      // the walls push softly from a little way off, so files don't pile up against them
      const mrg = u * 1.2;
      const mid = (DA0[i]! + DA1[i]!) / 2;
      const half = (DA1[i]! - DA0[i]!) / 2;
      let da = Math.atan2(y, x) - mid;
      while (da > Math.PI) da -= TAU;
      while (da < -Math.PI) da += TAU;
      const toA = (half - Math.abs(da)) * rr0;
      const toIn = rr0 - DR0[i]!;
      const toOut = DR1[i]! - rr0;
      if (toA < mrg) {
        const wf = PB.wall * u * Math.pow(1 - Math.max(0, toA) / mrg, 2) * alpha;
        const sg = da > 0 ? -1 : 1;
        fx += -uy * sg * wf;
        fy += ux * sg * wf;
      }
      if (toIn < mrg) {
        const wf = PB.wall * u * Math.pow(1 - Math.max(0, toIn) / mrg, 2) * alpha;
        fx += ux * wf;
        fy += uy * wf;
      }
      if (toOut < mrg) {
        const wf = PB.wall * u * Math.pow(1 - Math.max(0, toOut) / mrg, 2) * alpha;
        fx -= ux * wf;
        fy -= uy * wf;
      }
      VX[i] = (VX[i]! + fx) * PB.decay;
      VY[i] = (VY[i]! + fy) * PB.decay;
      X[i] = x + VX[i]!;
      Y[i] = y + VY[i]!;
      this.wall(i);
    }
  }
}

/** Free-layout ticks to settle the whole vault before it is shown. */
export const settleTicks = (n: number) => (n > 5000 ? 90 : 180);

/**
 * Settle a vault's Kind layout off screen, from `fromX/fromY`, cooling from `a0` over `ticks`.
 * Works in slices of about `sliceMs` (0: all at once) and gives up when `stale()` says so.
 */
export async function settleKind(
  m: Model,
  K: KindLayout,
  shown: (i: number) => boolean,
  opts: { fromX?: Float32Array; fromY?: Float32Array; ticks?: number; a0?: number; sliceMs?: number; stale?: () => boolean } = {},
): Promise<[Float32Array, Float32Array] | null> {
  const f = new Field(m);
  f.X.set(opts.fromX ?? K.X);
  f.Y.set(opts.fromY ?? K.Y);
  f.RAD.set(K.RAD);
  for (let i = 0; i < f.n; i++) f.ALPHA[i] = shown(i) ? 1 : 0;
  f.domainsKind(K);
  const list = f.movers();
  const ticks = opts.ticks ?? settleTicks(f.n);
  const a0 = opts.a0 ?? 1;
  const decay = Math.pow(0.04 / a0, 1 / ticks);
  let a = a0;
  let t = 0;
  const slice = opts.sliceMs ?? 0;
  while (t < ticks) {
    const t0 = performance.now();
    while (t < ticks && (!slice || performance.now() - t0 < slice)) {
      f.step(list, a);
      a *= decay;
      t++;
    }
    if (t < ticks) {
      await new Promise<void>((r) => setTimeout(r, 0));
      if (opts.stale?.()) return null;
    }
  }
  return [f.X, f.Y];
}
