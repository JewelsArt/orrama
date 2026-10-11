import { describe, expect, it } from "vitest";
import { isoWeek, todayTitle } from "./title.js";

describe("Today's heading", () => {
  it("says the day in full", () => {
    expect(todayTitle(new Date(2026, 9, 8, 10, 40))).toBe("Thursday 8 October");
  });
  it("counts ISO weeks", () => {
    expect(isoWeek(new Date(2026, 9, 8))).toBe(41);
    expect(isoWeek(new Date(2026, 0, 1))).toBe(1); // a Thursday
    expect(isoWeek(new Date(2027, 0, 1))).toBe(53); // a Friday: still 2026's last week
    expect(isoWeek(new Date(2024, 11, 30))).toBe(1); // a Monday in 2025's first week
  });
});
