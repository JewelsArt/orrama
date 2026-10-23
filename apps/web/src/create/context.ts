/**
 * New (structure.md §1.3): one menu — a task, a note, an event, a project — prefilled for the
 * page you are on. This is the "prefilled": pure, from the address alone.
 *
 * - On a project: the task is a step in that project (its note's `## Tasks`), the note goes in
 *   its folder and joins it by its tag (CLAUDE.md "Projects are bound by tag").
 * - In Planning: the event and the task's due date are the day you are looking at (in a week
 *   or a month, today if it is in view, else its first day).
 * - In Notes: the note goes in the open note's folder.
 * - On the Projects board filtered to an area: the project is in that area, as the board's own
 *   New project makes it.
 * - Everywhere else: a task to your inbox, a note where you name it, an event today.
 */
import { dayAt, isoDay, monthAt, weekAt, addDays } from "../calendarMath.js";
import type { Route } from "../ui/router.js";

export interface NewContext {
  /** Where a task goes. */
  task: { project?: string; due?: string };
  /** The folder a note's name starts in, and the project it joins. */
  note: { folder: string; project?: string };
  /** The day an event is on. */
  event: { date: string };
  /** The life area a new project is made in (`POST /api/projects`), by id. */
  project: { area?: string };
}

/** The day a Planning address shows: the day itself, or today when it is in the week or month. */
function planningDay(r: Extract<Route, { kind: "planning" }>, today: Date): string {
  if (r.scale === "day") return isoDay(dayAt(r.at, today));
  const first = r.scale === "week" ? weekAt(r.at, today) : monthAt(r.at, today);
  const last = r.scale === "week" ? addDays(first, 6) : new Date(first.getFullYear(), first.getMonth() + 1, 0, 12);
  const t = isoDay(today);
  return t >= isoDay(first) && t <= isoDay(last) ? t : isoDay(first);
}

export function newContext(route: Route, today: Date = new Date()): NewContext {
  const base: NewContext = { task: {}, note: { folder: "" }, event: { date: isoDay(today) }, project: {} };
  switch (route.kind) {
    case "project":
      return { ...base, task: { project: route.slug }, note: { folder: `04-Projects/${route.slug}/`, project: route.slug } };
    case "planning": {
      const day = planningDay(route, today);
      return { ...base, task: { due: day }, event: { date: day } };
    }
    case "notes": {
      const path = route.path ?? "";
      const cut = path.lastIndexOf("/");
      return { ...base, note: { folder: cut === -1 ? "" : path.slice(0, cut + 1) } };
    }
    case "projects":
      return { ...base, project: route.area ? { area: route.area } : {} };
    default:
      return base;
  }
}
