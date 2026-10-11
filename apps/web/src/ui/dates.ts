/**
 * Dates and times, one way everywhere (structure.md §8 #11): the 24-hour clock ("09:30"), and
 * dates as "Fri 9 Oct", "Fri 9 Oct 2025" when the year is not this one; with a time,
 * "Thu 8 Oct, 10:01", never seconds. Before this, Today's clock read "9:41 PM", task chips
 * "10-03", and Mail and Planning whatever the browser's language and region made of a date
 * (seconds included, Dutch month names on a Dutch Mac).
 *
 * Names are English whatever the browser's language, like the rest of the app. A calendar
 * date (YYYY-MM-DD) is that day wherever you are; a timestamp reads in local time.
 */

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** A timestamp (ms), an ISO date-time, a calendar date (YYYY-MM-DD), or a Date. */
export type When = Date | string | number;

const pad = (n: number) => String(n).padStart(2, "0");

/** The Date a When names; a calendar date is its local midnight, not UTC's. Invalid → null. */
export function toDate(when: When): Date | null {
  let d: Date;
  if (when instanceof Date) d = when;
  else if (typeof when === "string" && /^\d{4}-\d{2}-\d{2}$/.test(when)) {
    const [y, m, day] = when.split("-").map(Number) as [number, number, number];
    d = new Date(y, m - 1, day);
  } else d = new Date(when);
  return Number.isNaN(d.getTime()) ? null : d;
}

const year = (d: Date, now: Date) => (d.getFullYear() === now.getFullYear() ? "" : ` ${d.getFullYear()}`);

/** "Fri 9 Oct"; "Fri 9 Oct 2025" when the year is not this one. */
export function dateLabel(when: When, now: Date = new Date()): string {
  const d = toDate(when);
  return d ? `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}${year(d, now)}` : "";
}

/** "9 Oct", where a weekday would crowd it (a range, a narrow column). */
export function dayMonthLabel(when: When, now: Date = new Date()): string {
  const d = toDate(when);
  return d ? `${d.getDate()} ${MONTHS[d.getMonth()]}${year(d, now)}` : "";
}

/** "October 2026". */
export function monthLabel(when: When): string {
  const d = toDate(when);
  return d ? `${MONTHS_LONG[d.getMonth()]} ${d.getFullYear()}` : "";
}

/** "Fri". */
export function weekdayLabel(when: When): string {
  const d = toDate(when);
  return d ? DAYS[d.getDay()]! : "";
}

/** "09:30", the 24-hour clock. */
export function timeLabel(when: When): string {
  const d = toDate(when);
  return d ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : "";
}

/** Minutes since midnight on the 24-hour clock: 570 → "09:30". */
export const minutesLabel = (minutes: number): string => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;

/** "Thu 8 Oct, 10:01". */
export function dateTimeLabel(when: When, now: Date = new Date()): string {
  const d = toDate(when);
  return d ? `${dateLabel(d, now)}, ${timeLabel(d)}` : "";
}
