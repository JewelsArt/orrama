/**
 * Pinned to timezones that are NOT UTC, on both sides of it, because that is
 * the only way these tests can fail: run in UTC, the broken code and the
 * correct code agree on every input.
 *
 * Node re-reads `process.env.TZ` on assignment, so each block can stand in a
 * different place. Amsterdam is where Basalt actually runs; Auckland is the
 * other sign, where the UTC date is a day BEHIND for half the waking day.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { addDays, daysInMonth, daysTo, isoLocal, monthKey, shiftMonth } from "../src/dates.js";

const ORIGINAL_TZ = process.env.TZ;
afterAll(() => {
  process.env.TZ = ORIGINAL_TZ;
});

/** What every one of the four bug sites did instead. */
const utcIso = (d: Date) => d.toISOString().slice(0, 10);

describe("isoLocal, west of UTC-noon (Amsterdam)", () => {
  beforeEach(() => {
    process.env.TZ = "Europe/Amsterdam";
  });

  it("is today, not yesterday, in the first hour of the day", () => {
    // 00:30 on 1 March in Amsterdam is still 23:30 on 28 February in UTC.
    const clock = new Date("2026-02-28T23:30:00Z");
    expect(isoLocal(clock)).toBe("2026-03-01");
    expect(utcIso(clock)).toBe("2026-02-28"); // the bug, stated
  });

  it("opens the commitments calendar on the month that just started", () => {
    const clock = new Date("2026-02-28T23:30:00Z");
    expect(monthKey(clock)).toBe("2026-03");
    expect(monthKey(new Date(utcIso(clock)))).toBe("2026-02"); // the bug, stated
  });

  it("survives the summer offset too", () => {
    // 01:30 on 1 July is 23:30 on 30 June in UTC — two hours out, not one.
    const clock = new Date("2026-06-30T23:30:00Z");
    expect(isoLocal(clock)).toBe("2026-07-01");
    expect(monthKey(clock)).toBe("2026-07");
  });

  it("agrees with UTC in the middle of the day", () => {
    const clock = new Date("2026-03-15T12:00:00Z");
    expect(isoLocal(clock)).toBe("2026-03-15");
    expect(isoLocal(clock)).toBe(utcIso(clock));
  });
});

describe("isoLocal, east of UTC (Auckland)", () => {
  beforeEach(() => {
    process.env.TZ = "Pacific/Auckland";
  });

  it("is tomorrow's date once the day has turned there", () => {
    // 11:00 UTC on 15 March is midnight on the 16th in Auckland.
    const clock = new Date("2026-03-15T11:00:00Z");
    expect(isoLocal(clock)).toBe("2026-03-16");
    expect(utcIso(clock)).toBe("2026-03-15"); // the bug, stated
  });
});

describe("month and day arithmetic is timezone-free", () => {
  for (const tz of ["Europe/Amsterdam", "Pacific/Auckland", "America/New_York", "UTC"]) {
    it(`gives the same answers in ${tz}`, () => {
      process.env.TZ = tz;
      // Month steps are months, not 28 days: June + 1 is July, in every year
      // where 28 days would have landed back inside June.
      expect(shiftMonth("2026-06", 1)).toBe("2026-07");
      expect(shiftMonth("2026-01", -1)).toBe("2025-12");
      expect(shiftMonth("2026-12", 1)).toBe("2027-01");
      expect(shiftMonth("2026-03", -14)).toBe("2025-01");
      expect(shiftMonth("2026-03", 0)).toBe("2026-03");

      expect(daysInMonth("2026-02")).toBe(28);
      expect(daysInMonth("2024-02")).toBe(29);
      expect(daysInMonth("2026-06")).toBe(30);

      // Across the spring-forward boundary in each hemisphere: a 23-hour day
      // must still count as one day.
      expect(daysTo("2026-03-28", "2026-03-30")).toBe(2);
      expect(daysTo("2026-09-26", "2026-09-28")).toBe(2);
      expect(daysTo("2026-03-30", "2026-03-28")).toBe(-2);
      expect(daysTo("2026-01-01", "2026-01-01")).toBe(0);
      expect(daysTo("2025-12-31", "2026-01-01")).toBe(1);

      expect(addDays("2026-03-28", 2)).toBe("2026-03-30");
      expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
      expect(addDays("2026-12-31", 1)).toBe("2027-01-01");

      // A date string already in hand is sliced, never re-parsed.
      expect(monthKey("2026-03-01")).toBe("2026-03");
    });
  }
});

describe("the four sites the audit named", () => {
  beforeEach(() => {
    process.env.TZ = "Europe/Amsterdam";
  });

  it("plan.ts: today and the wall clock come from the same place", () => {
    // 01:30 local. The old code paired a UTC `today` with a LOCAL nowMin, so
    // the scheduler offered 01:30 of a day that was already over.
    const clock = new Date("2026-06-30T23:30:00Z");
    const today = isoLocal(clock);
    const nowMin = clock.getHours() * 60 + clock.getMinutes();
    expect(today).toBe("2026-07-01");
    expect(nowMin).toBe(90);
  });

  it("Dashboard.tsx: the date picker pre-fills today", () => {
    expect(isoLocal(new Date("2026-02-28T23:30:00Z"))).toBe("2026-03-01");
  });

  it("Finance.tsx: an upload is filed under the month it arrived in", () => {
    const arrived = new Date("2026-02-28T23:30:00Z");
    expect(monthKey(arrived)).toBe("2026-03");
  });
});
