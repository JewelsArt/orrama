/**
 * Recurring payments, parsed out of an ordinary Markdown table.
 *
 * A subscription is a note, not a row: the vault stays the truth, Obsidian can
 * edit it, and deleting the index loses nothing (§"the dashboard is a pure view").
 * The note is found by its `#subscriptions` tag, so it can live anywhere in the
 * PARA tree, and holds one table:
 *
 *   | Service | Amount | Every   | Next       |
 *   |---------|--------|---------|------------|
 *   | Spotify | 10.99  | monthly | 2026-09-14 |
 *
 * Columns are matched by HEADER NAME, not position, so reordering them by hand
 * in Obsidian cannot silently turn a price into a date. Anything unparseable is
 * skipped rather than guessed at — a half-read row would put a wrong number on
 * the dashboard, which is worse than a missing one.
 */

import { parseMoneyWithCurrency } from "./money.js";
import { appendRow, cells, isRule, mapHeader } from "./table.js";

/** How often a charge repeats. `custom` carries an explicit day count. */
export type Cadence = "weekly" | "monthly" | "quarterly" | "yearly";

export interface Subscription {
  service: string;
  /** Major units (euros, not cents) — the table is hand-written, so it is decimal. */
  amount: number;
  currency: string;
  cadence: Cadence;
  /** Next charge, YYYY-MM-DD. Rolled forward if the note has gone stale. */
  next: string | null;
  /** Amount normalised to one month, for a total that can be summed. */
  monthly: number;
  /**
   * What this line looks like on the bank statement, comma-separated, when the
   * service name alone does not find it.
   *
   * Guessing terms from the name works for "Adobe" and fails for everything
   * else: rent leaves the account as "To Stichting DUWO", a university as
   * "To Stichting Hogeschool van Amsterdam", and "Youtube Family" yields no
   * usable term at all. Rather than grow a cleverer guesser, the note says it —
   * which is the same principle as the spending rules note, and it keeps the
   * vault the place where the truth lives.
   */
  match: string[];
  /**
   * Which spending category this line files under, when "Subscriptions" is the
   * wrong word for it. Rent is a committed monthly payment in every way that
   * matters to a forecast, but calling €609 of housing a subscription buries
   * the single biggest thing in the month inside a bucket named after Adobe.
   * Empty means Subscriptions.
   */
  category: string;
  note: string;
}

const CADENCE: Record<string, Cadence> = {
  weekly: "weekly",
  week: "weekly",
  wk: "weekly",
  monthly: "monthly",
  month: "monthly",
  mo: "monthly",
  quarterly: "quarterly",
  quarter: "quarterly",
  yearly: "yearly",
  year: "yearly",
  annual: "yearly",
  annually: "yearly",
  yr: "yearly",
};

/** Months per period — weekly is 52/12 so a weekly charge sums honestly. */
const PER_MONTH: Record<Cadence, number> = {
  weekly: 52 / 12,
  monthly: 1,
  quarterly: 1 / 3,
  yearly: 1 / 12,
};

/**
 * `"€10,99"` / `"10.99 EUR"` / `"$12"` → `{ amount, currency }`.
 *
 * This module's own parser was the correct one of the three; it now lives in
 * `money.ts` so `statement.ts` and `payslip.ts` share it (audit B4).
 */
const parseAmount = parseMoneyWithCurrency;

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Step a YYYY-MM-DD forward by one period, in UTC so no DST shifts the day. */
export function advance(date: string, cadence: Cadence): string {
  const d = new Date(`${date}T00:00:00Z`);
  if (cadence === "weekly") d.setUTCDate(d.getUTCDate() + 7);
  else {
    const months = cadence === "monthly" ? 1 : cadence === "quarterly" ? 3 : 12;
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + months);
    // Clamp: a charge on the 31st lands on the 30th in a 30-day month rather
    // than rolling over into the next one.
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, last));
  }
  return d.toISOString().slice(0, 10);
}

/**
 * Roll a stale `next` forward to the first charge that is not in the past. The
 * note is hand-maintained, so a date from three months ago means "it kept
 * charging", not "it stopped" — showing the stale date would put a phantom
 * overdue payment on the dashboard.
 */
export function nextCharge(from: string, cadence: Cadence, today: string): string {
  let d = from;
  // Bounded: weekly over a decade is ~520 steps, so 800 cannot spin.
  for (let i = 0; i < 800 && d < today; i++) d = advance(d, cadence);
  return d;
}

const HEADERS: Record<string, string> = {
  service: "service",
  name: "service",
  subscription: "service",
  what: "service",
  // Income names the same column differently — one parser reads both tables.
  source: "service",
  employer: "service",
  client: "service",
  from: "service",
  amount: "amount",
  price: "amount",
  cost: "amount",
  every: "cadence",
  cadence: "cadence",
  cycle: "cadence",
  frequency: "cadence",
  billing: "cadence",
  next: "next",
  "next charge": "next",
  due: "next",
  renews: "next",
  match: "match",
  matches: "match",
  "on statement": "match",
  descriptor: "match",
  category: "category",
  group: "category",
  note: "note",
  notes: "note",
};

/**
 * Read every Markdown table in the note and return the subscriptions found. A
 * table only counts if its header names both a service and an amount, so prose
 * tables elsewhere in the note are ignored rather than half-parsed.
 */
export function parseSubscriptions(content: string, today: string): Subscription[] {
  const lines = content.split(/\r?\n/);
  const out: Subscription[] = [];
  let cols: string[] | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim().startsWith("|")) {
      cols = null;
      continue;
    }
    const row = cells(line);
    // A separator row (|---|---|) confirms the line above was a header.
    if (isRule(row)) continue;

    if (!cols) {
      const mapped = mapHeader(row, HEADERS);
      if (mapped.includes("service") && mapped.includes("amount")) cols = mapped;
      continue;
    }

    const get = (key: string) => {
      const at = cols!.indexOf(key);
      return at === -1 ? "" : (row[at] ?? "");
    };
    const service = get("service").replace(/^\*+|\*+$/g, "").trim();
    const money = parseAmount(get("amount"));
    if (!service || !money) continue;

    const cadence = CADENCE[get("cadence").toLowerCase().trim()] ?? "monthly";
    const raw = get("next").trim();
    const next = ISO.test(raw) ? nextCharge(raw, cadence, today) : null;

    out.push({
      service,
      amount: money.amount,
      currency: money.currency,
      cadence,
      next,
      monthly: Math.round(money.amount * PER_MONTH[cadence] * 100) / 100,
      match: get("match")
        .split(",")
        .map((m) => m.trim().toLowerCase())
        .filter(Boolean),
      category: get("category"),
      note: get("note"),
    });
  }
  return out;
}

/**
 * Insert a row into the note's money table, returning the new content.
 *
 * The table is found the same way it is read — by a header naming a service and
 * an amount — so a note can carry prose and other tables around it. The row is
 * appended after the table's LAST row rather than at a remembered index: the
 * file may have been edited in Obsidian since it was last read, and counting
 * lines from a stale copy is how a write lands in the middle of someone's text.
 *
 * Cell values are escaped for the table: a literal `|` would silently split one
 * field into two, and a newline would end the row mid-way.
 */
export function appendMoneyRow(
  content: string,
  row: { service: string; amount: string; cadence: string; next: string; note: string; match?: string },
): string | null {
  return appendRow(content, HEADERS, ["service", "amount"], row);
}

/** Monthly-equivalent total, per currency — mixing EUR and USD into one number would be a lie. */
export function monthlyTotals(subs: Subscription[]): { currency: string; monthly: number }[] {
  const by = new Map<string, number>();
  for (const s of subs) by.set(s.currency, (by.get(s.currency) ?? 0) + s.monthly);
  return [...by].map(([currency, monthly]) => ({ currency, monthly: Math.round(monthly * 100) / 100 })).sort((a, b) => b.monthly - a.monthly);
}
