/**
 * Clay's day ↔ night reveal (19 October 2026): the new mode spreads from the sun or moon as a
 * circle with a softly wavy edge, as in the Vertix reel. Jules: "a bit more wavy, like a little
 * bit", "a varying speed during it", "a bit faster than this".
 *
 * From the board's clay-switch.js (~/orrama-redesign/mockups/system/), the same numbers: two
 * ripples drifting opposite ways round the edge, at most 3% of the radius or 22 px high, calming
 * to a clean circle by the end; the radius follows cubic-bezier(.55, 0, .15, 1) over 780 ms
 * (a soft start, a quick surge, a long gentle settle). The board redraws a clone every frame,
 * which only suits the canvas; here the shape is precomputed as clip-path keyframes for
 * ::view-transition-new(root), played linearly between them, so the browser does the frames.
 */

export const WAVY_MS = 780;
/** Points round the edge: the ripples are 5 and 9 to a turn, so 160 keeps them smooth. */
const POINTS = 160;
const TAU = Math.PI * 2;

/** cubic-bezier(x1, y1, x2, y2) as CSS has it: solve x for t, return y. */
export function bezier(x1: number, y1: number, x2: number, y2: number): (x: number) => number {
  const c = (a1: number, a2: number, t: number) => ((1 - 3 * a2 + 3 * a1) * t + (3 * a2 - 6 * a1)) * t * t + 3 * a1 * t;
  const d = (a1: number, a2: number, t: number) => 3 * (1 - 3 * a2 + 3 * a1) * t * t + 2 * (3 * a2 - 6 * a1) * t + 3 * a1;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const dx = c(x1, x2, t) - x;
      const g = d(x1, x2, t);
      if (Math.abs(dx) < 1e-5 || !g) break;
      t -= dx / g;
    }
    return c(y1, y2, Math.min(1, Math.max(0, t)));
  };
}

export const clayEase = bezier(0.55, 0, 0.15, 1);

/** The ripple's height at radius r and time t (0…1): at most 3% of r or 22 px, gone by the end. */
export const waveHeight = (r: number, t: number) => Math.min(r * 0.03, 22) * (1 - t ** 3);

/** The edge at radius r and time t: POINTS points round (cx, cy). */
export function wavyEdge(cx: number, cy: number, r: number, t: number): [number, number][] {
  const amp = waveHeight(r, t);
  const p1 = t * 2.4;
  const p2 = -t * 1.7;
  const pts: [number, number][] = [];
  for (let i = 0; i < POINTS; i++) {
    const a = (i / POINTS) * TAU;
    const k = r + amp * (0.65 * Math.sin(5 * a + p1) + 0.35 * Math.sin(9 * a + p2));
    pts.push([cx + k * Math.cos(a), cy + k * Math.sin(a)]);
  }
  return pts;
}

const polygon = (pts: [number, number][]) => `polygon(${pts.map(([x, y]) => `${x.toFixed(1)}px ${y.toFixed(1)}px`).join(", ")})`;

/**
 * The reveal's clip-path keyframes from (x, y) until a radius of `reach` covers the window:
 * `frames` + 1 shapes at even steps of time, the radius eased, to be played linearly.
 */
export function wavyKeyframes(x: number, y: number, reach: number, frames = 40): string[] {
  const out: string[] = [];
  for (let i = 0; i <= frames; i++) {
    const t = i / frames;
    out.push(polygon(wavyEdge(x, y, Math.max(1, reach * clayEase(t)), t)));
  }
  return out;
}
