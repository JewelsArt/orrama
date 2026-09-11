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
import type { StatementRow } from "./statement.js";

export interface RecurringCharge {
  /** The merchant as the statement writes it. */
  merchant: string;
  /** The amount that keeps repeating, in major units. */
  amount: number;
  /** Distinct months it landed in, oldest first. */
  months: string[];
  /** Months between charges, when the spacing is regular. */
  everyMonths: number;
  first: string;
  last: string;
  /** What the run has cost so far. */
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

/**
 * Find the repeating charges on a statement.
 *
 * `minMonths` is 3 by default, and that floor is doing real work: two charges
 * of the same size is a coincidence a €1.47 sandwich will produce every month
 * of the year. Three in a regular rhythm is a standing order.
 */
export function findRecurring(
  rows: StatementRow[],
  { minMonths = 3, dataThrough = "" }: { minMonths?: number; dataThrough?: string } = {},
): RecurringCharge[] {
  const runs = new Map<string, { merchant: string; amount: number; dates: string[] }>();
  for (const r of rows) {
    if (r.amount >= 0) continue;
    const merchant = norm(r.description);
    const amount = Math.round(-r.amount * 100) / 100;
    if (amount <= 0) continue;
    const key = `${merchant.toUpperCase()}|${amount.toFixed(2)}`;
    const run = runs.get(key) ?? { merchant, amount, dates: [] };
    run.dates.push(r.date);
    runs.set(key, run);
  }

  const end = dataThrough ? monthOf(dataThrough) : "";
  const out: RecurringCharge[] = [];
  for (const run of runs.values()) {
    const months = [...new Set(run.dates.map(monthOf))].sort();
    if (months.length < minMonths) continue;
    // Regular spacing only. An irregular run of identical amounts is a habit
    // (the same coffee, the same tram fare), not a standing order.
    const gaps = months.slice(1).map((m, i) => monthsBetween(months[i]!, m));
    if (gaps.some((g) => g !== gaps[0])) continue;
    const every = gaps[0]!;
    if (every < 1 || every > 12) continue;
    const last = months[months.length - 1]!;
    out.push({
      merchant: run.merchant,
      amount: run.amount,
      months,
      everyMonths: every,
      first: months[0]!,
      last,
      total: Math.round(run.amount * months.length * 100) / 100,
      // One period of grace: a monthly charge is not "stopped" the moment the
      // export ends a few days before the next one is due.
      active: end === "" || monthsBetween(last, end) <= every,
    });
  }
  return out.sort((a, b) => b.amount * b.months.length - a.amount * a.months.length);
}

/**
 * The repeating charges the ledger does not already know about.
 *
 * `claimed` is every term the subscriptions and income notes match on; anything
 * a ledger line already answers to is not a discovery, it is the thing working.
 */
export function unclaimedRecurring(found: RecurringCharge[], claimed: string[]): RecurringCharge[] {
  const terms = claimed.map((t) => t.trim().toLowerCase()).filter(Boolean);
  return found.filter((r) => {
    const hay = r.merchant.toLowerCase();
    return !terms.some((t) => hay.includes(t));
  });
}
