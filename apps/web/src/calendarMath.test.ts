/** Planning's dates: month arrows, the week and month an address names, and what you type into the task card. */
import { describe, expect, it } from "vitest";
import {
  dayAt,
  isoDay,
  isoWeek,
  monthAt,
  mondayOf,
  parseDayInput,
  parseDurationInput,
  parsePlanInput,
  parseTimeInput,
  rangeLabel,
  shiftMonth,
  weekAt,
} from "./calendarMath.js";

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

const today = new Date(2026, 9, 8, 10, 40); // Thursday 8 October 2026, the boards' "now"

describe("the week, month and day an address names", () => {
  it("ISO weeks: week 41 of 2026 is 5–11 October; 1 January 2027 is still week 53 of 2026", () => {
    expect(isoWeek(new Date(2026, 9, 8, 12))).toEqual({ year: 2026, week: 41 });
    expect(isoWeek(new Date(2027, 0, 1, 12))).toEqual({ year: 2026, week: 53 });
    expect(isoWeek(new Date(2026, 0, 1, 12))).toEqual({ year: 2026, week: 1 });
    expect(isoWeek(new Date(2024, 11, 30, 12))).toEqual({ year: 2025, week: 1 });
  });

  it("a week is a day in it or its ISO number; nothing readable is this week", () => {
    expect(isoDay(weekAt("2026-10-08", today))).toBe("2026-10-05");
    expect(isoDay(weekAt("2026-10-05", today))).toBe("2026-10-05");
    expect(isoDay(weekAt("2026-W41", today))).toBe("2026-10-05");
    expect(isoDay(weekAt("2026-w01", today))).toBe("2025-12-29");
    expect(isoDay(weekAt(undefined, today))).toBe("2026-10-05");
    expect(isoDay(weekAt("next-tuesday", today))).toBe("2026-10-05");
    expect(isoDay(weekAt("2026-02-30", today))).toBe("2026-10-05");
    expect(isoDay(weekAt("2025-W53", today))).toBe("2026-10-05"); // 2025 has 52 weeks
  });

  it("every ISO week round-trips through its number for three years", () => {
    for (let d = new Date(2025, 0, 6, 12); d.getFullYear() < 2028; d = new Date(d.getTime() + 7 * 86_400_000)) {
      const { year, week } = isoWeek(d);
      expect(isoDay(weekAt(`${year}-W${String(week).padStart(2, "0")}`, today))).toBe(isoDay(d));
    }
  });

  it("a month is YYYY-MM (or a day in it); a day is YYYY-MM-DD", () => {
    expect(isoDay(monthAt("2026-11", today))).toBe("2026-11-01");
    expect(isoDay(monthAt("2026-11-17", today))).toBe("2026-11-01");
    expect(isoDay(monthAt("2026-13", today))).toBe("2026-10-01");
    expect(isoDay(monthAt(undefined, today))).toBe("2026-10-01");
    expect(isoDay(dayAt("2026-10-09", today))).toBe("2026-10-09");
    expect(isoDay(dayAt("someday", today))).toBe("2026-10-08");
  });

  it("ranges read as the boards write them", () => {
    expect(rangeLabel(new Date(2026, 9, 5), new Date(2026, 9, 11))).toBe("5–11 October");
    expect(rangeLabel(new Date(2026, 8, 28), new Date(2026, 9, 4))).toBe("28 September – 4 October");
    expect(rangeLabel(new Date(2026, 11, 28), new Date(2027, 0, 3))).toBe("28 December 2026 – 3 January 2027");
  });
});

describe("typing a day and a time into the task card", () => {
  it("weekdays are the next one, today included", () => {
    expect(parseDayInput("sat", today)).toBe("2026-10-10");
    expect(parseDayInput("Saturday", today)).toBe("2026-10-10");
    expect(parseDayInput("thu", today)).toBe("2026-10-08");
    expect(parseDayInput("wed", today)).toBe("2026-10-14");
    expect(parseDayInput("today", today)).toBe("2026-10-08");
    expect(parseDayInput("tomorrow", today)).toBe("2026-10-09");
  });

  it("a day and month, with or without the weekday the card shows", () => {
    expect(parseDayInput("Sat 10 Oct", today)).toBe("2026-10-10");
    expect(parseDayInput("10 october", today)).toBe("2026-10-10");
    expect(parseDayInput("oct 10", today)).toBe("2026-10-10");
    expect(parseDayInput("10/10", today)).toBe("2026-10-10");
    expect(parseDayInput("2 jan", today)).toBe("2027-01-02");
    expect(parseDayInput("Mon 5 Oct", today)).toBe("2026-10-05"); // read back off the card, though past
    expect(parseDayInput("Sat 2 Jan 2027", today)).toBe("2027-01-02");
    expect(parseDayInput("2026-10-20", today)).toBe("2026-10-20");
    expect(parseDayInput("12", today)).toBe("2026-10-12");
    expect(parseDayInput("3", today)).toBe("2026-11-03");
  });

  it("nonsense, impossible days and a weekday that disagrees are null", () => {
    for (const s of ["", "soon", "31 feb", "fri 10 oct", "2026-02-30", "13/13", "s"]) expect(parseDayInput(s, today), s).toBeNull();
  });

  it("times on the 24-hour clock, and lengths", () => {
    expect(parseTimeInput("11:00")).toBe(660);
    expect(parseTimeInput("9:30")).toBe(570);
    expect(parseTimeInput("14")).toBe(840);
    expect(parseTimeInput("930")).toBe(570);
    expect(parseTimeInput("1400")).toBe(840);
    expect(parseTimeInput("14h")).toBe(840);
    for (const s of ["24:00", "9:75", "noon", ""]) expect(parseTimeInput(s), s).toBeNull();
    expect(parseDurationInput("2.5h")).toBe(150);
    expect(parseDurationInput("2,5h")).toBe(150);
    expect(parseDurationInput("90m")).toBe(90);
    expect(parseDurationInput("90 min")).toBe(90);
    expect(parseDurationInput("1h30")).toBe(90);
    expect(parseDurationInput("1:30")).toBe(90);
    expect(parseDurationInput("2")).toBe(120);
    for (const s of ["0", "-1h", "lots", "25h"]) expect(parseDurationInput(s), s).toBeNull();
  });

  it("'sat 11:00' is a day and a time; 'sat' alone is a day", () => {
    expect(parsePlanInput("sat 11:00", today)).toEqual({ date: "2026-10-10", startMin: 660 });
    expect(parsePlanInput("fri 9 oct 14:30", today)).toEqual({ date: "2026-10-09", startMin: 870 });
    expect(parsePlanInput("tomorrow 9h", today)).toEqual({ date: "2026-10-09", startMin: 540 });
    expect(parsePlanInput("Sat 10 Oct", today)).toEqual({ date: "2026-10-10", startMin: null });
    expect(parsePlanInput("12", today)).toEqual({ date: "2026-10-12", startMin: null });
    expect(parsePlanInput("whenever 11:00", today)).toBeNull();
  });
});
