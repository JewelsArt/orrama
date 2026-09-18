/**
 * One money parser, for every amount that arrives as text.
 *
 * Three copies of this used to live in this package and two of them were wrong
 * (audit B4). `statement.ts` did `.replace(",", ".")` — the first comma only,
 * and nothing at all for a dot used as a thousands separator — so `1,234.56`
 * and `1.234,56` both read as **1.234**, a thousandfold understatement that ran
 * straight into `openingBalance`, `balance`, `drift`, `surplus`, `runwayMonths`
 * and the whole savings plan. `payslip.ts` stripped commas outright, turning a
 * Dutch `900,50` into **90050**. Both then returned 0 on unparseable input, so
 * a garbled cell was indistinguishable from a free transaction.
 *
 * The rule, which the subscriptions ledger already had right: strip everything
 * that is not a digit or a separator, then read `1.234,56` and `1,234.56` alike
 * by taking **whichever separator comes last as the decimal point**. There is
 * one determinate exception — a separator that repeats and is always followed
 * by exactly three digits is grouping, not a decimal point, so `1,234,567` is
 * 1234567 rather than 1234.567.
 *
 * `1.234` on its own stays genuinely ambiguous (1234 Dutch, 1.234 English) and
 * resolves as a decimal point, per the rule above.
 *
 * Nothing here returns 0 for input it could not read. A caller that wants a
 * number for a missing cell says so; a caller handed nonsense finds out.
 */

const SYMBOL: Record<string, string> = { "€": "EUR", $: "USD", "£": "GBP" };
const CODE = /\b(EUR|USD|GBP|CHF|SEK|NOK|DKK|PLN|CAD|AUD)\b/i;

/**
 * `"1.234,56"` / `"1,234.56"` / `"-€1 234,56"` / `"(1,234.56)"` → number.
 * `null` when there is no number in there at all.
 */
export function parseMoney(raw: string): number | null {
  const text = String(raw ?? "");
  const digits = text.replace(/[^\d.,]/g, "");
  if (!/\d/.test(digits)) return null;

  // Sign is read before the separators, because stripping non-digits throws it
  // away: a bank CSV writes `-1.234,56` and an accounting export `(1.234,56)`,
  // and the old subscriptions parser silently turned both positive.
  const firstDigit = text.search(/\d/);
  const trimmed = text.trim();
  // The parenthesised form is only read as negative when the parens WRAP the
  // whole cell, so a label like "Netflix (Family)" can never flip a price.
  const negative =
    text.slice(0, firstDigit).includes("-") ||
    (trimmed.startsWith("(") && trimmed.endsWith(")"));

  const lastComma = digits.lastIndexOf(",");
  const lastDot = digits.lastIndexOf(".");
  const at = Math.max(lastComma, lastDot);

  let normalised: string;
  if (at === -1) {
    normalised = digits;
  } else {
    const sep = digits[at]!;
    const tail = digits.slice(at + 1);
    const repeats = digits.split(sep).length - 1 > 1;
    // Repeated, and every group behind it is three digits long: grouping.
    const grouping = repeats && tail.length === 3 && digits.split(sep).slice(1).every((g) => g.length === 3);
    normalised = grouping
      ? digits.replace(/[.,]/g, "")
      : `${digits.slice(0, at).replace(/[.,]/g, "")}.${tail}`;
  }

  const n = Number.parseFloat(normalised);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

/**
 * The same number, plus whichever currency the text names. Used by the
 * subscriptions ledger, where a row is written by hand as `€10,99` or
 * `10.99 EUR` and the currency is load-bearing — `monthlyTotals` keeps its
 * sums per currency because adding them "would be a lie".
 */
export function parseMoneyWithCurrency(raw: string): { amount: number; currency: string } | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  const amount = parseMoney(text);
  if (amount === null) return null;
  let currency = "";
  for (const [sym, code] of Object.entries(SYMBOL)) if (text.includes(sym)) currency = code;
  const match = CODE.exec(text);
  if (match) currency = match[1]!.toUpperCase();
  return { amount, currency: currency || "EUR" };
}
