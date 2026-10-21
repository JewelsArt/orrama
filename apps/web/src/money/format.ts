/**
 * Money's words and numbers: how an amount, a month and a file size are written, and the small
 * pure helpers the pages share. The arithmetic here is the old Finance page's, moved, not
 * changed: a redesign changes how money looks, never what it adds up to.
 */
import { chargeDates, type Cadence } from "@orrama/core/subscriptions";
import type { Ledger } from "@orrama/schema/responses";
import { dayMonthLabel, monthLabel, weekdayLabel } from "../ui/dates.js";

/** "€1,372.02", "−€6.40": en-GB grouping whatever the browser's language. */
export const eur = (n: number, currency = "EUR") =>
  new Intl.NumberFormat("en-GB", { style: "currency", currency, signDisplay: n < 0 ? "always" : "auto" }).format(n);

/**
 * Ledger totals, one per currency, each in its own: "€1,500.00 · $500.00". Never summed — a $12
 * subscription is not €12, and there is no rate here to make it one (FIN-017).
 */
export const perCurrency = (totals: { currency: string; monthly: number }[]) =>
  totals.length === 0 ? eur(0) : totals.map((t) => eur(t.monthly, t.currency)).join(" · ");

/** A chart's axis: "€500", "€1.4k". */
export const axisEur = (v: number) => `€${v >= 1000 ? `${Math.round(v / 100) / 10}k` : Math.round(v)}`;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day1 = (m: string) => `${m}-01`;

/** "Sep 2026": a month, never "Sep 26", which reads like a date (Jules, 11 Oct). */
export const monthName = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1] ?? m} ${m.slice(0, 4)}`;
/** "Sep": a chart's column, under a heading that already says the year. */
export const monthShort = (m: string) => MONTHS[Number(m.slice(5, 7)) - 1] ?? m;
/** "September 2026". */
export const monthLong = (m: string) => monthLabel(day1(m));
/** "September": inside a page that already names the year. */
export const monthWord = (m: string) => monthLong(m).split(" ")[0]!;
/** "3 Sep", "3 Sep 2025": a day, with the year when it is not this one. */
export const dayLabel = (iso: string) => dayMonthLabel(iso);
/** "Wed". */
export const weekday = (iso: string) => weekdayLabel(iso);
/** "48 KB". */
export const kb = (n: number) => (n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
/** "1 purchase", "9 purchases". */
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Round axis values: 1, 2, 2.5 or 5 times a power of ten. A chart whose gridlines read €317 /
 * €634 / €951 is arithmetically correct and useless — the reader has to divide to place a bar.
 */
export function niceTicks(max: number, count = 4): number[] {
  if (max <= 0) return [];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].find((m) => m * mag >= raw)! * mag;
  const out: number[] = [];
  for (let v = step; v <= max * 1.0001; v += step) out.push(Math.round(v * 100) / 100);
  return out;
}

/** Days already elapsed in the month the data reaches, and the month's length. */
export function monthPace(dataThrough: string | null): { elapsed: number; length: number } | null {
  if (!dataThrough) return null;
  const [y, m, d] = dataThrough.split("-").map(Number) as [number, number, number];
  return { elapsed: d, length: new Date(Date.UTC(y, m, 0)).getUTCDate() };
}

/**
 * The month so far, projected to its end — only once there is enough of it to extrapolate from:
 * three days times ten is arithmetic, not a forecast.
 */
export const projectedSpend = (soFar: number, pace: { elapsed: number; length: number } | null) =>
  pace && pace.elapsed >= 7 ? Math.round((soFar / pace.elapsed) * pace.length) : null;

/** Days in a YYYY-MM month. */
export const daysIn = (m: string) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).getUTCDate();

/**
 * Which days of `month` a ledger line charges on. The note records ONE date plus a cadence, so
 * the calendar projects the rest — with core's `chargeDates`, the function the Planning band
 * uses, counting every charge from the note's own date (FIN-003).
 */
export function chargeDays(month: string, anchor: string | null, cadence: string): number[] {
  if (!anchor) return [];
  return chargeDates(anchor, cadence as Cadence, `${month}-01`, `${month}-31`).map((d) => Number(d.slice(8, 10)));
}

/** What the server says one uploaded statement added (FIN-007). */
export interface StatementRead {
  rows: number;
  skipped: number;
  first: string | null;
  last: string | null;
  reason: string | null;
}

/** The upload's answer for a statement: what it added, or why it adds nothing. */
export function statementFlash(name: string, st: StatementRead | null): string {
  if (!st) return `Stored ${name}.`;
  if (st.reason) return `Stored ${name}, but it is left out of the figures: ${st.reason}.`;
  const span = st.first && st.last ? `, ${dayLabel(st.first)} to ${dayLabel(st.last)}` : "";
  const skipped = st.skipped ? ` (${plural(st.skipped, "row")} skipped: not settled, unreadable or in another currency)` : "";
  return `Read ${plural(st.rows, "transaction")} from ${name}${span}${skipped}.`;
}

/** " · 2 rows not counted", or nothing: the overview's half of FIN-006. */
export const notCounted = (l: Ledger) => (l.unreadable.length ? ` · ${plural(l.unreadable.length, "row")} not counted` : "");
