/**
 * When a message came, as the list says it: "10:01" today, "Yesterday", then "Tue 6 Oct"
 * (ui/dates.ts, with the year when it is not this one). The reader says the whole thing,
 * "Thu 8 Oct, 10:01" (dateTimeLabel).
 */
import { dateLabel, timeLabel, toDate } from "../ui/dates.js";

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

export function listWhen(iso: string | null, now: Date = new Date()): string {
  const d = iso ? toDate(iso) : null;
  if (!d) return "";
  if (dayKey(d) === dayKey(now)) return timeLabel(d);
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (dayKey(d) === dayKey(yesterday)) return "Yesterday";
  return dateLabel(d, now);
}
