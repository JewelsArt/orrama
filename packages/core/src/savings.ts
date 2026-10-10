/**
 * How much could actually be saved each month.
 *
 * Every "savings advice" feature is tempted to invent a rule — 50/30/20, "cut
 * your coffee" — and every one of them is a guess about someone else. This one
 * is derived from Jules's own statement, and the whole model is two numbers:
 *
 *   surplus   = money in  −  money out, in an average month
 *   trimmable = a typical month's discretionary spending − a good month's
 *
 * `surplus` comes from the BANK, not from a payslip. Where the statement
 * carries balances, the slope between the first and last of them says what the
 * account is really doing, and money in is then an identity rather than a
 * guess: whatever went OUT, plus whatever the balance grew by.
 *
 * Out means out — every debit, not just what `costOf` calls spending. An
 * unclaimed transfer is money that left the account, and leaving it out of the
 * identity understates income by exactly that much: a €600 standing transfer
 * to savings reported €1,400 of income against a real €2,000 (audit). Payslips are a
 * poor proxy for it — they cover one employer, and everything else that lands
 * (student finance, transfers, a second job) is invisible to them. On Jules's
 * own file the payslip median said €500 a month while the balance was climbing
 * €300 on top of €1,000 of spending, so the payslip-based version reported a
 * €500 deficit for an account that was visibly growing. Payslips and the income
 * note are kept as fallbacks for when there is no balance to slope.
 *
 * `trimmable` is the honest half, and it is measured between TWO REAL MONTHS.
 * Take the discretionary total of every complete month; the typical month is
 * the one nearest the median of that series and the good month the one nearest
 * its 25th percentile. The gap between them is not aspiration — it is two
 * months he has lived through, and the per-category rows are literally what
 * each category cost in each of them, so they add up to the total exactly.
 *
 * This used to be Σ over categories of (that category's median − that
 * category's p25), which is not any month that happened and is systematically
 * over-optimistic, because no two categories sit at their own quantile in the
 * same month. Two categories alternating over four months where EVERY month
 * cost €500 reported €300 of headroom (audit). It is the same error the
 * dashboard's old "typical month" made, on the other half of the model.
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
  /** Money in per month, and where the figure came from. From the balance it
   *  is an average month's: outflowMonthly + drift. */
  incomeMonthly: number;
  incomeSource: "balance" | "payslips" | "ledger" | "none";
  /** Typical money SPENT per month, from the statement. Drives the fund. */
  spendMonthly: number;
  /**
   * Money OUT in an average month: every debit, transfers included. A mean,
   * not a median, because the drift it is set against is one: money in =
   * out + the balance change holds for averages, and a median out plus a
   * mean drift dropped every one-off transfer ÷ months out of income — a
   * €5,000 month among €1,000 ones reported €1,000 of income against a real
   * €2,000 (audit FIN-011).
   */
  outflowMonthly: number;
  /** incomeMonthly − outflowMonthly. Negative means the account is shrinking. */
  surplus: number;
  /** The part of the typical month's spending that no in-month decision
   *  changes. With discretionaryMonthly it adds up to that month's spend. */
  committedMonthly: number;
  /** The part of the typical month's spending that does respond to intent. */
  discretionaryMonthly: number;
  /** A typical month's discretionary spending less a good month's. */
  trimmable: number;
  /** The two real months those figures come from. Null under MIN_MONTHS. */
  typicalMonth: string | null;
  goodMonth: string | null;
  /** surplus + trimmable, floored at zero — the realistic monthly target. */
  target: number;
  /** target ÷ incomeMonthly, as a percentage. Null with no income on record. */
  targetRate: number | null;
  /** What is being saved already, from the balance trend. Null without one.
   *  Equal to `surplus` whenever the statement carries balances — the two are
   *  the same fact, and showing them as one number twice is deliberate: it is
   *  what makes the plan checkable against the account. */
  observed: number | null;
  /**
   * What each discretionary category cost in those two months, biggest gap
   * first. A category that cost MORE in the good month keeps its negative
   * figure rather than being dropped: the rows have to add up to `trimmable`,
   * and hiding the ones that argue against the total is how the old version
   * came to over-promise.
   */
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
  /**
   * Total money OUT per complete month — every debit, fees and transfers
   * included. Index-aligned with `spendMonths`. Omitted, income falls back to
   * spend, which is the understatement this input exists to fix.
   */
  outflowMonths?: number[];
  /** Those months' own labels, index-aligned. Lets the plan name the two it
   *  compared, so "a good month" is checkable rather than a claim. */
  months?: string[];
  /** Net take-home per payslip month, if any are filed. */
  payslipNet: number[];
  /** Monthly total from the income ledger, used when no payslips exist. */
  ledgerIncome: number;
  /** Observed balance drift per month, if the statement carries balances. */
  drift: number | null;
}): SavingsPlan {
  const basedOn = input.spendMonths.length;

  const spendMonthly = quantile(input.spendMonths, 0.5);
  const outflowMonths = input.outflowMonths?.length ? input.outflowMonths : input.spendMonths;
  const outflowMonthly = outflowMonths.length ? outflowMonths.reduce((a, v) => a + v, 0) / outflowMonths.length : 0;

  // The bank first. `out + drift` is what must have come in for the balance
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
      ? outflowMonthly + input.drift!
      : incomeSource === "payslips"
        ? quantile(input.payslipNet, 0.5)
        : incomeSource === "ledger"
          ? input.ledgerIncome
          : 0;

  // Out means every debit. With a balance to slope this is an identity and
  // `surplus` comes back out as the drift itself, which is the property that
  // makes the plan checkable against the account.
  const surplus = incomeMonthly - outflowMonthly;

  /**
   * The headroom, between two months that actually happened.
   *
   * Discretionary spending is totalled per month across the categories (their
   * `totals` arrays are index-aligned by construction — every caller maps over
   * the same list of complete months). The typical month is the one whose
   * discretionary total sits nearest the median of that series, the good month
   * the one nearest its 25th percentile: real months, picked by rank, so the
   * per-category rows below are simply what each cost in each of them.
   *
   * Nearest-to-quantile rather than the quantile itself, because the point is
   * to name a month. The cheapest month on record is usually an artefact — a
   * holiday, a half-covered month — so p25 rather than the minimum.
   */
  const discretionary = input.categories.filter(
    (c) => !c.committed && c.totals.length >= input.spendMonths.length,
  );
  const discTotals = input.spendMonths.map((_, i) => discretionary.reduce((a, c) => a + (c.totals[i] ?? 0), 0));

  /**
   * The month at a given rank, not at a given value. Interpolating a quantile
   * gives a number no month ever cost; ranking the months and taking one of
   * them gives a month. It also guarantees good <= typical, which a
   * nearest-to-value search does not — on a four-month series with a tie it
   * picked the same month twice and reported no headroom at all.
   */
  const byTotal = discTotals.map((total, i) => ({ total, i })).sort((a, b) => a.total - b.total);
  const typicalRank = Math.round((byTotal.length - 1) * 0.5);
  /**
   * The good month sits one rank below the typical one at least. Rounding
   * both ranks the same way made them the same month at three months — the
   * minimum the plan accepts — so headroom was always €0 there, however much
   * the months varied (audit FIN-016).
   */
  const goodRank = Math.min(Math.round((byTotal.length - 1) * 0.25), typicalRank - 1);

  const enough = basedOn >= MIN_MONTHS && discTotals.length > 0;
  const typicalIdx = enough ? byTotal[typicalRank]!.i : -1;
  const goodIdx = enough ? byTotal[Math.max(goodRank, 0)]!.i : -1;

  /**
   * Committed vs discretionary, read off the typical month itself, like the
   * headroom rows. Summing each category's own median gave two figures no
   * month ever cost, which did not add up to the spending beside them —
   * the sum-of-quantiles this module's header warns against.
   */
  const inTypical = (committed: boolean) =>
    enough ? input.categories.filter((c) => c.committed === committed).reduce((a, c) => a + (c.totals[typicalIdx] ?? 0), 0) : 0;
  const committedMonthly = inTypical(true);
  const discretionaryMonthly = inTypical(false);

  const headroom = enough
    ? discretionary
        .map((c) => {
          const typical = c.totals[typicalIdx] ?? 0;
          const good = c.totals[goodIdx] ?? 0;
          return { category: c.category, typical: r2(typical), good: r2(good), save: r2(typical - good) };
        })
        .filter((h) => h.typical !== 0 || h.good !== 0)
        .sort((a, b) => b.save - a.save)
    : [];

  const trimmable = Math.max(0, r2(headroom.reduce((a, h) => a + h.save, 0)));
  const target = Math.max(0, surplus + trimmable);
  const emergencyFund = spendMonthly * 3;

  return {
    incomeMonthly: r2(incomeMonthly),
    incomeSource,
    spendMonthly: r2(spendMonthly),
    outflowMonthly: r2(outflowMonthly),
    surplus: r2(surplus),
    committedMonthly: r2(committedMonthly),
    discretionaryMonthly: r2(discretionaryMonthly),
    trimmable: r2(trimmable),
    typicalMonth: enough ? (input.months?.[typicalIdx] ?? null) : null,
    goodMonth: enough ? (input.months?.[goodIdx] ?? null) : null,
    target: r2(target),
    targetRate: incomeMonthly > 0 ? Math.round((target / incomeMonthly) * 1000) / 10 : null,
    observed: input.drift === null ? null : r2(input.drift),
    headroom,
    emergencyFund: r2(emergencyFund),
    monthsToFund: target > 0 ? Math.round((emergencyFund / target) * 10) / 10 : null,
    basedOn,
  };
}
