/** Planning's month arrows: one press, one month — from any Monday. */
import { describe, expect, it } from "vitest";
import { mondayOf, shiftMonth } from "./calendarMath.js";

const monthOf = (d: Date) => d.getFullYear() * 12 + d.getMonth();

describe("shiftMonth", () => {
  it("moves exactly one month either way, from every Monday of two years", () => {
    for (let d = mondayOf(new Date(2026, 0, 5, 12)); d.getFullYear() < 2028; d = new Date(d.getTime() + 7 * 86_400_000)) {
      expect(monthOf(shiftMonth(d, 1)) - monthOf(d), d.toDateString()).toBe(1);
      expect(monthOf(shiftMonth(d, -1)) - monthOf(d), d.toDateString()).toBe(-1);
      expect(shiftMonth(d, 1).getDay()).toBe(1);
    }
  });

  it("walks through every month in order, none repeated or skipped", () => {
    let d = mondayOf(new Date(2026, 2, 2, 12)); // Monday 2 March — where +28 days went nowhere
    const seen: number[] = [];
    for (let i = 0; i < 24; i++) {
      d = shiftMonth(d, 1);
      seen.push(monthOf(d));
    }
    expect(seen).toEqual(Array.from({ length: 24 }, (_, i) => monthOf(new Date(2026, 2, 1)) + i + 1));
  });
});
