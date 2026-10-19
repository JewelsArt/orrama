/**
 * Today's heading: "Thursday 8 October" and its ISO week. The page header and the phone's top
 * bar both say it (the Today board), so App's title for `/today` comes from here too.
 */
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "Thursday 8 October"; "Thursday 8 October 2025" is never needed: it is always today. */
export const todayTitle = (d: Date = new Date()) => `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;

/**
 * Clay greets you on Today (19 Oct 2026, its board): "Good morning, Jules", by the clock and the
 * account's first name. Morning from 5 to noon, afternoon until 6, evening after (a night owl at
 * 2 a.m. is still in their evening). No name, no comma.
 */
export function greeting(d: Date = new Date(), displayName?: string | null): string {
  const h = d.getHours();
  const part = h >= 5 && h < 12 ? "morning" : h >= 12 && h < 18 ? "afternoon" : "evening";
  const first = (displayName ?? "").trim().split(/\s+/)[0];
  return first ? `Good ${part}, ${first}` : `Good ${part}`;
}

/** The ISO 8601 week number: weeks start on Monday, and week 1 holds the year's first Thursday. */
export function isoWeek(d: Date = new Date()): number {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dow = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dow); // the Thursday of this week decides its year
  const jan1 = Date.UTC(t.getUTCFullYear(), 0, 1);
  return Math.ceil(((t.getTime() - jan1) / 86_400_000 + 1) / 7);
}
