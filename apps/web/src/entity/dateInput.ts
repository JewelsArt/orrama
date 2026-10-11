/**
 * A date typed as text, the way a person writes it: "19 Jan 2027", "19 January", "19/1/2027",
 * "2027-01-19", "today", "tomorrow". The project header used two native date fields, which
 * WebKit draws as "08/31/2026" and which change their value on every digit of a year (0002,
 * 0020, 0202, 2026 — each one written into the note, WEB-023). A text field changes nothing
 * until it is committed, and what it would write is said under it first.
 *
 * Day before month, as everywhere in the app ("Fri 9 Oct"). A year before 1900 is never a date:
 * only a half-typed year looks like one.
 */
import { addDays, isoLocal } from "@basalt/core/dates";

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

const pad = (n: number) => String(n).padStart(2, "0");

/** YYYY-MM-DD when y-m-d is a real day from 1900 on, else null. */
function real(y: number, m: number, d: number): string | null {
  if (!Number.isInteger(y) || y < 1900 || y > 9999 || m < 1 || m > 12 || d < 1) return null;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d > last ? null : `${y}-${pad(m)}-${pad(d)}`;
}

const monthOf = (word: string): number => {
  const w = word.toLowerCase().replace(/\.$/, "");
  // "Jan", "Sept", "January": three letters at least, and a beginning of the month's name.
  return w.length < 3 ? 0 : MONTHS.findIndex((m) => m.startsWith(w)) + 1;
};

/**
 * What a typed date means: an ISO date, "" for an empty field (the date is cleared), or null
 * for text that is not a date. A day and month without a year are this year.
 */
export function parseDateInput(text: string, today: string = isoLocal()): string | "" | null {
  const s = text.trim().replace(/,/g, " ").replace(/\s+/g, " ");
  if (s === "") return "";
  const low = s.toLowerCase();
  if (low === "today") return today;
  if (low === "tomorrow") return addDays(today, 1);
  if (low === "yesterday") return addDays(today, -1);
  const thisYear = Number(today.slice(0, 4));

  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return real(Number(m[1]), Number(m[2]), Number(m[3]));
  // 19/1/2027, 19-1-2027, 19.1.2027, and without the year.
  m = /^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{4}))?$/.exec(s);
  if (m) return real(m[3] ? Number(m[3]) : thisYear, Number(m[2]), Number(m[1]));
  // An optional weekday, then 19 Jan 2027 or Jan 19 2027.
  const words = s.split(" ").filter((w) => !/^(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?$/i.test(w));
  const [a = "", b = "", c, ...more] = words;
  if (more.length) return null;
  const year = c === undefined ? thisYear : /^\d{4}$/.test(c) ? Number(c) : NaN;
  if (/^\d{1,2}$/.test(a) && monthOf(b)) return real(year, monthOf(b), Number(a));
  if (monthOf(a) && /^\d{1,2}$/.test(b)) return real(year, monthOf(a), Number(b));
  return null;
}
