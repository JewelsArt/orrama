/**
 * Planning's model: everything the vault has dated, as one list of time items in one
 * vocabulary (structure.md §2.2), and the cuts the views make of it. Pure, so it is tested in
 * Node without the API client or a DOM.
 *
 *   booked time  bk  a block booked on a step, white with its area's edge
 *   event        ev  your own calendar's, panel fill
 *   subscribed   fd  a subscribed calendar's occurrence, dashed and read-only
 *   due          du  an open step's due day, a diamond
 *   key deadline key a `#deadline` step: the one red fill
 *   proposed     pp  Orr's proposal, hatched with his head; written nowhere until you book it
 *   money        mn  a subscription charge or income from the ledgers
 *   milestone    ms  a project's start or deadline (front matter), a diamond
 */
import type { CalEvent, DayMarker, PlanTask, TimeBlock } from "@basalt/schema/responses";
import { CATEGORIES } from "../categories.js";
import { DAY_MS, addDays, dayOf, isoDay } from "../calendarMath.js";

/** One block the auto-scheduler suggests. Nothing is written until it is booked. */
export interface Proposal {
  noteId: string;
  line: number;
  blockId: string | null;
  text: string;
  project: string | null;
  due: string | null;
  atRisk: boolean;
  date: string;
  startMin: number;
  durationMin: number;
  estimateHours: number;
}

export type ItemKind = "bk" | "ev" | "fd" | "du" | "key" | "pp" | "mn" | "ms";

/** The lane an item runs in: a life area's id, "calendar" for events, "dated" for the band. */
export type LaneId = string;

export interface Item {
  id: string;
  kind: ItemKind;
  date: string;
  /** Minutes since midnight; null for what has no time of day (due, money, all-day). */
  startMin: number | null;
  durationMin: number;
  title: string;
  /** A due step past its day: the only red mark that isn't a key deadline. */
  late: boolean;
  lane: LaneId;
  /** The project, or a feed's name: the line under the title. */
  project: string | null;
  /** All-day, from a calendar: sits in the dated band, not the hours. */
  allDay: boolean;
  /** What the item opens or changes. */
  task?: PlanTask;
  block?: TimeBlock;
  event?: CalEvent;
  marker?: DayMarker;
  proposal?: Proposal;
  /** Money: the signed amount and its currency. */
  amount?: number;
  currency?: string | null;
}

export const CALENDAR_LANE = "calendar";
export const DATED_LANE = "dated";

/** Same formatting as the Dashboard agenda: the currency's own decimals, a charge signed "−€13.99". */
export const money = (amount: number, currency: string | null | undefined) =>
  new Intl.NumberFormat("en-GB", { style: "currency", currency: currency || "EUR", signDisplay: amount < 0 ? "always" : "auto" }).format(amount);

/** "2h", "2.5h", "1.8h": hours as the boards print them. */
export const hoursLabel = (min: number) => {
  const h = min / 60;
  return Number.isInteger(h) ? `${h}h` : `${(Math.round(h * 10) / 10).toFixed(1)}h`;
};

/** A plan task's identity across loads. */
export const taskKey = (t: { noteId: string; line: number }) => `${t.noteId}:${t.line}`;

/**
 * Every item in [from, to], from the four sources: the plan's tasks (their blocks), events
 * (yours and subscribed), the dated markers, and Orr's proposals. `areaOf` gives a note's life
 * area (from the vault's #vault-categories, via the tree).
 */
export function buildItems({
  tasks,
  events,
  markers,
  proposals,
  areaOf,
  from,
  to,
}: {
  tasks: PlanTask[];
  events: CalEvent[];
  markers: DayMarker[];
  proposals: Proposal[];
  areaOf: (noteId: string) => string;
  from: string;
  to: string;
}): Item[] {
  const inRange = (d: string) => d >= from && d <= to;
  const out: Item[] = [];
  for (const t of tasks) {
    for (const b of t.blocks) {
      if (!inRange(b.date)) continue;
      out.push({ id: `b:${b.id}`, kind: "bk", date: b.date, startMin: b.startMin, durationMin: b.durationMin, title: t.text, late: false, lane: areaOf(t.noteId), project: t.project, allDay: false, task: t, block: b });
    }
  }
  for (const e of events) {
    if (!inRange(e.date)) continue;
    const kind: ItemKind = e.source === "ics" ? "fd" : "ev";
    out.push({ id: `e:${e.id}`, kind, date: e.date, startMin: e.allDay ? null : e.startMin, durationMin: e.allDay ? 0 : e.durationMin, title: e.title, late: false, lane: e.allDay ? DATED_LANE : CALENDAR_LANE, project: e.feedLabel ?? null, allDay: !!e.allDay, event: e });
  }
  const byLine = new Map(tasks.map((t) => [taskKey(t), t]));
  for (const m of markers) {
    if (!inRange(m.date)) continue;
    const task = m.noteId !== null && m.line !== null ? byLine.get(`${m.noteId}:${m.line}`) : undefined;
    const area = m.noteId ? areaOf(m.noteId) : DATED_LANE;
    if (m.kind === "due") {
      // A key deadline belongs to the dated row, above the horizon; an ordinary due day is
      // the step's own, in its area's lane.
      out.push({ id: `m:${m.id}`, kind: m.key ? "key" : "du", date: m.date, startMin: null, durationMin: 0, title: m.title, late: m.overdue, lane: m.key ? DATED_LANE : area, project: task?.project ?? m.source, allDay: false, marker: m, task });
    } else if (m.kind === "milestone") {
      out.push({ id: `m:${m.id}`, kind: "ms", date: m.date, startMin: null, durationMin: 0, title: m.title, late: false, lane: DATED_LANE, project: m.source, allDay: false, marker: m });
    } else {
      out.push({ id: `m:${m.id}`, kind: "mn", date: m.date, startMin: null, durationMin: 0, title: m.title, late: false, lane: DATED_LANE, project: m.source, allDay: false, marker: m, amount: m.amount ?? 0, currency: m.currency });
    }
  }
  proposals.forEach((p, i) => {
    if (!inRange(p.date)) return;
    out.push({ id: `p:${i}:${p.noteId}:${p.line}:${p.date}:${p.startMin}`, kind: "pp", date: p.date, startMin: p.startMin, durationMin: p.durationMin, title: p.text, late: false, lane: areaOf(p.noteId), project: p.project, allDay: false, proposal: p, task: byLine.get(taskKey(p)) });
  });
  return out;
}

/** The drawing order inside a day: key deadlines first, then by time, then what has none. */
const RANK: Record<ItemKind, number> = { key: 0, ms: 1, bk: 2, ev: 2, fd: 2, pp: 2, du: 3, mn: 4 };
export function byDay(a: Item, b: Item): number {
  if (RANK[a.kind] !== RANK[b.kind] && (RANK[a.kind] !== 2 || RANK[b.kind] !== 2)) return RANK[a.kind] - RANK[b.kind];
  return (a.startMin ?? 0) - (b.startMin ?? 0) || a.title.localeCompare(b.title);
}

/** The items of one day, in drawing order. */
export const itemsOn = (items: Item[], day: string) => items.filter((i) => i.date === day).sort(byDay);

export interface Lane {
  id: LaneId;
  label: string;
  color: string | null;
  /** The line under the lane's name: its projects this week, and how many are late. */
  note: string;
  items: Item[];
}

/**
 * The week as lanes: one per life area that has something in the week (in the areas' order),
 * then your calendar's events, then the areas with nothing, folded to one line each at the foot.
 */
export function weekLanes(items: Item[]): { lanes: Lane[]; quiet: Lane[] } {
  const lanes: Lane[] = [];
  const quiet: Lane[] = [];
  const known = new Set(CATEGORIES.map((c) => c.id));
  const areas = [...CATEGORIES.map((c) => ({ id: c.id, label: c.label, color: c.color }))];
  // A note whose area the rules don't know still gets a lane rather than vanishing.
  for (const i of items) if (i.lane !== DATED_LANE && i.lane !== CALENDAR_LANE && !known.has(i.lane) && !areas.some((a) => a.id === i.lane)) areas.push({ id: i.lane, label: "Other", color: "var(--c-other)" });
  for (const a of areas) {
    const mine = items.filter((i) => i.lane === a.id);
    const lane = { id: a.id, label: a.label, color: a.color, note: laneNote(mine), items: mine };
    (mine.length ? lanes : quiet).push(lane);
  }
  const cal = items.filter((i) => i.lane === CALENDAR_LANE);
  if (cal.length) {
    const feeds = cal.filter((i) => i.kind === "fd").length;
    lanes.push({ id: CALENDAR_LANE, label: "Calendar", color: null, note: `${cal.length - feeds} event${cal.length - feeds === 1 ? "" : "s"}${feeds ? ` · ${feeds} subscribed` : ""}`, items: cal });
  }
  return { lanes, quiet };
}

function laneNote(items: Item[]): string {
  const projects = [...new Set(items.map((i) => i.task?.project ?? null).filter((p): p is string => !!p))];
  const late = items.filter((i) => i.late).length;
  const what = projects.length === 0 ? "" : projects.length <= 2 ? projects.join(" · ") : `${projects.length} projects`;
  return [what, late ? `${late} late` : ""].filter(Boolean).join(" · ");
}

/**
 * What the next three weeks hold, down the week's right edge: key deadlines, milestones, due
 * steps, money and your own one-off events. A thing that happens every day (a standup, a
 * lecture series) is not news, so a title that repeats three times in the span is left out.
 */
export function nextWeeks(items: Item[], from: string, to: string, cap = 9): { shown: Item[]; more: number } {
  const span = items.filter((i) => i.date >= from && i.date <= to && i.kind !== "bk" && i.kind !== "pp" && i.kind !== "fd");
  const seen = new Map<string, number>();
  for (const i of span) if (i.kind === "ev") seen.set(i.title, (seen.get(i.title) ?? 0) + 1);
  const news = span.filter((i) => i.kind !== "ev" || (seen.get(i.title) ?? 0) < 3).sort((a, b) => a.date.localeCompare(b.date) || byDay(a, b));
  return { shown: news.slice(0, cap), more: Math.max(0, news.length - cap) };
}

/** Task minutes booked on a day: the hours beside each day's name. */
export const bookedOn = (items: Item[], day: string) => items.reduce((s, i) => (i.kind === "bk" && i.date === day ? s + i.durationMin : s), 0);

/**
 * The visible hour window. A full 24h of hairlines is mostly a picture of when nothing
 * happens — two thirds of it is asleep — so the day opens on the hours that get used and
 * *widens itself* around anything outside them. "Full day" forces the whole 24h back.
 */
export const DEFAULT_START = 7 * 60;
export const DEFAULT_END = 23 * 60;
export function windowFor(fullDay: boolean, spans: { startMin: number | null; durationMin: number }[]): readonly [number, number] {
  if (fullDay) return [0, 24 * 60] as const;
  let lo = DEFAULT_START;
  let hi = DEFAULT_END;
  for (const s of spans) {
    if (s.startMin === null) continue;
    lo = Math.min(lo, Math.floor(s.startMin / 60) * 60);
    hi = Math.max(hi, Math.ceil((s.startMin + s.durationMin) / 60) * 60);
  }
  return [Math.max(0, lo), Math.min(24 * 60, hi)] as const;
}

/** Where the hour grid opens: half an hour above the first timed item, else 08:00 (§2.2: not 11:30). */
export function firstScroll(items: Item[], dayStart: number): number {
  const starts = items.filter((i) => i.startMin !== null && !i.allDay).map((i) => i.startMin!);
  const first = starts.length ? Math.min(...starts) - 30 : 8 * 60;
  return Math.max(dayStart, first);
}

/* ---------- the header's counts ---------- */

/** "16 due · 4 late": steps due in the span, and open steps already past their day. */
export function dueCounts(items: Item[], backlog: PlanTask[], today: string): { due: number; late: number } {
  return {
    due: items.filter((i) => i.kind === "du" || i.kind === "key").length,
    late: backlog.filter((t) => t.due !== null && t.due < today).length,
  };
}

/* ---------- To plan ---------- */

export type ToPlanCut = "late" | "week" | "all";

/**
 * The backlog's three cuts (the board's tabs): late; due in the week on screen, from today on;
 * and everything still unplanned. Each in the order to plan it: soonest due first, the
 * undated last.
 */
export function toPlanCuts(backlog: PlanTask[], today: string, weekFrom: string, weekTo: string): Record<ToPlanCut, PlanTask[]> {
  const order = (a: PlanTask, b: PlanTask) => (a.due ?? "9999").localeCompare(b.due ?? "9999") || (a.priority ?? 9) - (b.priority ?? 9) || a.text.localeCompare(b.text);
  const all = [...backlog].sort(order);
  return {
    late: all.filter((t) => t.due !== null && t.due < today),
    week: all.filter((t) => t.due !== null && t.due >= today && t.due >= weekFrom && t.due <= weekTo),
    all,
  };
}

/** "4 days late", "due today", "due Fri", "due Fri 23 Oct": how far a step's day is. */
export function dueWords(due: string | null, today: string): { text: string; late: boolean } | null {
  if (!due) return null;
  const a = dayOf(today);
  const b = dayOf(due);
  if (!a || !b) return null;
  const days = Math.round((b.getTime() - a.getTime()) / DAY_MS);
  if (days < 0) return { text: `${-days} day${days === -1 ? "" : "s"} late`, late: true };
  if (days === 0) return { text: "due today", late: false };
  if (days === 1) return { text: "due tomorrow", late: false };
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][b.getDay()]!;
  return { text: days < 7 ? `due ${wd}` : `due ${wd} ${b.getDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][b.getMonth()]}`, late: false };
}

/* ---------- Orr's proposal ---------- */

const fmt = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const weekdayLong = (iso: string) => ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][dayOf(iso)!.getDay()]!;

/**
 * What Orr says about his proposal. One block gets the board's sentence ("The October slides
 * are due Saturday with no time booked. Friday 13:00–15:00 is free. Book it?"); several get
 * the count and the hours.
 */
export function proposalWords(proposals: Proposal[], today: string): { text: string; book: string } {
  if (proposals.length === 0) return { text: "No room left this week: every free hour is booked or past.", book: "" };
  if (proposals.length === 1) {
    const p = proposals[0]!;
    const due = p.due ? (p.due === today ? " is due today" : p.due < today ? ` was due ${weekdayLong(p.due)}` : ` is due ${weekdayLong(p.due)}`) : " has no day yet";
    const day = weekdayLong(p.date);
    return { text: `${p.text}${due} with no time booked. ${day} ${fmt(p.startMin)}–${fmt(p.startMin + p.durationMin)} is free. Book it?`, book: `Book ${day} ${fmt(p.startMin)}` };
  }
  const min = proposals.reduce((s, p) => s + p.durationMin, 0);
  const steps = new Set(proposals.map((p) => taskKey(p))).size;
  return { text: `${proposals.length} blocks, ${hoursLabel(min)}, for ${steps} step${steps === 1 ? "" : "s"}, the most urgent first, in hours that are free. They're hatched in the week; leave any out by clicking it. Book them?`, book: "Book them" };
}

/* ---------- the horizon ---------- */

/** Where now sits along a week's seven days, 0–1; null when the week isn't this one. */
export function nowAlong(weekStart: Date, now: Date): number | null {
  const from = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate()).getTime();
  const t = now.getTime();
  if (t < from || t >= addDays(weekStart, 7).getTime() - 12 * 3_600_000) return null;
  const dayIdx = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - from) / DAY_MS);
  return (dayIdx + (now.getHours() * 60 + now.getMinutes()) / 1440) / 7;
}

/** The seven days of a week, as YYYY-MM-DD. */
export const weekDays = (weekStart: Date) => Array.from({ length: 7 }, (_, i) => isoDay(addDays(weekStart, i)));
