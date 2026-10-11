/**
 * Planning's addresses and its name: kept out of Planning.tsx so the shell can name the page
 * (the phone's top bar, the window title) without loading the page.
 */
import { dayAt, isoDay, isoWeek, longMonth, longWeekday, monthAt, monthKey, mondayOf, weekAt } from "../calendarMath.js";
import type { Route } from "../ui/router.js";

export type PlanningRoute = Extract<Route, { kind: "planning" }>;
type Scale = PlanningRoute["scale"];

/** The page's name, for the phone's top bar and the window: "Week 41", "October", "Thursday 8". */
export function planningTitle(r: PlanningRoute, now = new Date()): string {
  if (r.scale === "month") return longMonth(monthAt(r.at, now));
  if (r.scale === "day") {
    const d = dayAt(r.at, now);
    return `${longWeekday(d)} ${d.getDate()}`;
  }
  return `Week ${isoWeek(weekAt(r.at, now)).week}`;
}

/** The address of a scale at a date: no date when it is the one holding today. */
export function planningRoute(scale: Scale, at: Date, now = new Date()): PlanningRoute {
  if (scale === "month") return monthKey(at) === monthKey(now) ? { kind: "planning", scale } : { kind: "planning", scale, at: monthKey(at) };
  if (scale === "day") return isoDay(at) === isoDay(now) ? { kind: "planning", scale } : { kind: "planning", scale, at: isoDay(at) };
  const mon = mondayOf(at);
  return isoDay(mon) === isoDay(mondayOf(now)) ? { kind: "planning", scale } : { kind: "planning", scale, at: isoDay(mon) };
}

