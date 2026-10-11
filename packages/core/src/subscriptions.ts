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

/**
 * How often a charge repeats. Each is a whole number of weeks or of months
 * (`STEP`); anything a ledger cell says that is not one of these is not read
 * as one of them (audit FIN-006).
 */
export const CADENCES = ["weekly", "biweekly", "4-weekly", "monthly", "2-monthly", "quarterly", "half-yearly", "yearly"] as const;
export type Cadence = (typeof CADENCES)[number];

/** One period of each cadence, in the unit it is counted in. */
const STEP: Record<Cadence, { unit: "week" | "month"; every: number }> = {
  weekly: { unit: "week", every: 1 },
  biweekly: { unit: "week", every: 2 },
  "4-weekly": { unit: "week", every: 4 },
  monthly: { unit: "month", every: 1 },
  "2-monthly": { unit: "month", every: 2 },
  quarterly: { unit: "month", every: 3 },
  "half-yearly": { unit: "month", every: 6 },
  yearly: { unit: "month", every: 12 },
};

export interface Subscription {
  service: string;
  /** Major units (euros, not cents) — the table is hand-written, so it is decimal. */
  amount: number;
  currency: string;
  cadence: Cadence;
  /** Next charge, YYYY-MM-DD. Rolled forward if the note has gone stale. */
  next: string | null;
  /**
   * The date the note itself says, NOT rolled forward. Every later and earlier
   * charge is counted from here (`chargeDates`): `next` may already be a
   * clamped date — the 30th standing in for a 31st — and stepping from it
   * would carry the clamp into every month after (audit FIN-003).
   */
  anchor: string | null;
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

/**
 * What people write in the cadence column, English and Dutch (and the French
 * a Revolut-era note picks up). "Bimonthly" is deliberately absent: it means
 * twice a month to some and every two months to others, and guessing is how
 * a row ends up counted at the wrong rate.
 */
const CADENCE_WORDS: Record<string, Cadence> = {
  weekly: "weekly", week: "weekly", wk: "weekly", wekelijks: "weekly", hebdomadaire: "weekly",
  biweekly: "biweekly", "bi-weekly": "biweekly", fortnightly: "biweekly", fortnight: "biweekly",
  "other week": "biweekly", tweewekelijks: "biweekly", "2-wekelijks": "biweekly",
  "four-weekly": "4-weekly", "four weekly": "4-weekly", vierwekelijks: "4-weekly", "4-wekelijks": "4-weekly",
  monthly: "monthly", month: "monthly", mo: "monthly", pm: "monthly", "p/m": "monthly",
  maand: "monthly", maandelijks: "monthly", mensuel: "monthly",
  "other month": "2-monthly", tweemaandelijks: "2-monthly",
  quarterly: "quarterly", quarter: "quarterly", kwartaal: "quarterly", trimestriel: "quarterly",
  "half-yearly": "half-yearly", "half yearly": "half-yearly", halfyearly: "half-yearly",
  "half-year": "half-yearly", "half year": "half-yearly", semiannual: "half-yearly",
  "semi-annual": "half-yearly", semiannually: "half-yearly", "semi-annually": "half-yearly",
  semester: "half-yearly", halfjaarlijks: "half-yearly", semestriel: "half-yearly",
  yearly: "yearly", year: "yearly", yr: "yearly", annual: "yearly", annually: "yearly",
  annum: "yearly", "p/y": "yearly", pa: "yearly", jaar: "yearly", jaarlijks: "yearly", annuel: "yearly",
};

/** "every 2 weeks", "4-weekly", "6 months", "every 12 months" → the cadence it names, if any. */
const COUNTED = /^(\d{1,2}|one|two|four|six|twelve)[ -]?(weeks?|weekly|wks?|months?|monthly|mos?|years?|yearly)$/;
const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, four: 4, six: 6, twelve: 12 };

/**
 * The cadence a ledger cell names. An EMPTY cell is monthly — a reasonable
 * default for a blank, and what every hand-kept ledger so far assumes. A word
 * this does not know is `null`, never monthly: "half-yearly" read as monthly
 * counted an insurance six times over, "biweekly" at less than half, and a
 * Dutch 4-weekly salary one payment a year short (audit FIN-006).
 */
export function readCadence(raw: string): Cadence | null {
  const text = raw
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\.$/, "")
    .replace(/^(per|every|each|once a|once every) /, "");
  if (text === "") return "monthly";
  const word = CADENCE_WORDS[text];
  if (word) return word;
  const counted = COUNTED.exec(text);
  if (!counted) return null;
  const n = NUMBER_WORDS[counted[1]!] ?? Number(counted[1]);
  const unit = counted[2]!.startsWith("y") ? "month" : counted[2]!.startsWith("w") ? "week" : "month";
  const months = counted[2]!.startsWith("y") ? n * 12 : n;
  const every = unit === "week" ? n : months;
  return CADENCES.find((c) => STEP[c].unit === unit && STEP[c].every === every) ?? null;
}

/** Periods per month — weekly is 52/12 so a weekly charge sums honestly. */
const perMonth = (cadence: Cadence) => {
  const { unit, every } = STEP[cadence];
  return unit === "week" ? 52 / 12 / every : 1 / every;
};

/**
 * `"€10,99"` / `"10.99 EUR"` / `"$12"` → `{ amount, currency }`.
 *
 * This module's own parser was the correct one of the three; it now lives in
 * `money.ts` so `statement.ts` and `payslip.ts` share it (audit B4).
 */
const parseAmount = parseMoneyWithCurrency;

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Step a YYYY-MM-DD forward by `n` periods FROM THE ANCHOR, in UTC so no DST
 * shifts the day.
 *
 * Taking n in one go is the whole point. The clamp — a charge on the 31st
 * lands on the 30th in a 30-day month rather than rolling into the next one —
 * is correct for a single step and destroys the anchor when chained: rent due
 * on the 31st becomes the 28th from February onward and never comes back
 * (audit). The day of the month is always measured from `date`, so February
 * borrows nothing from March.
 */
export function advanceBy(date: string, cadence: Cadence, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  const { unit, every } = STEP[cadence];
  if (unit === "week") {
    d.setUTCDate(d.getUTCDate() + 7 * every * n);
  } else {
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + every * n);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, last));
  }
  return d.toISOString().slice(0, 10);
}

/** Step a YYYY-MM-DD forward by one period. */
export function advance(date: string, cadence: Cadence): string {
  return advanceBy(date, cadence, 1);
}

/** Whole periods from `a` to `b`, by estimate — within one of the truth either way. */
function periodsBetween(a: string, b: string, cadence: Cadence): number {
  const { unit, every } = STEP[cadence];
  if (unit === "week") return Math.floor((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / (86_400_000 * 7 * every));
  return Math.floor(((+b.slice(0, 4) - +a.slice(0, 4)) * 12 + (+b.slice(5, 7) - +a.slice(5, 7))) / every);
}

/**
 * How many charges a line's cadence expects from one date to another, both
 * ends counted: what "€X more than expected" is measured against. Rounded to
 * the nearest period, because a bank books a charge a day or two either side
 * of its date. The ledger card used to expect the MONTHLY equivalent per month
 * the line was seen in — 2/12 of a year's price for a yearly line seen twice,
 * so every annual and quarterly commitment showed a phantom overcharge (FIN-004).
 */
export function chargesExpected(cadence: Cadence, first: string, last: string): number {
  if (!(cadence in STEP) || last < first) return 0;
  const { unit, every } = STEP[cadence];
  if (unit === "week") return Math.round((Date.parse(`${last}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / (86_400_000 * 7 * every)) + 1;
  const months = (+last.slice(0, 4) - +first.slice(0, 4)) * 12 + (+last.slice(5, 7) - +first.slice(5, 7));
  return Math.round(months / every) + 1;
}

/**
 * Every charge of a line between `from` and `to` (inclusive), each counted
 * from the note's own date — never by chaining one step onto the last.
 *
 * Both calendars used to chain single steps, which is exactly the anchor loss
 * `advanceBy` exists to avoid: rent due on the 31st went to the 30th after
 * September and to the 28th after February, and walking BACK from a 31st
 * through a 30-day month did the same (audit FIN-003). Here every date is
 * `advanceBy(anchor, cadence, n)` for some whole n, negative included, so a
 * range before the note's date still shows the charges in it.
 */
export function chargeDates(anchor: string, cadence: Cadence, from: string, to: string): string[] {
  if (!ISO.test(anchor) || from > to || !(cadence in STEP)) return [];
  // Start a period or two before `from`, by estimate, then walk forward.
  let n = periodsBetween(anchor, from, cadence) - 1;
  const out: string[] = [];
  // Bounded: a weekly line over a ten-year range is ~520 dates.
  for (let i = 0; i < 1000; i++, n++) {
    const d = advanceBy(anchor, cadence, n);
    if (d > to) break;
    if (d >= from) out.push(d);
  }
  return out;
}

/**
 * Roll a stale `next` forward to the first charge that is not in the past. The
 * note is hand-maintained, so a date from three months ago means "it kept
 * charging", not "it stopped" — showing the stale date would put a phantom
 * overdue payment on the dashboard.
 */
export function nextCharge(from: string, cadence: Cadence, today: string): string {
  if (from >= today) return from;
  // Jump straight to roughly the right period rather than stepping one at a
  // time. The old loop did both things wrong: chaining `advance` lost the
  // anchor after any short month, and its 800-step cap — about fifteen years
  // of weeklies — could return a date in the PAST, which the agenda then drew
  // as a phantom overdue charge.
  let n = Math.max(0, periodsBetween(from, today, cadence));
  let d = advanceBy(from, cadence, n);
  // The estimate lands within a period either way; a couple of corrections is
  // all it can ever need, and the bound is there so a bad input cannot spin.
  for (let i = 0; i < 8 && d < today; i++) d = advanceBy(from, cadence, ++n);
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

/** A ledger row that was left out of every total, and why — shown, not dropped. */
export interface UnreadableRow {
  service: string;
  /** 1-based line in the note, so the page can say where to look. */
  line: number;
  field: "amount" | "cadence";
  /** The cell as written. */
  text: string;
}

/**
 * Read every Markdown table in the note and return the subscriptions found. A
 * table only counts if its header names both a service and an amount, so prose
 * tables elsewhere in the note are ignored rather than half-parsed.
 */
export function parseSubscriptions(content: string, today: string): Subscription[] {
  return parseLedger(content, today).items;
}

/**
 * The ledger's lines, and the rows it could not read. A row whose amount or
 * cadence is not understood is left out of every total — a half-read row
 * would put a wrong number on the dashboard — and reported, so the page can
 * say which row and why rather than show a total that silently lacks it
 * (audit FIN-005, FIN-006).
 */
export function parseLedger(content: string, today: string): { items: Subscription[]; unreadable: UnreadableRow[] } {
  const lines = content.split(/\r?\n/);
  const out: Subscription[] = [];
  const unreadable: UnreadableRow[] = [];
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
    const amountText = get("amount").trim();
    // A blank row is not a row; a named one with no readable amount is.
    if (!service && !amountText) continue;
    const money = parseAmount(amountText);
    if (!service || !money) {
      unreadable.push({ service, line: i + 1, field: "amount", text: amountText });
      continue;
    }

    const cadence = readCadence(get("cadence"));
    if (!cadence) {
      unreadable.push({ service, line: i + 1, field: "cadence", text: get("cadence").trim() });
      continue;
    }
    const raw = get("next").trim();
    const next = ISO.test(raw) ? nextCharge(raw, cadence, today) : null;

    out.push({
      service,
      amount: money.amount,
      currency: money.currency,
      cadence,
      next,
      anchor: ISO.test(raw) ? raw : null,
      monthly: Math.round(money.amount * perMonth(cadence) * 100) / 100,
      match: get("match")
        .split(",")
        .map((m) => m.trim().toLowerCase())
        .filter(Boolean),
      category: get("category"),
      note: get("note"),
    });
  }
  return { items: out, unreadable };
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
