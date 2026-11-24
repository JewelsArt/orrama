/**
 * Planning's "Next three weeks" (2L follow-up): a repeating event of yours, as `/api/events`
 * expands it, is said once on its next day with how it repeats, as Today's Coming up says it,
 * across a month's end and the night the clocks go back (Europe, Sun 25 Oct 2026).
 */
process.env.TZ = "Europe/Amsterdam";

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { addDays, isoDay } from "../calendarMath.js";
import { event } from "../test/planning-fixtures.js";
import { Lanes } from "./Lanes.js";
import { buildItems } from "./model.js";

const weekStart = new Date(2026, 9, 12, 12); // Mon 12 Oct: its next three weeks are 19 Oct – 8 Nov
const days = Array.from({ length: 7 }, (_, i) => isoDay(addDays(weekStart, i)));
const noop = () => {};

/** A weekly series as `/api/events` sends it: one row per day, `<seriesId>@<day>`, the same 18:00 through the change of clocks. */
const choir = ["2026-10-14", "2026-10-21", "2026-10-28", "2026-11-04"].map((d) =>
  event({ id: `ev-choir@${d}`, seriesId: "ev-choir", repeat: { every: "week", interval: 1, until: null }, date: d, title: "Choir", startMin: 18 * 60, durationMin: 90 }),
);

function show(events = choir) {
  const items = buildItems({ tasks: [], events, markers: [], proposals: [], areaOf: () => "personal", from: days[0]!, to: isoDay(addDays(weekStart, 27)) });
  render(<Lanes weekStart={weekStart} days={days} items={items} today="2026-10-12" now={new Date(2026, 9, 12, 9)} unplanned={0} onOpen={noop} onMove={noop} onAdd={noop} onOpenDay={noop} onOpenMonth={noop} onPickSome={noop} colorOf={() => null} />);
  return screen.getByRole("complementary", { name: "Next three weeks" });
}

describe("the next three weeks", () => {
  it("says a weekly event once, on its next day in the span, with how it repeats", () => {
    const fut = show();
    expect(fut.textContent).toContain("19 October – 8 November");
    const rows = within(fut).getAllByRole("button");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toBe("Wed 21Choir18:00 · Every week");
    expect(within(fut).queryByText("Nothing dated yet.")).toBeNull();
  });

  it("starts a series that begins inside the span on its first day there, after the clocks go back and into November", () => {
    const fut = show(choir.filter((e) => e.date >= "2026-10-28"));
    expect(within(fut).getAllByRole("button").map((b) => b.textContent)).toEqual(["Wed 28Choir18:00 · Every week"]);
  });
});
