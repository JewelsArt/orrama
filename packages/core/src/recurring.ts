/**
 * Charges that repeat: the subscriptions you never wrote down.
 *
 * The signal is not "same merchant" — a bouldering gym takes €9.45 for a drop-in
 * and €57.00 for the membership in the same week, and grouping by merchant
 * merges the two into an average that is neither. The signal is **same merchant
 * AND same amount, landing at a regular interval**. A membership is a standing
 * order: the number does not move, and that is exactly what makes it findable.
 *
 * Two consequences worth knowing.
 *
 * A price change starts a new run. When Jules's rent went from €589.79 to
 * €608.99 the old run ended and a new one began, which is correct — a changed
 * price IS a different standing amount, and reporting one blended figure would
 * describe a month that never happened.
 *
 * So does switching supplier. Bouldermuur at €57.00 and Buckaroo Stichting
 * Derdengelden at €56.70 are the same membership at two gyms, and nothing in
 * the bank data connects them. The detector reports both runs and the vault
 * says they are one thing; guessing that two merchants are "really" the same
 * because their prices are close is the kind of inference that quietly files a
 * cancelled service as ongoing.
 */
import { matchesTerms } from "./spending.js";
import type { StatementRow } from "./statement.js";
import type { Cadence } from "./subscriptions.js";

export interface RecurringCharge {
  /** The merchant as the statement writes it. */
  merchant: string;
  /** The amount that keeps repeating, in major units. */
  amount: number;
  /** Distinct months it landed in, oldest first. */
  months: string[];
  /**
   * The rhythm, in the ledger's own words when it has one — weekly, biweekly,
   * monthly, quarterly… — or null for a month spacing the ledger has no word
   * for (`everyMonths` then says it).
   */
  cadence: Cadence | null;
  /** Months between charges for a monthly-or-longer rhythm; 0 for weekly ones. */
  everyMonths: number;
  /** How many times it was charged. */
  charges: number;
  first: string;
  last: string;
  /** What the run has cost so far: amount × charges. */
  total: number;
  /**
   * Still running as of the last data. A run that stopped is worth MORE
   * attention than one that continues — it is either a cancellation you already
   * made, or a service that silently lapsed.
   */
  active: boolean;
}

const norm = (s: string) => s.trim().replace(/\s+/g, " ");
const monthOf = (iso: string) => iso.slice(0, 7);
const monthsBetween = (a: string, b: string) => {
  const [y1, m1] = a.split("-").map(Number) as [number, number];
  const [y2, m2] = b.split("-").map(Number) as [number, number];
  return (y2 - y1) * 12 + (m2 - m1);
};
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const MONTH_CADENCE: Record<number, Cadence> = { 1: "monthly", 2: "2-monthly", 3: "quarterly", 6: "half-yearly", 12: "yearly" };

/**
 * A rhythm measured in days: every gap a whole number of `period` days (a
 * day either way — banks book late), most of them exactly one period. A
 * skipped week (a holiday) is still weekly; a gap of ten days is not.
 */
function everyDays(dates: string[], period: number): boolean {
  const gaps = dates.slice(1).map((d, i) => daysBetween(dates[i]!, d));
  if (gaps.length === 0) return false;
  const whole = gaps.every((g) => g > 0 && Math.abs(g - period * Math.max(1, Math.round(g / period))) <= 1);
  const single = gaps.filter((g) => Math.abs(g - period) <= 1).length;
  return whole && single * 2 > gaps.length;
}

/**
 * Find the repeating charges on a statement.
 *
 * `minMonths` is 3 by default, and that floor is doing real work: two charges
 * of the same size is a coincidence a €1.47 sandwich will produce every month
 * of the year. Three in a regular rhythm is a standing order. A weekly,
 * biweekly or 4-weekly rhythm is read from the days between charges (four of
 * them for the first two); anything monthly or longer is read from the
 * months, one charge each.
 *
 * Two things the month-only version got wrong (audit FIN-012): a weekly class
 * collapsed to "monthly" at a quarter of what it cost, because the total was
 * amount × months; and a standing deposit into an own account — a broker, a
 * savings pot — was offered as a subscription the note had not caught up with,
 * when ownAccounts.ts defines it as money moved and never spending.
 */
export function findRecurring(
  rows: StatementRow[],
  { minMonths = 3, dataThrough = "" }: { minMonths?: number; dataThrough?: string } = {},
): RecurringCharge[] {
  const runs = new Map<string, { merchant: string; amount: number; dates: string[] }>();
  for (const r of rows) {
    if (r.amount >= 0 || r.own) continue;
    const merchant = norm(r.description);
    const amount = Math.round(-r.amount * 100) / 100;
    if (amount <= 0) continue;
    const key = `${merchant.toUpperCase()}|${amount.toFixed(2)}`;
    const run = runs.get(key) ?? { merchant, amount, dates: [] };
    run.dates.push(r.date);
    runs.set(key, run);
  }

  const out: RecurringCharge[] = [];
  for (const run of runs.values()) {
    const dates = [...run.dates].sort();
    const months = [...new Set(dates.map(monthOf))].sort();
    let cadence: Cadence | null;
    let every = 0;
    let periodDays: number;
    if (dates.length >= Math.max(4, minMonths) && everyDays(dates, 7)) {
      cadence = "weekly";
      periodDays = 7;
    } else if (dates.length >= Math.max(4, minMonths) && everyDays(dates, 14)) {
      cadence = "biweekly";
      periodDays = 14;
    } else if (dates.length >= minMonths && everyDays(dates, 28)) {
      // A Dutch 4-weekly payment lands twice in one month a year, so it can
      // never pass the one-charge-a-month rule below.
      cadence = "4-weekly";
      periodDays = 28;
    } else {
      // Monthly or longer: one charge a month, at a regular spacing. An
      // irregular run of identical amounts is a habit (the same coffee, the
      // same tram fare), not a standing order — and so is one that lands
      // several times in some month without a weekly rhythm.
      if (months.length < minMonths || dates.length !== months.length) continue;
      const gaps = months.slice(1).map((m, i) => monthsBetween(months[i]!, m));
      if (gaps.some((g) => g !== gaps[0])) continue;
      every = gaps[0]!;
      if (every < 1 || every > 12) continue;
      cadence = MONTH_CADENCE[every] ?? null;
      periodDays = every * 31;
    }
    const lastDate = dates[dates.length - 1]!;
    out.push({
      merchant: run.merchant,
      amount: run.amount,
      months,
      cadence,
      everyMonths: every,
      charges: dates.length,
      first: months[0]!,
      last: months[months.length - 1]!,
      total: Math.round(run.amount * dates.length * 100) / 100,
      // One period of grace: a charge is not "stopped" the moment the export
      // ends a few days before the next one is due.
      active:
        dataThrough === "" ||
        (every > 0 ? monthsBetween(monthOf(lastDate), monthOf(dataThrough)) <= every : daysBetween(lastDate, dataThrough) <= periodDays + 3),
    });
  }
  return out.sort((a, b) => b.total - a.total);
}

/**
 * The repeating charges the ledger does not already know about.
 *
 * `claimed` is every term the subscriptions and income notes match on; anything
 * a ledger line already answers to is not a discovery, it is the thing working.
 */
export function unclaimedRecurring(found: RecurringCharge[], claimed: string[]): RecurringCharge[] {
  // The matcher that files the charge decides whether a line claims it, or
  // the same charge is a commitment and a discovery at once (FIN-010).
  return found.filter((r) => !matchesTerms(r.merchant, claimed));
}
