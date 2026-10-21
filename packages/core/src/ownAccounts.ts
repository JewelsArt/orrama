/**
 * Accounts that are Jules's own money somewhere else — a broker, a savings pot.
 *
 * A statement cannot tell a deposit into Capital.com from a purchase: the bank
 * files it as a Card Payment, so every broker deposit counted as spending. The list lives in a note tagged `#own-accounts`, the same way the
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
import { appendRow, cells, changeRow, isRule, mapHeader, readLedgerTable, removeRow, type LedgerSpec, type LedgerTable, type RowRef, type RowWrite } from "./table.js";

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
 * €1,000 went in, and €160 of it is gain if only €140 did. A withdrawal the
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

/* ---- the list, changed from a screen ---------------------------------------- */

const OWN_LEDGER: LedgerSpec = { headers: HEADERS, accepts: (m) => m.includes("account") && m.includes("matches"), key: "account" };

/** The columns of an own-accounts note the app makes itself. */
export const OWN_ACCOUNT_COLUMNS = ["Account", "Matches"] as const;

/** Every row of the own-accounts note, as written. */
export const ownAccountTable = (content: string): LedgerTable => readLedgerTable(content, OWN_LEDGER);
export const changeOwnAccountRow = (content: string, ref: RowRef, set: { account?: string; matches?: string }): RowWrite => changeRow(content, OWN_LEDGER, ref, set);
export const removeOwnAccountRow = (content: string, ref: RowRef): RowWrite => removeRow(content, OWN_LEDGER, ref);
/** A new account at the end, or null when the note has no such table. */
export const appendOwnAccountRow = (content: string, row: { account: string; matches: string }): string | null => appendRow(content, HEADERS, ["account", "matches"], row);
