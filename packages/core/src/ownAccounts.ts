/**
 * Accounts that are Jules's own money somewhere else — a broker, a savings pot.
 *
 * A statement cannot tell a deposit into Capital.com from a purchase: the bank
 * files it as a Card Payment, so it counted as spending (€1,640 of CFD deposits
 * in 2020–21). The list lives in a note tagged `#own-accounts`, the same way the
 * other ledgers do:
 *
 *   | Account     | Matches     |
 *   |-------------|-------------|
 *   | Capital.com | capital.com |
 *
 * A row matching one is money MOVED, whatever the bank calls it:
 *
 *   - Going out it is not spending, and the savings plan counts it as saved.
 *   - Coming back it is first the principal returning — not income, and it
 *     un-saves what went in — and only the part above what was put in is a
 *     gain, which is income like any other.
 *
 * Matching uses the category matcher (`ruleFor`), so `=exact`, accent folding
 * and longest-term-wins behave exactly as they do in the categories note.
 */
import { ruleFor, type CategoryRule } from "./spending.js";
import type { StatementRow } from "./statement.js";
import { cells, isRule, mapHeader } from "./table.js";

export interface OwnAccount {
  account: string;
  /** Lower-cased terms, as in the categories note. */
  matches: string[];
}

const HEADERS: Record<string, string> = {
  account: "account",
  name: "account",
  matches: "matches",
  match: "matches",
  keywords: "matches",
};

/** Read the own-accounts table. Rows without a name or any match are skipped. */
export function parseOwnAccounts(content: string): OwnAccount[] {
  const out: OwnAccount[] = [];
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
      if (mapped.includes("account") && mapped.includes("matches")) cols = mapped;
      continue;
    }
    const get = (k: string) => (row[cols!.indexOf(k)] ?? "").trim();
    const account = get("account");
    const matches = get("matches")
      .split(",")
      .map((m) => m.trim().toLowerCase())
      .filter(Boolean);
    if (account && matches.length > 0) out.push({ account, matches });
  }
  return out;
}

const cents = (n: number) => Math.round(n * 100) / 100;

/**
 * Mark every row that moves money to or from an own account.
 *
 * Runs over the WHOLE history, oldest first, because what counts as a gain
 * depends on everything deposited before it: a €300 withdrawal is principal if
 * €1,640 went in, and €160 of it is gain if only €140 did. A withdrawal the
 * bank files as a Card Refund becomes a move too, so run this before
 * settleRefunds and the refund never gets matched to the deposit at all.
 */
export function markOwnAccounts(rows: StatementRow[], accounts: OwnAccount[]): StatementRow[] {
  if (accounts.length === 0) return rows;
  const rules: CategoryRule[] = accounts.map((a) => ({ category: a.account, matches: a.matches, colour: null }));
  const principal = new Map<string, number>(); // account → deposited and not yet returned
  const order = rows.map((r, i) => ({ r, i })).sort((a, b) => a.r.date.localeCompare(b.r.date) || a.i - b.i);
  const out = [...rows];
  for (const { r, i } of order) {
    const account = ruleFor(r.description, rules)?.category;
    if (!account) continue;
    const held = principal.get(account) ?? 0;
    if (r.amount < 0) {
      principal.set(account, cents(held - r.amount));
      out[i] = { ...r, flow: "moved", own: account };
    } else {
      const back = Math.min(r.amount, held);
      principal.set(account, cents(held - back));
      out[i] = { ...r, flow: "moved", own: account, gain: cents(r.amount - back) };
    }
  }
  return out;
}

/**
 * Per month: money put into own accounts minus principal taken back out.
 * Gains are not in it — they are income, and the balance already shows them.
 */
export function ownSavedByMonth(rows: StatementRow[]): Map<string, number> {
  const months = new Map<string, number>();
  for (const r of rows) {
    if (!r.own) continue;
    const saved = r.amount < 0 ? -r.amount : -(r.amount - (r.gain ?? 0));
    const key = r.date.slice(0, 7);
    months.set(key, cents((months.get(key) ?? 0) + saved));
  }
  return months;
}
