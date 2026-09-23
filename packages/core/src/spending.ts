/**
 * Spending categories and what they say about next month.
 *
 * The rules live in a Markdown table in the vault, not in this file: which
 * merchants count as "groceries" is a personal judgement that changes as your
 * life does, and it should be editable in Obsidian without a deploy. This
 * module only knows how to apply rules and how to summarise the result.
 */
import { cells, isRule, mapHeader } from "./table.js";
import type { StatementRow } from "./statement.js";

export interface CategoryRule {
  category: string;
  /** Lower-cased substrings; a description matching any of them belongs here. */
  matches: string[];
  colour: string | null;
  /**
   * Wins over every unpinned rule regardless of match length.
   *
   * Used for the Subscriptions category, which is built from the subscriptions
   * ledger rather than typed into the rules note. A recurring charge should be
   * filed as recurring first and by merchant type second: Adobe is a
   * subscription that happens to be software, and seeing it under Software
   * hides the number you actually want, which is what the standing orders cost.
   */
  pinned?: boolean;
}

export interface CategoryMonth {
  month: string;
  /** Category → euros spent that month. */
  byCategory: Record<string, number>;
  total: number;
}

export interface CategoryForecast {
  category: string;
  /** Middle of the complete months — a median, so one large purchase does not
   *  become next month's expectation. */
  typical: number;
  low: number;
  high: number;
  /** Complete months this is based on; below three there is no forecast. */
  months: number;
  /** Most recent complete month, for "last month you spent…". */
  last: number | null;
}

const HEADERS: Record<string, string> = {
  category: "category",
  name: "category",
  group: "category",
  matches: "matches",
  match: "matches",
  merchants: "matches",
  keywords: "matches",
  colour: "colour",
  color: "colour",
};

export const UNCATEGORISED = "Other";

/** Read the rules table. Rows without a category or any match are skipped. */
export function parseCategoryRules(content: string): CategoryRule[] {
  const out: CategoryRule[] = [];
  let cols: string[] | null = null;
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim().startsWith("|")) {
      cols = null;
      continue;
    }
    const row = cells(line);
    if (isRule(row)) continue;
    if (!cols) {
      const mapped = mapHeader(row, HEADERS);
      if (mapped.includes("category") && mapped.includes("matches")) cols = mapped;
      continue;
    }
    const get = (k: string) => {
      const at = cols!.indexOf(k);
      return at === -1 ? "" : (row[at] ?? "").trim();
    };
    const category = get("category");
    const matches = get("matches")
      .split(",")
      .map((m) => m.trim().toLowerCase())
      .filter(Boolean);
    if (!category || matches.length === 0) continue;
    out.push({ category, matches, colour: get("colour") || null });
  }
  return out;
}

/**
 * Fold accents, so `doner` finds "THE DÖNER COMPANY" and `pathe` finds "PATHÉ".
 * Card descriptors are inconsistent about diacritics and nobody should have to
 * type the ö to catch their kebab.
 */
const fold = (s: string): string => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

/** Terms shorter than this only match as a whole description. "ns" as a
 *  substring hits "haNS en grietje"; as an exact match it is the railway. */
const MIN_SUBSTRING = 3;

/**
 * Which category a description falls in. The LONGEST matching term wins, so
 * "uber eats" beats "uber" and a meal is not filed as a taxi.
 *
 * A term written `=ns` matches only when the whole description is "ns" — the
 * escape hatch for short merchant names that would otherwise match half the
 * statement as a substring.
 */
export function categoryOf(description: string, rules: CategoryRule[]): string {
  const hay = fold(description).trim();
  let best = "";
  let bestLen = 0;
  for (const rule of rules) {
    for (const raw of rule.matches) {
      const exact = raw.startsWith("=");
      const m = fold(exact ? raw.slice(1) : raw).trim();
      if (!m) continue;
      // Exact terms are scored generously so a deliberate `=ns` is not lost to
      // some longer accidental substring elsewhere in the rules; a pinned rule
      // outranks both.
      const score = (exact ? m.length + 100 : m.length) + (rule.pinned ? 1000 : 0);
      if (score <= bestLen) continue;
      if (exact ? hay === m : m.length >= MIN_SUBSTRING && hay.includes(m)) {
        best = rule.category;
        bestLen = score;
      }
    }
  }
  return best || UNCATEGORISED;
}

/**
 * What a statement row actually cost: its outflow plus any fee on it.
 *
 * Card payments and ATM withdrawals are spending by definition. **A transfer is
 * spending exactly when the rules note names it** — and that is the whole
 * mechanism, because there is no way to tell from the bank's data whether
 * "To Stichting DUWO" is rent, whether "AMAZON PAYMENTS EUROPE SCA" is a
 * purchase, or whether "To WAEL BOUAYSS" is a loan, a repayment or a shared
 * dinner. The vault knows; the parser cannot.
 *
 * Defaulting an unnamed transfer to NOT spending is the safe direction. Money
 * moving between Jules's own accounts, and money sent to a friend and sent
 * straight back, would otherwise both inflate the total — and inflating it is
 * worse than omitting, because an omission is visible ("moved out, not counted")
 * while an inflation just looks like a bad month.
 *
 * Money coming IN is never spending, whatever it matches.
 */
export const costOf = (r: StatementRow, rules: CategoryRule[] = []): number => {
  // A refund costs only its fee. Its amount has already come off the purchase
  // it refunds, in the purchase's month (settleRefunds, below) — or, when that
  // purchase is not in the data at all, it is money back, not negative
  // spending. Subtracting it here instead drove January's "Other" to
  // -EUR 472.34 on a refund for something bought in December.
  if (r.flow === "refund" && r.amount > 0) return r.fee;
  if (r.amount >= 0) return r.fee;
  const counts = r.flow === "spend" || (r.flow === "moved" && categoryOf(r.description, rules) !== UNCATEGORISED);
  return (counts ? -r.amount - (r.refunded ?? 0) : 0) + r.fee;
};

/** How Finance names a merchant: the description, whitespace-collapsed, upper-cased. */
const merchantOf = (r: StatementRow) => r.description.trim().replace(/\s+/g, " ").toUpperCase();

/**
 * Take each refund off the purchase it refunds.
 *
 * A refund is money back on something bought earlier, so it belongs to that
 * purchase: a EUR 799 laptop bought in March and returned in April cost
 * nothing, in March. Netting it where it ARRIVED (the previous rule) left
 * March inflated and could push April below zero; and a refund for something
 * bought before the statement starts had nothing to net against at all — a
 * EUR 583.30 Rakuten refund on 7 January turned January's "Other" into
 * -EUR 472.34, which then set the category's "lowest month" and dragged its
 * average.
 *
 * So each refund, oldest first, is matched to earlier purchases at the same
 * merchant: one of exactly the refunded amount if there is one, else the most
 * recent first. Whatever it cannot match is not spending in either direction.
 * Purchases come back with `refunded` set; nothing the bank reported changes.
 * Every cost is then >= 0, so no category month can go negative.
 */
export function settleRefunds(rows: StatementRow[]): StatementRow[] {
  const cents = (n: number) => Math.round(n * 100) / 100;
  const out = rows.map((r) => (r.flow === "spend" && r.amount < 0 ? { ...r, refunded: 0 } : r));
  const left = (p: StatementRow) => cents(-p.amount - (p.refunded ?? 0));
  const refunds = out
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r.flow === "refund" && r.amount > 0)
    .sort((a, b) => a.r.date.localeCompare(b.r.date) || a.i - b.i);
  for (const { r } of refunds) {
    let owed = cents(r.amount);
    const merchant = merchantOf(r);
    const candidates = out
      .filter((p) => p.refunded !== undefined && p.date <= r.date && merchantOf(p) === merchant && left(p) > 0)
      .sort((a, b) => Number(left(b) === owed) - Number(left(a) === owed) || b.date.localeCompare(a.date));
    for (const p of candidates) {
      if (owed <= 0) break;
      const take = Math.min(owed, left(p));
      p.refunded = cents((p.refunded ?? 0) + take);
      owed = cents(owed - take);
    }
  }
  return out;
}

export function monthlyByCategory(rows: StatementRow[], rules: CategoryRule[]): CategoryMonth[] {
  const months = new Map<string, CategoryMonth>();
  for (const r of rows) {
    const cost = costOf(r, rules);
    if (cost === 0) continue; // a fully refunded purchase, a transfer, money in
    const key = r.date.slice(0, 7);
    const m = months.get(key) ?? { month: key, byCategory: {}, total: 0 };
    const cat = categoryOf(r.description, rules);
    m.byCategory[cat] = Math.round(((m.byCategory[cat] ?? 0) + cost) * 100) / 100;
    m.total = Math.round((m.total + cost) * 100) / 100;
    months.set(key, m);
  }
  return [...months.values()].sort((a, b) => a.month.localeCompare(b.month));
}

/** The middle of a list. `NaN` on an empty one — callers guard first. */
export const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : ((s[mid - 1]! + s[mid]!) / 2);
};

/**
 * Drop the month the statement stops inside.
 *
 * This is the difference between a useful forecast and a badly wrong one: an
 * export taken on the 3rd contains three days of that month, and averaging it
 * in drags every category's expectation down by a third or more. A month counts
 * only if the data runs past its end.
 */
/**
 * Total money OUT per month: every debit plus every fee, transfers included.
 *
 * Not the same question as `monthlyByCategory`, which answers "what did I
 * SPEND" and deliberately leaves an unclaimed transfer out of it. The savings
 * model needs the other number, because money in is an identity over
 * everything that left — and using spend there understated income by every
 * euro standing-ordered to a savings account (audit).
 */
export function outflowByMonth(rows: StatementRow[]): { month: string; outflow: number }[] {
  const months = new Map<string, number>();
  for (const r of rows) {
    const out = (r.amount < 0 ? -r.amount : 0) + r.fee;
    if (out <= 0) continue;
    const key = r.date.slice(0, 7);
    months.set(key, Math.round(((months.get(key) ?? 0) + out) * 100) / 100);
  }
  return [...months].map(([month, outflow]) => ({ month, outflow })).sort((a, b) => a.month.localeCompare(b.month));
}

export function completeMonths(months: CategoryMonth[], lastDate: string): CategoryMonth[] {
  const cutoff = lastDate.slice(0, 7);
  const dayOfMonth = Number.parseInt(lastDate.slice(8, 10), 10);
  const lastDayOfCutoff = new Date(
    Date.UTC(Number.parseInt(cutoff.slice(0, 4), 10), Number.parseInt(cutoff.slice(5, 7), 10), 0),
  ).getUTCDate();
  // The final month survives only if the statement reaches its last day.
  return months.filter((m) => m.month < cutoff || (m.month === cutoff && dayOfMonth >= lastDayOfCutoff));
}

/**
 * What each category typically costs, from complete months only.
 *
 * Deliberately a median and a range rather than a trend line or a regression:
 * with under a year of history, "the middle of what you usually spend" is a
 * claim the data supports. A slope is not.
 */
export function forecast(months: CategoryMonth[], minMonths = 3): CategoryForecast[] {
  const names = new Set<string>();
  for (const m of months) for (const c of Object.keys(m.byCategory)) names.add(c);

  const out: CategoryForecast[] = [];
  for (const category of names) {
    // Absent from a month means zero spent, not missing — otherwise a category
    // bought once looks like a reliable monthly cost.
    const series = months.map((m) => m.byCategory[category] ?? 0);
    if (months.length < minMonths) continue;
    const r = (n: number) => Math.round(n * 100) / 100;
    out.push({
      category,
      typical: r(median(series)),
      low: r(Math.min(...series)),
      high: r(Math.max(...series)),
      months: months.length,
      last: series.length ? r(series[series.length - 1]!) : null,
    });
  }
  return out.sort((a, b) => b.typical - a.typical || a.category.localeCompare(b.category));
}


/**
 * What a typical month costs: the MEDIAN OF THE MONTH TOTALS.
 *
 * There were three of these and they disagreed (audit). The dashboard and the
 * Finance tab summed each category's own median — `Σ median(category)` — while
 * the month page took the median of the whole-month totals. On Jules's real
 * statement, eight complete months through August 2026, the first says
 * €1,831.23 and the second €2,128.05: a 14% gap between two headline numbers
 * computed from one set of rows. Below three months they disagree completely,
 * because `forecast` withholds a figure it does not have and summing nothing
 * gives €0 rather than no answer.
 *
 * The median of the totals wins for the reason the savings model already gives
 * for using a lived month over a sum of quantiles: no month ever cost the sum
 * of every category's median, because the categories do not all sit at their
 * median together. €2,128 is a month Jules has had. €1,831 is an arithmetic
 * artefact, and it is biased low, which is the worse direction for a number
 * people budget against.
 *
 * `null` under `minMonths`, never 0: "not enough history" and "spent nothing"
 * are different claims and the UI already has copy for the first.
 */
export function typicalMonth(
  months: CategoryMonth[],
  category: string | null = null,
  minMonths = 3,
): number | null {
  if (months.length < minMonths) return null;
  // Absent from a month means zero spent, not missing — the same rule
  // `forecast` uses, so a category bought once is not a reliable monthly cost.
  const totals = months.map((m) => (category === null ? m.total : (m.byCategory[category] ?? 0)));
  return Math.round(median(totals) * 100) / 100;
}

export interface CategoryMerchant {
  name: string;
  total: number;
  count: number;
}

/**
 * The merchants behind each category, biggest first.
 *
 * Descriptions are normalised only by case and whitespace — no clever
 * stripping of store numbers or city names. A card descriptor is the closest
 * thing to a receipt you have, and rewriting it to look tidier makes the app
 * disagree with the bank about what you bought.
 */
export function merchantsByCategory(
  rows: StatementRow[],
  rules: CategoryRule[],
  limit = 6,
): Record<string, CategoryMerchant[]> {
  const per = new Map<string, Map<string, CategoryMerchant>>();
  for (const r of rows) {
    const cost = costOf(r, rules);
    if (cost === 0) continue;
    const cat = categoryOf(r.description, rules);
    const name = r.description.trim().replace(/\s+/g, " ").toUpperCase();
    const bucket = per.get(cat) ?? new Map<string, CategoryMerchant>();
    const cur = bucket.get(name) ?? { name, total: 0, count: 0 };
    cur.total = Math.round((cur.total + cost) * 100) / 100;
    cur.count++;
    bucket.set(name, cur);
    per.set(cat, bucket);
  }
  const out: Record<string, CategoryMerchant[]> = {};
  for (const [cat, bucket] of per) {
    out[cat] = [...bucket.values()].sort((a, b) => b.total - a.total).slice(0, limit);
  }
  return out;
}
