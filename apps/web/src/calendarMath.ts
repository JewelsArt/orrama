/**
 * Date arithmetic for the Planning calendar, kept apart from the components so it can be
 * tested without the API client: the week and month an address names, ISO weeks, the labels
 * the boards draw ("Week 41", "5–11 October"), and what you type into the task card ("sat
 * 11:00", "2.5h").
 *
 * Calendar dates are local days at noon: noon keeps a DST shift from moving the day.
 */

export const DAY_MS = 86_400_000;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const pad = (n: number) => String(n).padStart(2, "0");

/** A local day as YYYY-MM-DD. */
export const isoDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** The day YYYY-MM-DD names, at local noon; null for anything else, or a day that doesn't exist. */
export function dayOf(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
  return isoDay(d) === s ? d : null;
}

/** `n` days after `d` (before, for a negative n), at noon. */
export const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, 12);

/** The Monday of `d`'s week, at noon (noon keeps DST shifts from moving the day). */
export const mondayOf = (d: Date) => {
  const x = new Date(d);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  x.setHours(12, 0, 0, 0);
  return x;
};

/**
 * The anchor Monday for the month `delta` months from the one `weekStart` is in.
 *
 * The month view shows the month its anchor Monday falls in, and the arrows
 * used to add 28 days: from Monday 2 March that is 30 March, so "next" did
 * nothing, and elsewhere it skipped a month. The Monday of the week holding
 * the 8th always lies inside the month (between the 2nd and the 8th), unlike
 * the Monday of the 1st, which is often the month before.
 */
export const shiftMonth = (weekStart: Date, delta: number) =>
  mondayOf(new Date(weekStart.getFullYear(), weekStart.getMonth() + delta, 8, 12));

/** The ISO 8601 week `d` falls in: weeks start on Monday, week 1 holds the year's first Thursday. */
export function isoWeek(d: Date): { year: number; week: number } {
  const thursday = addDays(mondayOf(d), 3);
  const jan1 = new Date(thursday.getFullYear(), 0, 1, 12);
  return { year: thursday.getFullYear(), week: Math.floor(Math.round((thursday.getTime() - jan1.getTime()) / DAY_MS) / 7) + 1 };
}

/** The Monday of ISO week `week` of `year`. */
function mondayOfIsoWeek(year: number, week: number): Date {
  const jan4 = new Date(year, 0, 4, 12);
  return addDays(mondayOf(jan4), (week - 1) * 7);
}

/**
 * The Monday of the week an address names (`/planning/week/<at>`): a day in it (YYYY-MM-DD)
 * or the ISO week itself (2026-W41). Nothing, or nothing readable, is this week.
 */
export function weekAt(at: string | undefined, today: Date): Date {
  const w = at && /^(\d{4})-W(\d{1,2})$/i.exec(at);
  if (w) {
    const week = Number(w[2]);
    if (week >= 1 && week <= 53) {
      const monday = mondayOfIsoWeek(Number(w[1]), week);
      if (isoWeek(monday).week === week) return monday;
    }
  }
  const d = at ? dayOf(at) : null;
  return mondayOf(d ?? today);
}

/** The first of the month an address names (`/planning/month/2026-10`, or a day in it). */
export function monthAt(at: string | undefined, today: Date): Date {
  const m = at && /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(at);
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) return new Date(Number(m[1]), Number(m[2]) - 1, 1, 12);
  return new Date(today.getFullYear(), today.getMonth(), 1, 12);
}

/** The day an address names (`/planning/day/2026-10-08`); nothing, or nothing readable, is today. */
export const dayAt = (at: string | undefined, today: Date): Date => (at ? dayOf(at) : null) ?? new Date(today.getFullYear(), today.getMonth(), today.getDate(), 12);

/** YYYY-MM, a month's address. */
export const monthKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;

/** The six weeks a month view draws: Monday on or before the 1st, 42 days. */
export const monthCells = (first: Date): Date[] => {
  const start = mondayOf(first);
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
};

/** "Thursday". */
export const longWeekday = (d: Date) => WEEKDAYS[d.getDay()]!;

/** "October". */
export const longMonth = (d: Date) => MONTHS[d.getMonth()]!;

/** "5–11 October"; "28 September – 4 October" across a month; years only when they differ. */
export function rangeLabel(a: Date, b: Date): string {
  if (a.getFullYear() !== b.getFullYear()) return `${a.getDate()} ${longMonth(a)} ${a.getFullYear()} – ${b.getDate()} ${longMonth(b)} ${b.getFullYear()}`;
  if (a.getMonth() !== b.getMonth()) return `${a.getDate()} ${longMonth(a)} – ${b.getDate()} ${longMonth(b)}`;
  return `${a.getDate()}–${b.getDate()} ${longMonth(a)}`;
}

/* ---------- what you type into the task card ---------- */

const WEEKDAY_WORDS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MONTH_WORDS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * The day a few typed words name, from `today`: "today", "tomorrow", a weekday ("sat",
 * "Saturday": the next one, today included), "9 oct", "fri 9 oct", "oct 9", "9/10" (day
 * first), or YYYY-MM-DD. A day and month without a year is the next one on or after today.
 * Anything else is null.
 */
export function parseDayInput(text: string, today: Date): string | null {
  const s = text.trim().toLowerCase().replace(/,/g, " ").replace(/\s+/g, " ");
  if (!s) return null;
  const base = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 12);
  if (s === "today" || s === "tod") return isoDay(base);
  if (s === "tomorrow" || s === "tmr" || s === "tom") return isoDay(addDays(base, 1));
  if (dayOf(s)) return s;

  const words = s.split(" ");
  // A leading weekday is a check when a date follows ("fri 9 oct"), the day itself when alone.
  const wd = WEEKDAY_WORDS.findIndex((w) => words[0]!.startsWith(w) && WEEKDAYS[WEEKDAY_WORDS.indexOf(w)]!.toLowerCase().startsWith(words[0]!));
  const rest = wd >= 0 ? words.slice(1) : words;
  if (wd >= 0 && rest.length === 0) return isoDay(addDays(base, (wd - base.getDay() + 7) % 7));

  let day: number | null = null;
  let month: number | null = null;
  let year: number | null = null;
  // "Fri 9 Oct 2027", as the card shows a day in another year.
  if (rest.length === 3 && /^\d{4}$/.test(rest[2]!)) year = Number(rest.pop());
  const num = rest.join(" ");
  const slash = /^(\d{1,2})[/.-](\d{1,2})$/.exec(num);
  if (slash) {
    if (Number(slash[2]) < 1 || Number(slash[2]) > 12) return null;
    day = Number(slash[1]);
    month = Number(slash[2]) - 1;
  } else if (rest.length === 2) {
    const [x, y] = rest as [string, string];
    const mi = (w: string) => MONTH_WORDS.findIndex((m) => w.startsWith(m) && MONTHS[MONTH_WORDS.indexOf(m)]!.toLowerCase().startsWith(w));
    if (/^\d{1,2}$/.test(x) && mi(y) >= 0) [day, month] = [Number(x), mi(y)];
    else if (/^\d{1,2}$/.test(y) && mi(x) >= 0) [day, month] = [Number(y), mi(x)];
  } else if (rest.length === 1 && /^\d{1,2}$/.test(rest[0]!)) {
    // "9": the next 9th.
    day = Number(rest[0]);
    month = base.getDate() <= day ? base.getMonth() : base.getMonth() + 1;
  }
  if (day === null || month === null) return null;
  // Without a year: the next one on or after today; with a weekday, the year it falls on
  // that weekday (this year's first, so "Fri 9 Oct" read back off the card is that day).
  const years = year !== null ? [year] : [base.getFullYear(), base.getFullYear() + 1];
  for (const y of years) {
    const d: Date = new Date(y, month, day, 12);
    if (d.getMonth() !== ((month % 12) + 12) % 12 || d.getDate() !== day) continue; // 31 Feb, or 29 Feb in this year
    if (wd >= 0 ? d.getDay() === wd : year !== null || d.getTime() >= base.getTime()) return isoDay(d);
  }
  return null;
}

/** Minutes since midnight a typed time names: "11:00", "9:30", "11", "930", "1400", "14h". Null otherwise. */
export function parseTimeInput(text: string): number | null {
  const s = text.trim().toLowerCase().replace(/h$/, "");
  const m = /^(\d{1,2})(?::?(\d{2}))?$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** Minutes a typed length names: "2.5h", "2,5h", "90m", "90 min", "1h30", "1:30", "2" (hours). Null otherwise. */
export function parseDurationInput(text: string): number | null {
  const s = text.trim().toLowerCase().replace(",", ".").replace(/\s+/g, "");
  let m: RegExpExecArray | null;
  let min: number | null = null;
  if ((m = /^(\d+(?:\.\d+)?)h?$/.exec(s))) min = Number(m[1]) * 60;
  else if ((m = /^(\d+)(?:m|min|mins)$/.exec(s))) min = Number(m[1]);
  else if ((m = /^(\d+)(?:h|:)(\d{1,2})(?:m|min)?$/.exec(s))) min = Number(m[1]) * 60 + Number(m[2]);
  if (min === null || !Number.isFinite(min) || min <= 0 || min > 24 * 60) return null;
  return Math.round(min);
}

/**
 * "sat 11:00", "fri 9 oct 14:30", "tomorrow 9": a day and, when the last word is a time, a
 * time. What the task card's date field takes, so a step can be planned without a mouse.
 */
export function parsePlanInput(text: string, today: Date): { date: string; startMin: number | null } | null {
  const words = text.trim().split(/\s+/);
  if (words.length > 1 && /^\d{1,2}(:\d{2}|h)$|^\d{3,4}$/.test(words[words.length - 1]!)) {
    const t = parseTimeInput(words[words.length - 1]!);
    const date = parseDayInput(words.slice(0, -1).join(" "), today);
    if (t !== null && date) return { date, startMin: t };
  }
  const date = parseDayInput(text, today);
  return date ? { date, startMin: null } : null;
}
