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
 * The rule: read ONE number out of the cell, and read `1.234,56` and
 * `1,234.56` alike by taking **whichever separator comes last as the decimal
 * point**. Three refinements, all from cells a person types into a ledger in
 * Obsidian (audit FIN-005):
 *
 * - **One number, or none.** Every digit in the cell used to be glued
 *   together, so `€29.99 (was 24.99)` read as 299,924.99. A parenthesised
 *   aside is dropped first (`€17,99 (6 people)` is 17.99); if more than one
 *   number is still left (`10.99 EUR / 12 months`), the cell is ambiguous and
 *   the answer is `null` — the ledger shows the row as unreadable rather than
 *   adding up a number nobody wrote.
 * - **A lone separator before exactly three digits is grouping.** `€1.200`
 *   and `1,200` are twelve hundred, not 1.2: a three-digit fraction is never
 *   meant for money, and reading it as one understated a Dutch-written yearly
 *   fee a thousandfold. `0.125` (and `.125`) stays a fraction — nobody groups
 *   a leading zero. A separator that repeats is grouping only when every group
 *   is three digits; `1.2.3` is not a number.
 * - **Every way of writing minus.** ASCII `-`, U+2212 `−`, en and em dashes,
 *   before the number (the currency may sit between) or trailing it (`12.00-`,
 *   the German/Dutch bank style), and parentheses that wrap the whole cell.
 *   The Dutch whole-euro `25,-` is not a minus.
 *
 * A caller that knows its format says so: `decimal` fixes which separator is
 * the decimal point (the payslip PDF writes `13,250` for an hourly rate), and
 * nothing is guessed.
 *
 * Nothing here returns 0 for input it could not read. A caller that wants a
 * number for a missing cell says so; a caller handed nonsense finds out.
 */

const SYMBOL: Record<string, string> = { "€": "EUR", $: "USD", "£": "GBP" };
const CODE = /\b(EUR|USD|GBP|CHF|SEK|NOK|DKK|PLN|CAD|AUD)\b/i;

const MINUS = "-\u2212\u2013\u2014";
/** Space-grouped (`1 234,56`, NBSP and narrow NBSP too), or anything else digit-led. */
const NUMBER = /\d{1,3}(?:[ \u00a0\u202f]\d{3})+(?:[.,]\d+)?(?!\d)|[.,]?\d[\d.,'\u2019]*/g;
const SIGN_BEFORE = new RegExp(`[${MINUS}]\\s*(?:[€$£]|[A-Za-z]{3})?\\s*$`);
const SIGN_AFTER = new RegExp(`^\\s*[${MINUS}]\\s*(?:[€$£]|[A-Za-z]{3})?\\s*$`);

/**
 * `"1.234,56"` / `"1,234.56"` / `"-€1 234,56"` / `"(1,234.56)"` / `"12.00-"` → number.
 * `null` when there is no number in there, or more than one.
 */
export function parseMoney(raw: string, decimal?: "," | "."): number | null {
  let text = String(raw ?? "").trim();
  let negative = false;
  // The parenthesised form is only read as negative when the parens WRAP the
  // whole cell, so a label like "Netflix (Family)" can never flip a price.
  if (text.startsWith("(") && text.endsWith(")") && !text.slice(1, -1).includes("(")) {
    negative = true;
    text = text.slice(1, -1);
  }
  // Asides are not the amount: "(6 people)", "(was 24.99)", "(Family)".
  text = text.replace(/\([^()]*\)/g, " ");
  // Dutch whole units, "€ 25,-": the dash closes the number, it is not a sign.
  text = text.replace(/(\d)[.,][-\u2013]{1,2}(?!\d)/g, "$1");

  const found = [...text.matchAll(NUMBER)];
  if (found.length !== 1) return null;
  const match = found[0]!;
  const before = text.slice(0, match.index);
  const after = text.slice(match.index! + match[0].length);
  if (SIGN_BEFORE.test(before) || SIGN_AFTER.test(after)) negative = !negative;

  const value = readNumber(match[0].replace(/[.,'\u2019]+$/, ""), decimal);
  if (value === null) return null;
  return negative ? -value : value;
}

/** One number token, separators and all, as a non-negative value. */
function readNumber(token: string, decimal?: "," | "."): number | null {
  // Apostrophes and spaces only ever group (Swiss `1'234.56`, `1 234,56`).
  const digits = token.replace(/['\u2019 \u00a0\u202f]/g, "");
  let normalised: string;
  if (decimal) {
    const group = decimal === "," ? "." : ",";
    const parts = digits.split(decimal);
    if (parts.length > 2) return null;
    normalised = parts[0]!.split(group).join("") + (parts.length === 2 ? `.${parts[1]}` : "");
  } else {
    const at = Math.max(digits.lastIndexOf(","), digits.lastIndexOf("."));
    if (at === -1) {
      normalised = digits;
    } else {
      const sep = digits[at]!;
      const head = digits.slice(0, at);
      const tail = digits.slice(at + 1);
      const groups = digits.split(sep);
      const otherSep = sep === "," ? "." : ",";
      if (groups.length > 2) {
        // Repeated: grouping, but only when every group is three digits and
        // nothing else separates them — 1.234.567, never 1.2.3.
        if (digits.includes(otherSep) || !groups.slice(1).every((g) => g.length === 3)) return null;
        normalised = groups.join("");
      } else if (!head.includes(otherSep) && tail.length === 3 && /^[1-9]\d{0,2}$/.test(head)) {
        // A lone separator before exactly three digits: €1.200, 1,200.
        normalised = head + tail;
      } else {
        normalised = `${head.replace(/[.,]/g, "")}.${tail}`;
      }
    }
  }
  if (!/^\d*\.?\d+$/.test(normalised)) return null;
  const n = Number.parseFloat(normalised);
  return Number.isFinite(n) ? n : null;
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
