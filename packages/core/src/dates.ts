/**
 * Calendar dates, in the timezone the person is standing in.
 *
 * Four helpers existed under four names and two different meanings, and the
 * two meanings disagree for one to two hours every single day (audit). The
 * split is always the same mistake: `new Date().toISOString().slice(0, 10)`
 * looks like "today" and is actually "today in UTC".
 *
 * In Amsterdam (UTC+1, UTC+2 in summer) that is yesterday from midnight until
 * 01:00 or 02:00 — the Dashboard's date picker pre-filled yesterday, the
 * commitments calendar opened on the wrong month in the first hours of a new
 * month, an uploaded document was filed under the previous month, and the
 * auto-scheduler offered a workday that had already ended. East of UTC the
 * error runs the other way: in Auckland the UTC date is a day BEHIND from
 * 13:00 local, so the scheduler silently drops tomorrow.
 *
 * Two rules, and they are not the same rule:
 *
 *   - Reading a clock is LOCAL. What day is it, what month is it — those are
 *     questions about the person's calendar, so they use `getFullYear` and
 *     friends, never the UTC pair.
 *   - Arithmetic on a date that is already a `YYYY-MM-DD` is UTC, because a
 *     date string has no time of day and stepping it through a DST boundary in
 *     local time lands on 23:00 the day before. `Gantt.tsx` had this right
 *     first: local fields in, a UTC midnight to count with.
 *
 * Nothing here takes or returns a `Date` with a time on it. The whole class of
 * bug comes from mixing an instant with a calendar day, so these types keep
 * them apart: `Date` only ever enters as "the clock", and everything else is a
 * string.
 */

const MS_DAY = 86_400_000;

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * The date on the wall calendar, `YYYY-MM-DD`. Defaults to now.
 *
 * This is the replacement for `new Date().toISOString().slice(0, 10)`
 * everywhere that string meant "today".
 */
export function isoLocal(clock: Date = new Date()): string {
  return `${clock.getFullYear()}-${pad(clock.getMonth() + 1)}-${pad(clock.getDate())}`;
}

/**
 * The month, `YYYY-MM`. Takes either the clock (read locally) or a date string
 * already in hand (sliced, never re-parsed — parsing it would reintroduce the
 * timezone the string does not have).
 */
export function monthKey(on: Date | string = new Date()): string {
  return typeof on === "string" ? on.slice(0, 7) : `${on.getFullYear()}-${pad(on.getMonth() + 1)}`;
}

/** Midnight UTC on a `YYYY-MM-DD`, the fixed point all the arithmetic uses. */
function utcMidnight(iso: string): number {
  return Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
}

/**
 * Step a `YYYY-MM` by whole months. `shiftMonth("2026-01", 1)` is `"2026-02"`.
 *
 * Month arithmetic, not 28 days: `Planning.tsx` moved "next month" by 28 days,
 * so four times a year the button did nothing at all.
 */
export function shiftMonth(month: string, by: number): string {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7)) - 1 + by;
  return `${y + Math.floor(m / 12)}-${pad(((m % 12) + 12) % 12 + 1)}`;
}

/** How many days a `YYYY-MM` has. */
export function daysInMonth(month: string): number {
  return new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
}

/**
 * Whole days from one date to another; negative when `to` is the earlier one.
 * Counted between UTC midnights, so a DST change cannot make a day 23 hours
 * long and round the answer down.
 */
export function daysTo(from: string, to: string): number {
  return Math.round((utcMidnight(to) - utcMidnight(from)) / MS_DAY);
}

/** Step a `YYYY-MM-DD` by whole days. */
export function addDays(iso: string, days: number): string {
  return new Date(utcMidnight(iso) + days * MS_DAY).toISOString().slice(0, 10);
}
