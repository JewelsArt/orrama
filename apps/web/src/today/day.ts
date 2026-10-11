/**
 * Today's timetable as numbers (structure.md §2.1): which hours the track shows, what is on
 * now and next, and Orr's pose at the present minute. Pure, so a test can hold the clock.
 *
 * Times are minutes past midnight, on the day being drawn.
 */
import type { OrrPose } from "../ui/orr/Orr.js";

/** A booked block (a task's time), an event of your own, or one from a subscribed calendar. */
export type ItemKind = "block" | "event" | "feed";

export interface DayItem {
  id: string;
  kind: ItemKind;
  title: string;
  start: number;
  end: number;
  /** The task's note and line, for a block (its card opens from the track). */
  noteId?: string | null;
  line?: number | null;
  /** The project a block's task belongs to. */
  project?: string | null;
}

/** 08:00–20:00 unless the day reaches further. */
export const DEFAULT_WINDOW = { from: 8 * 60, to: 20 * 60 };

/**
 * The hour track's window: 08–20 by default, widened to whole hours around the day's first and
 * last items, and around now, so neither Orr nor an early block ever falls off the edge.
 */
export function windowFor(items: DayItem[], now: number): { from: number; to: number } {
  let from = DEFAULT_WINDOW.from;
  let to = DEFAULT_WINDOW.to;
  for (const it of items) {
    from = Math.min(from, Math.floor(it.start / 60) * 60);
    to = Math.max(to, Math.ceil(it.end / 60) * 60);
  }
  from = Math.min(from, Math.floor(now / 60) * 60);
  to = Math.max(to, Math.ceil((now + 1) / 60) * 60);
  return { from: Math.max(0, from), to: Math.min(24 * 60, to) };
}

/** Where a minute sits on the track, 0–1. */
export const placeOn = (win: { from: number; to: number }, minute: number) => Math.max(0, Math.min(1, (minute - win.from) / (win.to - win.from)));

const isEvent = (it: DayItem) => it.kind === "event" || it.kind === "feed";
const during = (it: DayItem, now: number) => it.start <= now && now < it.end;

/** What is on at this minute (an event before a block, when both are), and what comes next. */
export function nowAndNext(items: DayItem[], now: number): { current: DayItem | null; next: DayItem | null } {
  const sorted = [...items].sort((a, b) => a.start - b.start || a.end - b.end);
  const on = sorted.filter((it) => during(it, now));
  const current = on.find(isEvent) ?? on[0] ?? null;
  const next = sorted.find((it) => it.start > now) ?? null;
  return { current, next };
}

/** An event within this many minutes: Orr points towards it. */
export const POINT_WITHIN = 15;
/** A free stretch at least this long: Orr sits. */
export const SIT_FROM = 60;

/**
 * Orr's pose on the timetable, which follows your day (structure.md §2.1, Jules 8 Oct):
 *
 *   you meet a key deadline or finish a project   Jump, once (`celebrate`)
 *   nothing on the day                             Sit (the empty Today, §5)
 *   during an event                                Hello, standing by
 *   an event starts within 15 minutes              Point, towards it
 *   during a booked block                          Read: focused with you
 *   before your first item                         Wave
 *   after your last item                           Doze
 *   a free stretch of an hour or more              Sit
 *   a shorter gap between two items                Hello
 */
export function poseAt(items: DayItem[], now: number, celebrate = false): OrrPose {
  if (celebrate) return "jump";
  if (items.length === 0) return "sit";
  if (items.some((it) => isEvent(it) && during(it, now))) return "hello";
  if (items.some((it) => isEvent(it) && it.start > now && it.start - now <= POINT_WITHIN)) return "point";
  if (items.some((it) => during(it, now))) return "read";
  const first = Math.min(...items.map((it) => it.start));
  const last = Math.max(...items.map((it) => it.end));
  if (now < first) return "wave";
  if (now >= last) return "doze";
  // Between two items: how long is the free stretch you are standing in?
  const before = Math.max(...items.filter((it) => it.end <= now).map((it) => it.end));
  const after = Math.min(...items.filter((it) => it.start > now).map((it) => it.start));
  return after - before >= SIT_FROM ? "sit" : "hello";
}

/** Minutes past midnight on a clock. */
export const minuteOf = (d: Date) => d.getHours() * 60 + d.getMinutes();
