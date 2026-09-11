/**
 * How much could actually be saved each month.
 *
 * Every "savings advice" feature is tempted to invent a rule — 50/30/20, "cut
 * your coffee" — and every one of them is a guess about someone else. This one
 * is derived from Jules's own statement, and the whole model is two numbers:
 *
 *   surplus   = typical money in  −  typical money out
 *   trimmable = Σ over discretionary categories of (typical month − good month)
 *
 * `surplus` comes from the BANK, not from a payslip. Where the statement
 * carries balances, the slope between the first and last of them says what the
 * account is really doing, and money in is then an identity rather than a
 * guess: whatever was spent, plus whatever the balance grew by. Payslips are a
 * poor proxy for it — they cover one employer, and everything else that lands
 * (student finance, transfers, a second job) is invisible to them. On Jules's
 * own file the payslip median said €500 a month while the balance was climbing
 * €300 on top of €1,000 of spending, so the payslip-based version reported a
 * €500 deficit for an account that was visibly growing. Payslips and the income
 * note are kept as fallbacks for when there is no balance to slope.
 *
 * `trimmable` is the honest half. For each category we already know what a
 * typical month costs and what a GOOD month cost — the 25th percentile of the
 * months on record. The gap between them is not aspiration: it is a month he
 * has already lived through at that number. Summing those gaps gives a saving
 * target he has demonstrably hit before, category by category.
 *
 * Committed categories are excluded from `trimmable` because they do not
 * respond to intent — a subscription costs what it costs until it is
 * cancelled, so telling someone to "spend less on rent this month" is noise.
 * They are reported separately, as the number that only a decision can change.
 *
 * Percentiles, not minimums: the cheapest month on record is usually an
 * artefact (a holiday, a half-covered month), and building a target on it
 * produces a figure nobody can hit twice.
 */

/** One category's month-by-month history, as the spending index already has it. */
export interface CategoryMonths {
  category: string;
  /** Totals for COMPLETE months only — a part-month drags every quantile down. */
  totals: number[];
  /** Recurring by nature: subscriptions, rent, insurance. Excluded from trimmable. */
  committed: boolean;
}

export interface SavingsPlan {
  /** Typical money in per month, and where the figure came from. */
  incomeMonthly: number;
  incomeSource: "balance" | "payslips" | "ledger" | "none";
  /** Typical money out per month, from the statement. */
  spendMonthly: number;
  /** incomeMonthly − spendMonthly. Negative means the account is shrinking. */
  surplus: number;
  /** The part of spending that no in-month decision changes. */
  committedMonthly: number;
  /** The part that does respond to intent. */
  discretionaryMonthly: number;
  /** Σ (typical − good) over discretionary categories: proven headroom. */
  trimmable: number;
  /** surplus + trimmable, floored at zero — the realistic monthly target. */
  target: number;
  /** target ÷ incomeMonthly, as a percentage. Null with no income on record. */
  targetRate: number | null;
  /** What is being saved already, from the balance trend. Null without one.
   *  Equal to `surplus` whenever the statement carries balances — the two are
   *  the same fact, and showing them as one number twice is deliberate: it is
   *  what makes the plan checkable against the account. */
  observed: number | null;
  /** Per-category headroom, biggest first — where the target comes from. */
  headroom: { category: string; typical: number; good: number; save: number }[];
  /** Three months of spending: the usual first goal. */
  emergencyFund: number;
  /** Months to that fund at `target`. Null if the target is zero. */
  monthsToFund: number | null;
  /** Complete months the plan is based on. Below MIN_MONTHS it is not shown. */
  basedOn: number;
}

/** Below this there is not enough history for a quantile to mean anything. */
export const MIN_MONTHS = 3;

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Linear-interpolated quantile over a sorted copy. `p` is 0..1.
 * Interpolating rather than picking the nearest sample matters at n=4, where
 * the nearest-rank p25 would just be the minimum again.
 */
export function quantile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  if (s.length === 1) return s[0]!;
  const pos = (s.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? s[lo]! : s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

/**
 * Build the plan.
 *
 * `spendMonths` is the whole statement's monthly spend, complete months only —
 * it is the denominator for everything, and it must be the same series the
 * Spending page draws or the two pages will disagree with each other.
 */
export function savingsPlan(input: {
  categories: CategoryMonths[];
  /** Total spend per complete month. */
  spendMonths: number[];
  /** Net take-home per payslip month, if any are filed. */
  payslipNet: number[];
  /** Monthly total from the income ledger, used when no payslips exist. */
  ledgerIncome: number;
  /** Observed balance drift per month, if the statement carries balances. */
  drift: number | null;
}): SavingsPlan {
  const basedOn = input.spendMonths.length;

  const spendMonthly = quantile(input.spendMonths, 0.5);

  // The bank first. `spend + drift` is what must have come in for the balance
  // to move the way it did, so it needs no source beyond the statement itself.
  const incomeSource: SavingsPlan["incomeSource"] =
    input.drift !== null
      ? "balance"
      : input.payslipNet.length > 0
        ? "payslips"
        : input.ledgerIncome > 0
          ? "ledger"
          : "none";
  const incomeMonthly =
    incomeSource === "balance"
      ? spendMonthly + input.drift!
      : incomeSource === "payslips"
        ? quantile(input.payslipNet, 0.5)
        : incomeSource === "ledger"
          ? input.ledgerIncome
          : 0;

  const surplus = incomeMonthly - spendMonthly;

  // Committed vs discretionary, from the categories themselves.
  const typicalOf = (c: CategoryMonths) => quantile(c.totals, 0.5);
  const committedMonthly = input.categories.filter((c) => c.committed).reduce((a, c) => a + typicalOf(c), 0);
  const discretionaryMonthly = input.categories.filter((c) => !c.committed).reduce((a, c) => a + typicalOf(c), 0);

  // The headroom, category by category. A category with too few months on
  // record contributes nothing rather than a quantile drawn from two samples.
  const headroom = input.categories
    .filter((c) => !c.committed && c.totals.length >= MIN_MONTHS)
    .map((c) => {
      const typical = typicalOf(c);
      const good = quantile(c.totals, 0.25);
      return { category: c.category, typical: r2(typical), good: r2(good), save: r2(Math.max(0, typical - good)) };
    })
    .filter((h) => h.save > 0)
    .sort((a, b) => b.save - a.save);

  const trimmable = headroom.reduce((a, h) => a + h.save, 0);
  const target = Math.max(0, surplus + trimmable);
  const emergencyFund = spendMonthly * 3;

  return {
    incomeMonthly: r2(incomeMonthly),
    incomeSource,
    spendMonthly: r2(spendMonthly),
    surplus: r2(surplus),
    committedMonthly: r2(committedMonthly),
    discretionaryMonthly: r2(discretionaryMonthly),
    trimmable: r2(trimmable),
    target: r2(target),
    targetRate: incomeMonthly > 0 ? Math.round((target / incomeMonthly) * 1000) / 10 : null,
    observed: input.drift === null ? null : r2(input.drift),
    headroom,
    emergencyFund: r2(emergencyFund),
    monthsToFund: target > 0 ? Math.round((emergencyFund / target) * 10) / 10 : null,
    basedOn,
  };
}
