/** Clay's reveal (ui/wavy.ts): the board's shape and timing, as keyframes the browser plays. */
import { describe, expect, it } from "vitest";
import { bezier, clayEase, waveHeight, wavyEdge, wavyKeyframes, WAVY_MS } from "./wavy.js";

const points = (poly: string) => [...poly.matchAll(/(-?[\d.]+)px (-?[\d.]+)px/g)].map((m) => [Number(m[1]), Number(m[2])] as const);

describe("the wavy reveal", () => {
  it("runs on Clay's timing: 780 ms, a soft start, a quick surge, a long settle", () => {
    expect(WAVY_MS).toBe(780);
    expect([clayEase(0), clayEase(1)]).toEqual([0, 1]);
    expect(clayEase(0.2)).toBeLessThan(0.1); // soft start
    expect(clayEase(0.5)).toBeGreaterThan(0.6); // the surge
    expect(clayEase(0.8)).toBeGreaterThan(0.95); // the settle
    expect(bezier(0, 0, 1, 1)(0.3)).toBeCloseTo(0.3, 4); // linear is linear
    for (let x = 0; x < 1; x += 0.05) expect(clayEase(x + 0.05)).toBeGreaterThanOrEqual(clayEase(x));
  });

  it("the edge waves a little: at most 3% of the radius or 22 px, calming to a circle", () => {
    expect(waveHeight(100, 0)).toBeCloseTo(3);
    expect(waveHeight(2000, 0)).toBe(22);
    expect(waveHeight(2000, 1)).toBe(0);
    const r = 400;
    const dist = (t: number) => wavyEdge(500, 300, r, t).map(([x, y]) => Math.hypot(x - 500, y - 300));
    const mid = dist(0.5);
    expect(Math.max(...mid) - r).toBeGreaterThan(1); // it does wave
    expect(Math.max(...mid.map((d) => Math.abs(d - r)))).toBeLessThanOrEqual(waveHeight(r, 0.5) + 1e-9);
    for (const d of dist(1)) expect(d).toBeCloseTo(r, 6);
  });

  it("as keyframes: from the control to the far corner, every shape with the same points", () => {
    const frames = wavyKeyframes(200, 100, 1600);
    expect(frames).toHaveLength(41);
    const shapes = frames.map(points);
    expect(new Set(shapes.map((s) => s.length))).toEqual(new Set([160])); // polygons only interpolate point for point
    for (const [x, y] of shapes[0]!) expect(Math.hypot(x - 200, y - 100)).toBeLessThan(2);
    for (const [x, y] of shapes.at(-1)!) expect(Math.hypot(x - 200, y - 100)).toBeCloseTo(1600, 0);
  });
});
