/**
 * What Money's pages arrange before they draw: pure functions over what the server sent, kept
 * here so they can be tested on their own. None of them computes a new quantity. They group,
 * order and add up the server's own figures, and each one says what its rows add up to, so a
 * test can hold that sum to the server's total.
 */
import { CADENCES, type Cadence } from "@orrama/core/subscriptions";
import type { FinanceData, MonthDetail, Recurring } from "@orrama/schema/responses";
import { colouredCategories, OTHER_COLOUR, paletteFor, UNCATEGORISED } from "./palette.js";

type Categories = FinanceData["spending"]["categories"];

/** One row of "This month by category". */
export interface CategoryRow {
  /** The category, or UNCATEGORISED for the row that gathers the rest. */
  category: string;
  colour: string;
  /** Spent this month, so far. */
  amount: number;
  /** A typical whole month of it (the server's median), for the bar only. */
  typical: number;
  /** For the gathered row: the categories inside it. */
  members?: string[];
}

/**
 * The overview's month by category (the board): one row per category that has a colour of its
 * own, in the note's order, then one "Other" row for everything else — the categories past the
 * fifth and what no rule caught. A category with nothing this month and no typical month is left
 * out. The rows add up to the month's spending: nothing is dropped, only gathered.
 */
export function monthByCategory(byCategory: Record<string, number>, cats: Pick<Categories, "rules" | "forecast">): CategoryRow[] {
  const coloured = colouredCategories(cats.rules);
  const colour = paletteFor(cats.rules);
  const typicalOf = new Map(cats.forecast.map((f) => [f.category, f.typical]));
  const rows: CategoryRow[] = [];
  for (const c of coloured) {
    const amount = byCategory[c] ?? 0;
    const typical = typicalOf.get(c) ?? 0;
    if (amount > 0 || typical > 0) rows.push({ category: c, colour: colour(c), amount, typical });
  }
  const rest = [...new Set([...Object.keys(byCategory), ...cats.forecast.map((f) => f.category)])].filter((c) => !coloured.includes(c));
  const members = rest.filter((c) => (byCategory[c] ?? 0) > 0 || (typicalOf.get(c) ?? 0) > 0);
  if (members.length > 0)
    rows.push({
      category: UNCATEGORISED,
      colour: OTHER_COLOUR,
      amount: round2(members.reduce((a, c) => a + (byCategory[c] ?? 0), 0)),
      typical: members.reduce((a, c) => a + (typicalOf.get(c) ?? 0), 0),
      // What no rule caught is "Other" itself; say the named ones.
      members: members.filter((c) => c !== UNCATEGORISED),
    });
  return rows;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** One shop in a month of a category. */
export interface Shop {
  name: string;
  /** What it cost, refunds off. */
  total: number;
  /** Purchases (a refund is not one). */
  count: number;
}

/**
 * Where a month of one category went, shop by shop, from the month's own transactions. A
 * purchase's amount is what it cost, with any refund already taken off it (core's settleRefunds:
 * a refund belongs to the purchase it refunds), so a refund row adds nothing here and is no
 * purchase; money that only moved is not spending. `adds` says whether the shops add up to the
 * server's total to the cent; when they don't, the page shows the year's shops instead of a sum
 * that disagrees.
 */
export function shopsOf(d: Pick<MonthDetail, "transactions" | "total">): { shops: Shop[]; adds: boolean } {
  const by = new Map<string, Shop>();
  for (const t of d.transactions) {
    if (t.moved || t.refund) continue;
    const at = by.get(t.description) ?? { name: t.description, total: 0, count: 0 };
    at.total += t.amount;
    at.count += 1;
    by.set(t.description, at);
  }
  const shops = [...by.values()].map((s) => ({ ...s, total: round2(s.total) })).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  const sum = round2(shops.reduce((a, s) => a + s.total, 0));
  return { shops, adds: Math.abs(sum - d.total) < 0.005 };
}

/** The cadence a found charge would be written down as, or null when the ledger has no word for it. */
export function cadenceOf(r: Pick<Recurring, "cadence" | "everyMonths">): Cadence | null {
  if (r.cadence && (CADENCES as readonly string[]).includes(r.cadence)) return r.cadence as Cadence;
  const byMonths: Record<number, Cadence> = { 1: "monthly", 2: "2-monthly", 3: "quarterly", 6: "half-yearly", 12: "yearly" };
  return r.cadence ? null : (byMonths[r.everyMonths] ?? null);
}

/**
 * The ledger row "Add it" writes for a charge that looks recurring (POST /api/finance/subscriptions,
 * which appends it to the #subscriptions note's table). The name is the bank's own, so the line
 * claims exactly that charge; the date is the last time it was charged, which the ledger rolls
 * forward to the next. Null when there is no cadence the ledger knows.
 */
export function recurringRow(r: Recurring, lastCharged: string | null): { service: string; amount: string; cadence: Cadence; next: string; note: string } | null {
  const cadence = cadenceOf(r);
  if (!cadence) return null;
  return { service: r.merchant, amount: r.amount.toFixed(2), cadence, next: lastCharged ?? "", note: "" };
}

/** A found charge, as this device remembers it was dismissed ("It's not recurring"). */
export const recurringKey = (r: Pick<Recurring, "merchant" | "amount">) => `${r.merchant}|${r.amount.toFixed(2)}`;

/**
 * ← and → step a dated page's month (structure.md §1.5): −1, +1, or null when the key is not
 * for the page (a modifier held, typing in a field, an overlay open, already handled).
 */
export function monthStep(e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; defaultPrevented: boolean }, typing: boolean, layerOpen: boolean): -1 | 1 | null {
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.defaultPrevented || typing || layerOpen) return null;
  return e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : null;
}
