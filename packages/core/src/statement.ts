/**
 * Bank statement CSVs (Revolut's export shape, but the column matching is by
 * name so a similar export from elsewhere lands the same way).
 *
 * The whole point of this module is CLASSIFICATION, not arithmetic. A raw
 * statement sums to nonsense — on a real 777-row export, adding every negative
 * Amount gives −€20,911 against actual card and ATM spending of −€8,903, a 2.3×
 * overstatement. Four things cause that, and each is handled here:
 *
 *   1. Fees live in their own column with Amount 0,00. Eight plan charges worth
 *      €152.92 appear in no Amount total at all.
 *   2. Transfers out (−€11,157) exceed real spending and are money MOVED, not
 *      consumed. They get their own line and never touch the spend figure.
 *   3. Topups look like income but are money arriving from your own accounts.
 *      Income comes from payslips; this file is not asked about it.
 *   4. REVERTED and PENDING rows still carry amounts for money that never moved.
 *
 * Rows are dated by COMPLETED date, not started: a payment begun on 31 December
 * and settled on 1 January belongs to January, because that is when the money
 * left.
 */

import { parseMoney } from "./money.js";

/** What a row means for the money, as opposed to what the bank calls it. */
export type Flow =
  | "spend" // card, ATM, and every fee — actual consumption
  | "refund" // money back on a previous purchase
  | "moved" // transfers and topups: same money, different pocket
  | "other"; // rewards, cashback, anything unclassified

export interface StatementRow {
  /** YYYY-MM-DD, from the completed date. */
  date: string;
  type: string;
  description: string;
  /** Signed, exactly as the file gives it. */
  amount: number;
  fee: number;
  currency: string;
  balance: number | null;
  flow: Flow;
}

export interface MonthSummary {
  month: string;
  /** Card + ATM + fees, as a positive number of euros gone. */
  spend: number;
  fees: number;
  refunds: number;
  movedIn: number;
  movedOut: number;
}

export interface Statement {
  rows: StatementRow[];
  months: MonthSummary[];
  /** First settled balance in the file, for measuring the trend across it. */
  openingBalance: number | null;
  openingDate: string | null;
  /** Balance on the most recent completed row — what runway is computed from. */
  balance: number | null;
  balanceDate: string | null;
  currency: string;
  /** Rows dropped because they never settled, kept as a count so the UI can say so. */
  skipped: number;
}

/**
 * RFC 4180 CSV. Written out rather than pulled in, because a merchant called
 * `BAR, RESTAURANT` splits into two fields under a naive `split(",")` and every
 * column after it shifts — silently turning a description into an amount.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  // Strip a UTF-8 BOM; Excel adds one and it would poison the first header.
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"'; // an escaped quote inside a quoted field
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      // Close the row on \n, and swallow the \n of a \r\n pair.
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);
  return rows;
}

const HEADERS: Record<string, string> = {
  type: "type",
  product: "product",
  "started date": "started",
  "completed date": "completed",
  date: "completed",
  description: "description",
  amount: "amount",
  fee: "fee",
  currency: "currency",
  state: "state",
  balance: "balance",
};

/** Card and ATM are consumption; transfers and topups are not. */
function flowOf(type: string): Flow {
  const t = type.trim().toLowerCase();
  if (t === "card payment" || t === "atm" || t === "charge") return "spend";
  if (t === "card refund") return "refund";
  if (t === "transfer" || t === "topup" || t === "exchange") return "moved";
  return "other";
}

export function parseStatement(csv: string): Statement {
  const table = parseCsv(csv);
  const empty: Statement = { rows: [], months: [], openingBalance: null, openingDate: null, balance: null, balanceDate: null, currency: "EUR", skipped: 0 };
  if (table.length < 2) return empty;

  const cols = table[0]!.map((h) => HEADERS[h.trim().toLowerCase()] ?? "");
  const at = (name: string) => cols.indexOf(name);
  const get = (r: string[], name: string) => {
    const i = at(name);
    return i === -1 ? "" : (r[i] ?? "").trim();
  };
  if (at("amount") === -1) return empty;

  const rows: StatementRow[] = [];
  let skipped = 0;

  for (const raw of table.slice(1)) {
    const state = get(raw, "state").toUpperCase();
    // Only settled money counts. REVERTED and PENDING rows carry an amount for
    // a movement that did not happen; including them is how a statement starts
    // disagreeing with the balance printed on its own last line.
    if (state && state !== "COMPLETED") {
      skipped++;
      continue;
    }
    const completed = get(raw, "completed") || get(raw, "started");
    const date = completed.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      skipped++;
      continue;
    }
    // An amount we cannot read is not a free transaction. Skipping it counts
    // it where a wrong figure would hide it: the old parser returned 0 here,
    // so a garbled cell looked exactly like a €0.00 row (audit B4).
    const amount = parseMoney(get(raw, "amount"));
    if (amount === null) {
      skipped++;
      continue;
    }
    const feeRaw = get(raw, "fee");
    const fee = feeRaw ? parseMoney(feeRaw) : 0;
    if (fee === null) {
      skipped++;
      continue;
    }
    const type = get(raw, "type");
    const balanceRaw = get(raw, "balance");
    rows.push({
      date,
      type,
      description: get(raw, "description"),
      amount,
      fee,
      currency: get(raw, "currency") || "EUR",
      balance: balanceRaw ? parseMoney(balanceRaw) : null,
      flow: flowOf(type),
    });
  }

  rows.sort((a, b) => a.date.localeCompare(b.date));

  const byMonth = new Map<string, MonthSummary>();
  for (const r of rows) {
    const key = r.date.slice(0, 7);
    const m =
      byMonth.get(key) ?? { month: key, spend: 0, fees: 0, refunds: 0, movedIn: 0, movedOut: 0 };
    // A fee is money gone whatever the row's own type says, and it is the half
    // that Amount never shows.
    m.fees += r.fee;
    m.spend += r.fee;
    if (r.flow === "spend" && r.amount < 0) m.spend += -r.amount;
    else if (r.flow === "refund" && r.amount > 0) m.refunds += r.amount;
    else if (r.flow === "moved") {
      if (r.amount > 0) m.movedIn += r.amount;
      else m.movedOut += -r.amount;
    }
    byMonth.set(key, m);
  }

  const round = (n: number) => Math.round(n * 100) / 100;
  const months = [...byMonth.values()]
    .map((m) => ({
      month: m.month,
      spend: round(m.spend),
      fees: round(m.fees),
      refunds: round(m.refunds),
      movedIn: round(m.movedIn),
      movedOut: round(m.movedOut),
    }))
    .sort((a, b) => a.month.localeCompare(b.month));

  // The balance is whatever the last settled row says it was — the statement's
  // own arithmetic, not ours, so it cannot drift from the bank's.
  const withBalance = rows.filter((r) => r.balance !== null);
  const last = withBalance[withBalance.length - 1];
  const first = withBalance[0];

  return {
    rows,
    months,
    openingBalance: first ? first.balance : null,
    openingDate: first ? first.date : null,
    balance: last ? last.balance : null,
    balanceDate: last ? last.date : null,
    currency: rows[0]?.currency ?? "EUR",
    skipped,
  };
}

/** Words too generic to identify a merchant on their own. */
const GENERIC = new Set([
  "plan", "family", "premium", "monthly", "yearly", "subscription",
  "member", "membership", "account", "card", "fee", "pass",
]);

/**
 * The strings that might identify a subscription on a bank statement: the name
 * itself, its first word, and any distinctive word of five letters or more.
 *
 * A card descriptor is nothing like the name you gave the subscription — the
 * Revolut plan charge reads "Metal plan fee" and never says Revolut — so
 * matching has to be looser than equality, and the stoplist is what stops
 * "Family" or "Premium" sweeping up half a statement.
 */
export function subscriptionTerms(name: string): string[] {
  const n = name.trim().toLowerCase();
  const words = n.split(/\s+/).filter(Boolean);
  const out = new Set<string>([n]);
  if (words[0] && words[0].length >= 4) out.add(words[0]);
  for (const w of words) if (w.length >= 5 && !GENERIC.has(w)) out.add(w);
  return [...out].filter((t) => t.length >= 3);
}

/**
 * Keep only the terms that actually identify ONE merchant on this statement.
 *
 * A stoplist cannot anticipate this: "Amsterdam University of Applied Sciences"
 * yields the word "amsterdam", which is not generic English but does match every
 * Amsterdam merchant on the file — on the real statement it quietly claimed four
 * bouldering gyms for the subscriptions category. Rather than guess at which
 * words are place names, brands or noise, check each term against the merchants
 * actually present and drop the ones that hit too many. A subscription resolves
 * to one descriptor, occasionally two; anything broader is a coincidence.
 */
export function usefulTerms(terms: string[], merchants: string[], maxHits = 2): string[] {
  const names = merchants.map((m) => m.trim().toLowerCase());
  return terms.filter((t) => {
    const hits = new Set(names.filter((n) => n.includes(t))).size;
    return hits > 0 && hits <= maxHits;
  });
}

/**
 * Split a month's spending into what was already committed and what was
 * discretionary, by matching descriptions against the subscription names the
 * vault already knows. Matching is loose on purpose — a card descriptor reads
 * `NETFLIX.COM 866-579-7172`, not `Netflix`.
 */
export function splitFixed(
  rows: StatementRow[],
  subscriptionNames: string[],
): { fixed: number; variable: number; matched: string[] } {
  const needles = subscriptionNames
    .map((n) => n.trim().toLowerCase())
    .filter((n) => n.length >= 3)
    // Longest first, so "Revolut Metal Plan" wins over a shorter overlap.
    .sort((a, b) => b.length - a.length);
  const variants = subscriptionTerms;

  let fixed = 0;
  let variable = 0;
  const matched = new Set<string>();

  for (const r of rows) {
    const cost = (r.flow === "spend" && r.amount < 0 ? -r.amount : 0) + r.fee;
    if (cost === 0) continue;
    const hay = r.description.toLowerCase();
    // A subscription's first word is usually the brand; the rest is plan detail
    // that never appears on a card descriptor.
    const hit = needles.find((n) => variants(n).some((v) => hay.includes(v)));
    if (hit) {
      fixed += cost;
      matched.add(hit);
    } else variable += cost;
  }
  return { fixed: Math.round(fixed * 100) / 100, variable: Math.round(variable * 100) / 100, matched: [...matched] };
}
