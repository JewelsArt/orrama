/**
 * One date and time format (structure.md §8 #11): 24-hour, "Fri 9 Oct", the year only when it
 * is not this one, no seconds. Built from local fields, so these hold in any timezone.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { dateLabel, dateTimeLabel, dayMonthLabel, minutesLabel, monthLabel, timeLabel, toDate, weekdayLabel } from "./dates.js";

const now = new Date(2026, 9, 11, 12, 0); // Sun 11 Oct 2026

describe("dates", () => {
  it('read "Fri 9 Oct", with the year only when it is not this one', () => {
    expect(dateLabel(new Date(2026, 9, 9, 23, 59), now)).toBe("Fri 9 Oct");
    expect(dateLabel(new Date(2025, 9, 9), now)).toBe("Thu 9 Oct 2025");
    expect(dateLabel(new Date(2027, 0, 1), now)).toBe("Fri 1 Jan 2027");
  });

  it("a calendar date is that day, not the UTC day before or after", () => {
    expect(dateLabel("2026-10-03", now)).toBe("Sat 3 Oct");
    expect(toDate("2026-10-03")!.getHours()).toBe(0);
    expect(dayMonthLabel("2026-12-31", now)).toBe("31 Dec");
    expect(dayMonthLabel("2025-12-31", now)).toBe("31 Dec 2025");
  });

  it("times are the 24-hour clock, zero-padded, without seconds", () => {
    expect(timeLabel(new Date(2026, 9, 9, 9, 5, 59))).toBe("09:05");
    expect(timeLabel(new Date(2026, 9, 9, 21, 41))).toBe("21:41");
    expect(timeLabel(new Date(2026, 9, 9, 0, 0))).toBe("00:00");
    expect(minutesLabel(570)).toBe("09:30");
    expect(minutesLabel(21 * 60 + 41)).toBe("21:41");
    expect(minutesLabel(0)).toBe("00:00");
  });

  it('with a time: "Thu 8 Oct, 10:01"', () => {
    expect(dateTimeLabel(new Date(2026, 9, 8, 10, 1, 33), now)).toBe("Thu 8 Oct, 10:01");
    expect(dateTimeLabel(new Date(2026, 9, 8, 10, 1).getTime(), now)).toBe("Thu 8 Oct, 10:01");
  });

  it("weekdays and months in English, whatever the browser's language", () => {
    expect(weekdayLabel("2026-10-09")).toBe("Fri");
    expect(monthLabel("2026-10-09")).toBe("October 2026");
  });

  it("say nothing for a date that is not one", () => {
    expect([dateLabel("soon"), timeLabel(Number.NaN), dateTimeLabel("2026-13-45T99:99"), toDate("")]).toEqual(["", "", "", null]);
  });
});

describe("the app", () => {
  it("formats no date or time by itself: no 12-hour clock, no \"10-03\", no browser-locale dates", () => {
    const SRC = path.resolve(import.meta.dirname, "..");
    const files = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
        d.isDirectory() ? files(path.join(dir, d.name)) : /\.tsx?$/.test(d.name) && !/\.test\./.test(d.name) ? [path.join(dir, d.name)] : [],
      );
    const banned: [RegExp, string][] = [
      [/hour12|["'](AM|PM)["']/, "a 12-hour clock"],
      [/(due|Due|date|Date|deadline|Deadline)\??\.slice\(5\)/, "a 10-03 date"],
      [/toLocaleTimeString\(/, "a browser-locale time"],
      [/toLocaleDateString\((undefined|\))/, "a browser-locale date"],
      [/new Date\([^)]*\)\.toLocaleString\(\)/, "a browser-locale date and time"],
      [/toLocaleString\([^)]*\b(hour|minute|weekday|day|month)\b/, "a hand-made date and time"],
    ];
    const found = files(SRC).flatMap((f) =>
      fs
        .readFileSync(f, "utf8")
        .split("\n")
        .flatMap((line, i) => banned.filter(([re]) => re.test(line)).map(([, what]) => `${path.relative(SRC, f)}:${i + 1} ${what}`)),
    );
    expect(found).toEqual([]);
  });
});
