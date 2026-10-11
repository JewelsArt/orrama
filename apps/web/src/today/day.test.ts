import { describe, expect, it } from "vitest";
import { minuteOf, nowAndNext, placeOn, poseAt, windowFor, type DayItem } from "./day.js";

const at = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return h * 60 + m;
};

/** A test day: a standup, a booked block, lunch, a free afternoon stretch, a feed event, a short gap, a last block. */
const DAY: DayItem[] = [
  { id: "standup", kind: "event", title: "Standup", start: at("09:30"), end: at("09:45") },
  { id: "report", kind: "block", title: "October report", start: at("09:45"), end: at("12:00") },
  { id: "lunch", kind: "event", title: "Lunch with Emma", start: at("12:30"), end: at("13:30") },
  { id: "workshop", kind: "feed", title: "Thesis workshop", start: at("15:00"), end: at("16:30") },
  { id: "letter", kind: "block", title: "Cover letter", start: at("16:45"), end: at("18:00") },
];

describe("Orr's pose follows the day (a fixed clock)", () => {
  const cases: [string, string][] = [
    ["07:10", "wave"], // before the first item
    ["09:10", "wave"], // still before it, the standup 20 minutes away
    ["09:15", "point"], // the standup starts within 15 minutes
    ["09:30", "hello"], // during the standup
    ["09:44", "hello"],
    ["09:45", "read"], // the booked block begins
    ["11:59", "read"],
    ["12:00", "hello"], // a 30-minute gap before lunch: too short to sit, too far to point
    ["12:20", "point"], // lunch within 15 minutes
    ["12:45", "hello"], // at lunch
    ["13:30", "sit"], // 13:30–15:00 is free: 90 minutes
    ["14:40", "sit"],
    ["14:46", "point"], // the workshop (a subscribed calendar's event) in 14 minutes
    ["15:10", "hello"], // in the workshop
    ["16:35", "hello"], // a 15-minute gap between two items
    ["16:50", "read"],
    ["18:00", "doze"], // after the last item
    ["23:30", "doze"],
  ];
  it.each(cases)("at %s Orr is %s", (time, pose) => {
    expect(poseAt(DAY, at(time))).toBe(pose);
  });

  it("jumps once when a key deadline is met or a project finishes, whatever the hour", () => {
    expect(poseAt(DAY, at("10:00"), true)).toBe("jump");
    expect(poseAt([], at("10:00"), true)).toBe("jump");
  });

  it("sits on an empty day", () => {
    expect(poseAt([], at("10:00"))).toBe("sit");
  });

  it("an event beats a block that overlaps it", () => {
    const overlap: DayItem[] = [
      { id: "b", kind: "block", title: "Deep work", start: at("10:00"), end: at("12:00") },
      { id: "e", kind: "event", title: "Call", start: at("11:00"), end: at("11:30") },
    ];
    expect(poseAt(overlap, at("10:50"))).toBe("point");
    expect(poseAt(overlap, at("11:10"))).toBe("hello");
    expect(poseAt(overlap, at("11:40"))).toBe("read");
  });

  it("reads the minute off the clock", () => {
    expect(minuteOf(new Date(2026, 9, 8, 10, 40))).toBe(at("10:40"));
  });
});

describe("the track", () => {
  it("opens on 08–20 and widens to whole hours around the day and around now", () => {
    expect(windowFor([], at("10:40"))).toEqual({ from: at("08:00"), to: at("20:00") });
    expect(windowFor([{ id: "x", kind: "block", title: "Run", start: at("06:30"), end: at("07:15") }], at("10:00"))).toEqual({ from: at("06:00"), to: at("20:00") });
    expect(windowFor(DAY, at("22:10"))).toEqual({ from: at("08:00"), to: at("23:00") });
    expect(windowFor([], at("06:59"))).toEqual({ from: at("06:00"), to: at("20:00") });
  });

  it("places minutes on it, clamped", () => {
    const win = { from: at("08:00"), to: at("20:00") };
    expect(placeOn(win, at("14:00"))).toBe(0.5);
    expect(placeOn(win, at("07:00"))).toBe(0);
    expect(placeOn(win, at("21:00"))).toBe(1);
  });

  it("says what is on now and what is next", () => {
    expect(nowAndNext(DAY, at("10:40"))).toMatchObject({ current: { id: "report" }, next: { id: "lunch" } });
    expect(nowAndNext(DAY, at("14:00"))).toMatchObject({ current: null, next: { id: "workshop" } });
    expect(nowAndNext(DAY, at("19:00"))).toEqual({ current: null, next: null });
  });
});
