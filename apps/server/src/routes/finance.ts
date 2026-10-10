/**
 * Money in and money out — the Finance area.
 *
 * Both sides are ordinary notes holding a Markdown table, found by tag
 * (`#income`, `#subscriptions`) rather than by path, so they can live anywhere
 * in the PARA tree and stay editable in Obsidian. There is no finance table in
 * SQLite: delete the database, re-index, and the numbers come back — the same
 * rule the dashboard and the project workspace follow.
 *
 * The only write is "append one row", and it goes through `VaultStore.write`
 * like every other mutation, so it is ACL-checked, id-preserving and picked up
 * by the live-sync bus for free.
 */
import fs from "node:fs";
import path from "node:path";
import {
  appendMoneyRow,
  appendPayslipRow,
  monthlyTotals,
  parsePayslip,
  parsePayslipTable,
  completeMonths,
  forecast,
  categoryOf as categoryOfRow,
  costOf,
  findRecurring,
  isoLocal,
  unclaimedRecurring,
  merchantsByCategory,
  monthlyByCategory,
  outflowByMonth,
  parseCategoryRules,
  parseStatement,
  byTime,
  parseSubscriptions,
  payslipUsable,
  savingsPlan,
  inMainPocket,
  coverageOf,
  fullMonths,
  subscriptionTerms,
  typicalMonth,
  usefulTerms,
  settleRefunds,
  monthsAround,
  canEdit,
  canRead,
  type AclNote,
  markOwnAccounts,
  ownSavedByMonth,
  parseOwnAccounts,
  type OwnAccount,
  recentMonths,
} from "@basalt/core";
import { extractText, getDocumentProxy } from "unpdf";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db.js";
import { HttpError, type VaultStore } from "../vaultStore.js";
import { writeFileAtomic } from "../atomicWrite.js";

export const FINANCE_TAG = { income: "income", subscriptions: "subscriptions" } as const;

/** Where uploaded payslips and statements land: real files beside the notes, so
 *  they show up in Finder and Obsidian and travel with a vault backup — exactly
 *  the arrangement project documents use. */
export const FINANCE_DIR = "02-Areas/finance";
const filesDir = (root: string) => path.join(root, FINANCE_DIR, "files");

/**
 * Statements and payslips are files with no note of their own, so they are
 * judged as the folder they sit in — the rule every note beside them already
 * follows. Before this, any signed-in account could read the owner's bank
 * statements: the routes resolved the user and checked nothing (audit, high).
 */
const FILES_ACL: AclNote = { folder: `${FINANCE_DIR}/files`, onlyTeams: [], shareTeams: [] };
type Reader = Parameters<VaultStore["readable"]>[0];
export const canReadFinanceFiles = (store: VaultStore, user: Reader) => canRead(user, FILES_ACL, store.grants());
const canEditFinanceFiles = (store: VaultStore, user: Reader) => canEdit(user, FILES_ACL, store.grants());
/** 404 rather than 403 when the folder is invisible: no existence confirmation (§5.4). */
function requireFinanceFiles(store: VaultStore, user: Reader, edit = false): void {
  if (!canReadFinanceFiles(store, user)) throw new HttpError(404, "not found");
  if (edit && !canEditFinanceFiles(store, user)) throw new HttpError(403, "no edit access to the finance files");
}

const MAX_UPLOAD = 15 * 1024 * 1024;
/** Caps for reading an .xlsx back out; the same numbers project documents use. */
const MAX_SHEETS = 12;
const MAX_SHEET_ROWS = 500;
const MAX_SHEET_COLS = 40;

/**
 * A filename we are willing to create. Anything with a separator or a dot-dot
 * is rejected outright rather than flattened by basename(): a request that
 * tried to escape is a request to refuse, not to quietly rewrite.
 */
function safeUploadName(raw: unknown): string {
  const name = String(raw ?? "").trim();
  if (!name || name.length > 120) throw new HttpError(400, "filename required (max 120 chars)");
  if (name.includes("/") || name.includes("\\") || name.includes("..") || name.startsWith("."))
    throw new HttpError(400, "invalid filename");
  // Statements come out of Revolut as .xlsx or .csv; payslips as .pdf.
  if (!/\.(pdf|csv|xlsx)$/i.test(name)) throw new HttpError(415, "only .pdf, .csv and .xlsx are accepted");
  return name;
}
export type FinanceKind = keyof typeof FINANCE_TAG;

/** The note carrying one side of the ledger, or undefined if none is tagged. */
export function financeNote(store: VaultStore, user: Parameters<VaultStore["readable"]>[0], kind: FinanceKind) {
  return store.readable(user).find((n) => n.tags.some((t) => t.tag === FINANCE_TAG[kind]));
}

/**
 * Every statement CSV in the finance folder, merged and de-duplicated.
 *
 * Exports overlap at their edges, so the same transaction can sit in two
 * files and must count once — while two identical-looking purchases in ONE
 * file (two coffees, same shop, same day, same price) are two transactions and
 * must count twice. Keying on date + amount + fee + description could not tell
 * those apart and merged real repeats: on the real statement, 36 transactions
 * and EUR 599.50 simply vanished from every total.
 *
 * So each row carries a `key` from everything the export says (StatementRow.key
 * — timestamps to the second and the running balance included), and files are
 * merged as multisets: a key appearing N times in one export is N
 * transactions, and the merge keeps the most copies any SINGLE export holds.
 * That stays right for a bank whose export has no times and no balance, where
 * two identical rows in one file are all there is to go on.
 *
 * Four endpoints need this list; they read it through here rather than each
 * keeping their own copy, because three copies of a de-duplication rule is
 * three chances for two pages to disagree about what a month cost.
 */
/**
 * Every statement file, parsed, with the currency they are read in: the one
 * most rows use across all files. Each file already keeps to its own main
 * currency (parseStatement); this stops a USD-only export beside the euro ones
 * from adding its dollars to euro months or supplying the "latest" balance.
 */
function statements(root: string): { currency: string; files: ReturnType<typeof parseStatement>[] } {
  const dirPath = filesDir(root);
  if (!fs.existsSync(dirPath)) return { currency: "EUR", files: [] };
  const files = fs
    .readdirSync(dirPath)
    .filter((n) => n.toLowerCase().endsWith(".csv"))
    .sort()
    .map((csv) => parseStatement(fs.readFileSync(path.join(dirPath, csv), "utf8")));
  const weight = new Map<string, number>();
  for (const f of files) weight.set(f.currency, (weight.get(f.currency) ?? 0) + f.rows.length);
  const currency = [...weight.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? "EUR";
  return { currency, files: files.filter((f) => f.currency === currency || f.rows.length === 0) };
}

export function loadTxns(root: string, own: OwnAccount[] = []): ReturnType<typeof parseStatement>["rows"] {
  return loadStatements(root, own).txns;
}

/**
 * The merged transactions and what the files cover. Complete months are read
 * off the coverage (fullMonths), never inferred from which months had
 * spending in them (FIN-008).
 */
export function loadStatements(root: string, own: OwnAccount[] = []): { txns: ReturnType<typeof parseStatement>["rows"]; complete: string[] } {
  const files = statements(root).files;
  const rows: ReturnType<typeof parseStatement>["rows"] = [];
  const merged = new Map<string, typeof rows>(); // key → the most copies any one export holds
  for (const file of files) {
    const inFile = new Map<string, typeof rows>();
    for (const r of file.rows) {
      const same = inFile.get(r.key);
      if (same) same.push(r);
      else inFile.set(r.key, [r]);
    }
    for (const [key, copies] of inFile) {
      if (copies.length > (merged.get(key)?.length ?? 0)) merged.set(key, copies);
    }
  }
  for (const copies of merged.values()) rows.push(...copies);
  rows.sort(byTime); // by completed time, not date: see byTime
  // Own accounts first, so a withdrawal filed as a Card Refund is a move, not
  // a refund to net off the deposit (ownAccounts.ts).
  // Each refund comes off the purchase it refunds, in that purchase's month,
  // or — bought before these statements begin — off nothing (spending.ts).
  return { txns: settleRefunds(markOwnAccounts(rows, own)), complete: fullMonths(coverageOf(files.map((f) => f.rows))) };
}

/** The own-accounts list — a broker, a savings pot — from the note tagged #own-accounts. */
export function ownAccountsFor(store: VaultStore, user: Parameters<VaultStore["readable"]>[0]): OwnAccount[] {
  const note = store.readable(user).find((n) => n.tags.some((t) => t.tag === "own-accounts"));
  return note ? parseOwnAccounts(note.content) : [];
}

/** loadStatements with the reader's own-accounts list applied — what every endpoint wants. */
export const statementsFor = (store: VaultStore, user: Parameters<VaultStore["readable"]>[0]) =>
  canReadFinanceFiles(store, user) ? loadStatements(store.vaultRoot, ownAccountsFor(store, user)) : { txns: [], complete: [] };

/** Just the transactions, for a page that never asks which months are complete. */
export const txnsFor = (store: VaultStore, user: Parameters<VaultStore["readable"]>[0]) => statementsFor(store, user).txns;

/**
 * The drift the savings plan reads: the balance's slope PLUS what went into own
 * accounts (less principal taken back) over the same months. A €500 deposit at
 * the broker lowers the bank balance by €500, and it is saved, not lost. The
 * Balance card keeps the raw slope — that is what the account itself did.
 */
export function savingsDrift(txns: ReturnType<typeof parseStatement>["rows"], months: string[]): number | null {
  const { drift, counted } = balanceTrend(txns, months);
  if (drift === null || counted.length === 0) return drift;
  // The same pocket as the balance: a deposit is added back onto the slope
  // only if it came out of the account whose slope this is — and over the
  // same months the slope was measured across.
  const saved = ownSavedByMonth(inMainPocket(txns));
  return drift + counted.reduce((a, m) => a + (saved.get(m) ?? 0), 0) / counted.length;
}

/**
 * The category rules, with Subscriptions pinned in front of them.
 *
 * Built from the subscriptions ledger rather than typed into the rules note:
 * the ledger already knows what recurs, and duplicating those merchants by hand
 * means two lists to keep in step. Pinned, so a recurring charge is filed as
 * recurring before it is filed by merchant type — Adobe is a subscription that
 * happens to be software, and under Software it disappears into a number you
 * cannot act on.
 */
/**
 * The balances the bank printed, and the slope between them.
 *
 * A balance is a property of the export, not of a row, so it is read per file
 * rather than from the merged transaction list. The slope between the first and
 * last settled balance is what the account is actually doing — which is why the
 * savings plan takes money-in from here rather than from payslips, and why both
 * the Finance tab and the Dashboard must read it from the same place or they
 * will quote different savings targets on the same data.
 */
export function balanceSpan(root: string): {
  balance: number | null;
  balanceDate: string | null;
  opening: number | null;
  openingDate: string | null;
  spanMonths: number;
  drift: number | null;
  skipped: number;
} {
  let balance: number | null = null;
  let balanceDate: string | null = null;
  let opening: number | null = null;
  let openingDate: string | null = null;
  let skipped = 0;
  {
    for (const st of statements(root).files) {
      skipped += st.skipped;
      if (st.balance !== null && (balanceDate === null || (st.balanceDate ?? "") > balanceDate)) {
        balance = st.balance;
        balanceDate = st.balanceDate;
      }
      if (st.openingBalance !== null && (openingDate === null || (st.openingDate ?? "") < openingDate)) {
        opening = st.openingBalance;
        openingDate = st.openingDate;
      }
    }
  }
  const spanDays =
    opening !== null && openingDate && balanceDate
      ? (Date.parse(`${balanceDate}T00:00:00Z`) - Date.parse(`${openingDate}T00:00:00Z`)) / 86_400_000
      : 0;
  const spanMonths = spanDays / 30.44;
  // Under a month of history is too short a base to extrapolate from.
  const drift = opening !== null && balance !== null && spanMonths >= 1 ? (balance - opening) / spanMonths : null;
  return { balance, balanceDate, opening, openingDate, spanMonths, drift, skipped };
}

/**
 * What the account's balance did across a run of complete months: the balance
 * the bank printed just before the first of them, the one after the last, and
 * the monthly slope between. Money-in, burn and runway are read off this, so
 * it covers the SAME months as the typical figures — a slope from a 2020
 * balance set against this year's spending made income minus outflow stop
 * matching the account.
 *
 * Measured per CONTIGUOUS run of those months and divided by the months
 * measured. Two exports, January–March and July–September, used to be read
 * as one run: the balance change across nine months over six, which inflated
 * the drift, the income derived from it and the savings target by half
 * (audit FIN-008). Each run opens at the balance before its own first row —
 * after = before + amount − fee — so a gap's movements are never counted.
 * `counted` is the months that had a balance to measure.
 */
export function balanceTrend(
  txns: ReturnType<typeof parseStatement>["rows"],
  months: string[],
): { drift: number | null; spanMonths: number; counted: string[] } {
  // One pocket's running balance: Savings' balance is not Current's (FIN-002).
  const priced = inMainPocket(txns).filter((r) => r.balance !== null);
  const runs: string[][] = [];
  for (const m of [...months].sort()) {
    const run = runs.at(-1);
    if (run && nextMonth(run.at(-1)!) === m) run.push(m);
    else runs.push([m]);
  }
  let change = 0;
  const counted: string[] = [];
  for (const run of runs) {
    const inRun = priced.filter((r) => r.date.slice(0, 7) >= run[0]! && r.date.slice(0, 7) <= run.at(-1)!);
    const first = inRun[0];
    const last = inRun.at(-1);
    if (!first || !last) continue;
    const open = Math.round((first.balance! - first.amount + first.fee) * 100) / 100;
    change += last.balance! - open;
    counted.push(...run);
  }
  if (counted.length === 0) return { drift: null, spanMonths: 0, counted };
  return { drift: change / counted.length, spanMonths: counted.length, counted };
}

/** The calendar month after `YYYY-MM`. */
const nextMonth = (m: string) => {
  const [y, mo] = m.split("-").map(Number) as [number, number];
  return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, "0")}`;
};

export function buildRules(
  written: ReturnType<typeof parseCategoryRules>,
  subs: ReturnType<typeof parseSubscriptions>,
  txns: ReturnType<typeof parseStatement>["rows"],
) {
  // One pinned rule per category the ledger declares. A row that names no
  // category falls into Subscriptions; a row that names one (Rent -> Home,
  // tuition -> Tuition) gets its own band, because burying €609 of housing in a
  // bucket named after Adobe hides the biggest number in the month.
  const descriptions = txns.map((t) => t.description);
  const grouped = new Map<string, string[]>();
  for (const sub of subs) {
    const cat = sub.category.trim() || COMMITTED_CATEGORY;
    // Filtered against the merchants actually on the statement, so a term like
    // "amsterdam" cannot claim every local shop.
    grouped.set(cat, [...(grouped.get(cat) ?? []), ...termsFor(sub, descriptions)]);
  }
  const pinned = [...grouped]
    .filter(([, matches]) => matches.length > 0)
    .map(([category, matches]) => ({
      category,
      matches,
      colour: written.find((r) => r.category.toLowerCase() === category.toLowerCase())?.colour ?? "purple",
      pinned: true,
    }));
  // Written rules are KEPT alongside the pinned ones, even for a category the
  // ledger also names. Dropping them threw away the merchants Jules wrote for
  // that category: the ledger's Bouldering membership replaced the written
  // Bouldering rule, so every gym visit fell into "Other". Pinned terms still
  // win their own transactions (score + 1000 in ruleFor).
  return [...written, ...pinned];
}

/**
 * The statement descriptors one ledger line answers to.
 *
 * An explicit `Match` column in the note wins outright — a hand-written
 * descriptor is a fact, and second-guessing it with the name-derived terms is
 * how "Rent" ends up claiming every merchant with "rent" in its name. Only when
 * the column is empty do we fall back to guessing from the service name, and
 * that guess is still filtered against the merchants actually on the file.
 */
function termsFor(
  item: { service: string; match: string[] },
  descriptions: string[],
): string[] {
  if (item.match.length > 0) return item.match;
  return usefulTerms(subscriptionTerms(item.service), descriptions);
}

/** What a transfer is filed as on the month page. Not a spending category —
 *  it exists so the list can label the rows the totals deliberately skip. */
const TRANSFER_CATEGORY = "Transfer";

/** Where a ledger line files when it names no category of its own. */
const COMMITTED_CATEGORY = "Subscriptions";

/**
 * The savings plan's categories, each split by what the transactions in it are.
 *
 * Only what a ledger (pinned) rule caught is committed — rent, tuition, Adobe,
 * the bouldering membership: "you pay this until you cancel it", so none of it
 * belongs in the plan's trimmable headroom. Everything else in the same
 * category is discretionary. It used to be decided per CATEGORY — any category
 * the ledger named was committed wholesale — which is only safe while the
 * ledger's category holds nothing but the ledger's own payments.
 *
 * Shared by the Finance tab and the Dashboard, so the two cannot quote
 * different savings targets from the same data.
 */
export function savingsCategories(names: string[], finished: CategoryMonthOf[]): { category: string; totals: number[]; committed: boolean }[] {
  const out: { category: string; totals: number[]; committed: boolean }[] = [];
  for (const category of names) {
    const fixed = finished.map((m) => m.committed?.[category] ?? 0);
    const free = finished.map((m, i) => Math.round(((m.byCategory[category] ?? 0) - fixed[i]!) * 100) / 100);
    if (fixed.some((v) => v !== 0)) out.push({ category, totals: fixed, committed: true });
    if (free.some((v) => v !== 0) || !fixed.some((v) => v !== 0)) out.push({ category, totals: free, committed: false });
  }
  return out;
}
type CategoryMonthOf = ReturnType<typeof monthlyByCategory>[number];

/**
 * The savings plan, as the Finance tab and the Dashboard both quote it. One
 * function, so the two screens cannot build its inputs differently — they
 * once did (a null drift on one side sent it down the payslip fallback) and
 * quoted two targets from one set of numbers.
 *
 * Money out is read from the same pocket as the balance it is set against:
 * the identity money in = money out + the balance change holds within one
 * account, and a Savings→Current withdrawal is not money that left (FIN-002).
 */
export function planSavings(
  txns: ReturnType<typeof parseStatement>["rows"],
  finished: CategoryMonthOf[],
  fallback: { payslipNet: number[]; ledgerIncome: number },
) {
  const outflow = new Map(outflowByMonth(inMainPocket(txns)).map((o) => [o.month, o.outflow]));
  const months = finished.map((m) => m.month);
  return savingsPlan({
    categories: savingsCategories(forecast(finished).map((f) => f.category), finished),
    months,
    spendMonths: finished.map((m) => m.total),
    // Everything that LEFT, transfers included — the identity money-in is
    // derived from. Spend alone understates it by every standing transfer.
    outflowMonths: finished.map((m) => outflow.get(m.month) ?? m.total),
    payslipNet: fallback.payslipNet,
    ledgerIncome: fallback.ledgerIncome,
    drift: savingsDrift(txns, months),
  });
}

const rowSchema = z.object({
  // Trimmed and length-capped: these land in a Markdown table a human reads.
  service: z.string().trim().min(1).max(80),
  amount: z.string().trim().min(1).max(24),
  cadence: z.enum(["weekly", "monthly", "quarterly", "yearly"]),
  // Either a date or nothing; anything else would sit in the table as noise the
  // parser silently drops, which reads as "the app lost my entry".
  next: z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.literal("")]).default(""),
  note: z.string().trim().max(140).default(""),
});

export async function financeRoutes(app: FastifyInstance, _db: Db, store: VaultStore) {
  const auth = { preHandler: [app.authenticate] };

  app.post<{ Params: { kind: string } }>("/api/finance/:kind", auth, async (req) => {
    const kind = req.params.kind;
    if (kind !== "income" && kind !== "subscriptions") throw new HttpError(404, "unknown ledger");
    const row = rowSchema.parse(req.body ?? {});
    const user = store.aclUser(req.userId);

    const note = financeNote(store, user, kind);
    if (!note) throw new HttpError(404, `no note tagged #${FINANCE_TAG[kind]}`);

    const next = appendMoneyRow(note.content, { ...row, service: row.service, note: row.note });
    if (next === null) throw new HttpError(422, `${note.path} has no table with Name and Amount columns`);

    // Written through the store, so the ACL decides and the id is preserved.
    const saved = store.write(user, note.path, next);
    return { ok: true, noteId: saved.id, path: saved.path };
  });

  /** Everything the Finance tab shows, in one call. */
  app.get("/api/finance", auth, async (req) => {
    const user = store.aclUser(req.userId);
    const today = isoLocal();

    const subsNote = financeNote(store, user, "subscriptions");
    const incomeNote = financeNote(store, user, "income");
    const slipNote = store.readable(user).find((n) => n.tags.some((t) => t.tag === "payslips"));
    const areaNote = store.readable(user).find((n) => n.tags.some((t) => t.tag === "finance"));

    const subscriptions = subsNote ? parseSubscriptions(subsNote.content, today) : [];
    const income = incomeNote ? parseSubscriptions(incomeNote.content, today) : [];
    const payslips = slipNote ? parsePayslipTable(slipNote.content) : [];

    const sum = (t: { monthly: number }[]) => t.reduce((a, b) => a + b.monthly, 0);
    const inPerMonth = sum(monthlyTotals(income));
    const outPerMonth = sum(monthlyTotals(subscriptions));
    const net = Math.round((inPerMonth - outPerMonth) * 100) / 100;

    // Statements, merged and de-duplicated by loadTxns. Balances are still read
    // per file: a balance is a property of the export, not of a row.
    const { txns, complete } = statementsFor(store, user);
    const filesReadable = canReadFinanceFiles(store, user);
    const { balance, balanceDate, skipped } = filesReadable
      ? balanceSpan(store.vaultRoot)
      : { balance: null, balanceDate: null, skipped: 0 };

    // Categories are a note, so the grouping is the user's to change.
    const rulesNote = store.readable(user).find((n) => n.tags.some((t) => t.tag === "spending-categories"));
    const writtenRules = rulesNote ? parseCategoryRules(rulesNote.content) : [];

    const rules = buildRules(writtenRules, subscriptions, txns);
    const catMonths = monthlyByCategory(txns, rules);

    /**
     * Each month's movements, re-aggregated over the merged set. `spend` is
     * the category month's total — costOf, through monthlyByCategory — and
     * nothing else. This series once kept its own formula (card and ATM rows
     * plus fees), so the hero's "Spent in October" left out the rent the rules
     * note claims as a transfer and counted returned purchases in full: €100
     * on the hero against €709 on the month page and the Dashboard (audit
     * FIN-001). One quantity, one function.
     */
    const spentIn = new Map(catMonths.map((m) => [m.month, m.total]));
    const monthsMap = new Map<string, { month: string; fees: number; refunds: number; movedIn: number; movedOut: number }>();
    for (const r of txns) {
      const k = r.date.slice(0, 7);
      const m = monthsMap.get(k) ?? { month: k, fees: 0, refunds: 0, movedIn: 0, movedOut: 0 };
      m.fees += r.fee;
      if (r.flow === "refund" && r.amount > 0) m.refunds += r.amount;
      else if (r.flow === "moved") r.amount > 0 ? (m.movedIn += r.amount) : (m.movedOut += -r.amount);
      monthsMap.set(k, m);
    }
    const r2 = (n: number) => Math.round(n * 100) / 100;
    const months = [...monthsMap.values()]
      .map((m) => ({ month: m.month, spend: spentIn.get(m.month) ?? 0, fees: r2(m.fees), refunds: r2(m.refunds), movedIn: r2(m.movedIn), movedOut: r2(m.movedOut) }))
      .sort((a, b) => a.month.localeCompare(b.month));

    // Forecast from finished months only — the export stops mid-month and that
    // partial month would drag every category's expectation down — and from
    // the last TYPICAL_WINDOW of them: "typical" means now, not a median
    // across every year on record.
    const finished = recentMonths(completeMonths(catMonths, complete));
    const outlook = forecast(finished);
    const windowed = new Set(finished.map((m) => m.month));
    const merchants = merchantsByCategory(txns.filter((r) => windowed.has(r.date.slice(0, 7))), rules);
    const { spanMonths, drift } = balanceTrend(txns, finished.map((m) => m.month));

    // Runway needs a balance, and nothing in the vault knows one unless it is
    // written down — so it is read from the finance note's front-matter and
    // simply absent until then. Inventing it from income would be a lie.
    // The statement's own last balance beats anything typed by hand — it is the
    // bank's arithmetic, and it cannot go stale the way front-matter does.
    const rawBalance = (areaNote?.frontmatter as Record<string, unknown> | undefined)?.["balance"];
    const written = typeof rawBalance === "number" ? rawBalance : Number.parseFloat(String(rawBalance ?? ""));
    const effectiveBalance = balance ?? (Number.isFinite(written) ? written : null);
    const haveBalance = effectiveBalance !== null;

    /**
     * Burn comes from the STATEMENT'S OWN BALANCE TREND, not from combining the
     * ledgers with card spending.
     *
     * The obvious formula — average card spend minus the ledgers' net — double
     * counts badly: Adobe, the Metal plan and the university are charged to the
     * very card whose spending is being added, so they are subtracted once as
     * recurring outgoings and added straight back as card transactions. On the
     * real file that produced a burn of €26.69/month and a runway of 131 months,
     * which is not a number anyone should act on.
     *
     * The balances the bank printed on the first and last settled rows cannot
     * disagree with each other. The slope between them is what the account is
     * actually doing, whatever the ledgers claim.
     */
    const burn = drift === null ? null : Math.round(-drift * 100) / 100;
    // Only a shrinking balance has a runway. A growing one is said plainly
    // rather than dressed up as a very large number of months.
    const runwayMonths = haveBalance && burn !== null && burn > 0 ? Math.round((effectiveBalance! / burn) * 10) / 10 : null;

    /**
     * How long each ledger line has actually been charging, read off the
     * statement rather than typed into the note. "Netflix, €15.99" is a price;
     * "Netflix, €15.99, every month since January, €112 so far" is a decision
     * you can make. Matched with the same term extraction that files a
     * transaction under Subscriptions, so the two views agree.
     */
    const descriptions = txns.map((t) => t.description);

    /**
     * How long each ledger line has actually been running, read off the
     * statement rather than typed into the note. "Netflix, €15.99" is a price;
     * "Netflix, €15.99, every month since January, €112 so far" is a decision
     * you can make.
     *
     * DIRECTION is not decoration. A subscription is money leaving and income
     * is money arriving, and the same counterparty can be both: a parent
     * sends €<amount> a month and he occasionally sends her something back, so the
     * statement holds "PAYMENT FROM <NAME>" and "TRANSFER TO <NAME>
     * JANE ASH" under one ledger row. Summing without regard to direction gave
     * every income line a total of €0.00 (income is positive, and the old sum
     * only counted negatives), and picking the biggest descriptor sent her card
     * to the money he had sent HER. So each side counts only its own direction.
     */
    const activityFor = (items: typeof subscriptions, direction: "in" | "out") =>
      Object.fromEntries(
        items.map((item) => {
          const terms = termsFor(item, descriptions);
          const hits = terms.length
            ? txns.filter((t) => {
                const d = t.description.toLowerCase();
                if (!terms.some((term) => d.includes(term))) return false;
                return direction === "in" ? t.amount > 0 : t.amount < 0 || t.fee > 0;
              })
            : [];
          const value = (t: (typeof txns)[number]) =>
            direction === "in" ? t.amount : (t.amount < 0 ? -t.amount : 0) + t.fee;
          const months = [...new Set(hits.map((h) => h.date.slice(0, 7)))].sort();
          /**
           * The statement descriptors this line answers to, biggest first. A
           * ledger row is named by the user ("Boulder gym — Zuidhaven") and the
           * bank names the same thing something else entirely ("Buckaroo
           * Stichting Derdengelden"); without carrying the bank's name back, a
           * card cannot open the transactions behind it.
           */
          const byMerchant = new Map<string, number>();
          for (const h of hits) {
            const name = h.description.trim().replace(/\s+/g, " ").toUpperCase();
            byMerchant.set(name, (byMerchant.get(name) ?? 0) + value(h));
          }
          return [
            item.service,
            {
              charges: hits.length,
              months: months.length,
              first: months[0] ?? null,
              last: months[months.length - 1] ?? null,
              /** What it has moved in total, in its own direction. */
              total: Math.round(hits.reduce((a, h) => a + value(h), 0) * 100) / 100,
              /** Which months it was seen in, so a card can draw its run. */
              seen: months,
              merchants: [...byMerchant].sort((a, b) => b[1] - a[1]).map(([name]) => name),
            },
          ];
        }),
      );

    /**
     * Charges that repeat at a fixed amount but are in no ledger.
     *
     * This is how a subscription gets FOUND rather than remembered: a gym
     * membership taken by direct debit under a payment processor's name
     * ("Buckaroo Stichting Derdengelden") looks like nothing at all until you
     * notice the same €56.70 landing every month. Anything a ledger line
     * already matches is filtered out — that is the ledger working, not a
     * discovery.
     */
    const claimed = [...subscriptions, ...income].flatMap((item) => termsFor(item, descriptions));
    const recurring = unclaimedRecurring(
      findRecurring(txns, { dataThrough: txns.length ? txns[txns.length - 1]!.date : "" }),
      claimed,
    );

    /**
     * The savings plan. Categories come in with their complete-month history so
     * core can quantile them; Subscriptions is flagged committed because no
     * in-month decision changes it. See packages/core/src/savings.ts for the
     * model — it is deliberately derived from Jules's own months rather than
     * from a rule of thumb.
     */
    const savings = planSavings(txns, finished, {
      payslipNet: payslips.map((r) => r.net).filter((n): n is number => n !== null),
      ledgerIncome: inPerMonth,
    });

    let files: { name: string; size: number; mtimeMs: number; ext: string }[] = [];
    const dir = filesDir(store.vaultRoot);
    if (filesReadable && fs.existsSync(dir)) {
      files = fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile() && !e.name.startsWith("."))
        .map((e) => {
          const st = fs.statSync(path.join(dir, e.name));
          return { name: e.name, size: st.size, mtimeMs: st.mtimeMs, ext: path.extname(e.name).toLowerCase() };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
    }

    return {
      notes: {
        income: incomeNote?.id ?? null,
        subscriptions: subsNote?.id ?? null,
        payslips: slipNote?.id ?? null,
        area: areaNote?.id ?? null,
      },
      income: {
        totals: monthlyTotals(income),
        items: income,
        count: income.length,
        activity: activityFor(income, "in"),
      },
      subscriptions: {
        totals: monthlyTotals(subscriptions),
        items: subscriptions,
        count: subscriptions.length,
        activity: activityFor(subscriptions, "out"),
      },
      payslips,
      savings,
      recurring,
      summary: {
        inPerMonth: Math.round(inPerMonth * 100) / 100,
        outPerMonth: Math.round(outPerMonth * 100) / 100,
        net,
        balance: effectiveBalance,
        balanceDate,
        runwayMonths,
        burn,
        /** Positive when the balance is growing — surfaced, not hidden. */
        drift: drift === null ? null : Math.round(drift * 100) / 100,
        spanMonths: Math.round(spanMonths * 10) / 10,
      },
      spending: {
        months,
        /** Date of the last settled transaction: how far the data reaches, which
         *  is what "this month so far" has to be measured against. */
        dataThrough: txns.length ? txns[txns.length - 1]!.date : null,
        categories: {
          noteId: rulesNote?.id ?? null,
          rules: rules.map((r) => ({ category: r.category, colour: r.colour })),
          months: catMonths,
          forecast: outlook.map((f) => ({ ...f, merchants: merchants[f.category] ?? [] })),
          /**
           * A typical month, computed HERE rather than summed from `forecast`
           * in the client. The web app used to add up each category's median,
           * which is not any month that happened and disagreed with the month
           * page by 14% on the real statement (audit).
           */
          typical: typicalMonth(finished),
          completeMonths: finished.length,
          /** Last month the statement covers in full — anything after it is a
           *  part-month and must not be compared against the others. */
          lastComplete: finished.length ? finished[finished.length - 1]!.month : null,
        },
        txnCount: txns.length,
        skipped,
      },
      files,
    };
  });

  /**
   * One category in detail: its month-by-month series and the merchants behind
   * it, optionally narrowed to a year.
   *
   * Its own endpoint rather than a fatter /api/finance, because the overview
   * needs none of this and would carry it on every dashboard load.
   */
  app.get<{ Params: { name: string }; Querystring: { year?: string } }>(
    "/api/finance/category/:name",
    auth,
    async (req) => {
      const user = store.aclUser(req.userId);
      const today = isoLocal();
      const wanted = decodeURIComponent(req.params.name);

      const subsNote = financeNote(store, user, "subscriptions");
      const subscriptions = subsNote ? parseSubscriptions(subsNote.content, today) : [];
      const rulesNote = store.readable(user).find((n) => n.tags.some((t) => t.tag === "spending-categories"));
      const writtenRules = rulesNote ? parseCategoryRules(rulesNote.content) : [];

      const { txns, complete } = statementsFor(store, user);
      const covered = new Set(complete);

      const rules = buildRules(writtenRules, subscriptions, txns);

      // The rows that cost something in this category. Filed by description
      // alone, "Other" counted every salary and top-up as one of its
      // transactions and months, and a purchase returned in full kept its
      // category "active" at €0 (audit FIN-009).
      const mine = txns.filter((r) => categoryOfRow(r.description, rules) === wanted && costOf(r, rules) > 0);
      const years = [...new Set(mine.map((r) => r.date.slice(0, 4)))].sort().reverse();
      const year = req.query.year && years.includes(req.query.year) ? req.query.year : years[0];
      const inYear = year ? mine.filter((r) => r.date.startsWith(year)) : [];

      // How far the statements actually reach, which is not the same as how far
      // the year does. Beyond this there is no data — as opposed to a month in
      // which nothing was spent — and the two must not draw the same.
      const lastTxn = txns.length ? txns[txns.length - 1]!.date : "";
      const dataThrough = lastTxn.slice(0, 7);
      const firstTxn = txns.length ? txns[0]!.date : "";

      // Every month of the chosen year, so a gap reads as a month with no
      // spending rather than the line skipping over it.
      const series = Array.from({ length: 12 }, (_, i) => {
        const month = `${year}-${String(i + 1).padStart(2, "0")}`;
        const rows = inYear.filter((r) => r.date.startsWith(month));
        const total = rows.reduce((a, r) => a + costOf(r, rules), 0);
        return {
          month,
          total: Math.round(total * 100) / 100,
          count: rows.length,
          hasData: rows.length > 0,
          /** No statement covers this month at all. */
          future: dataThrough !== "" && month > dataThrough,
          /** Inside the statements' range, but not covered from its first
           *  day to its last: where they start or stop, or beside a gap. */
          partial: dataThrough !== "" && month >= firstTxn.slice(0, 7) && month <= dataThrough && !covered.has(month),
        };
      });

      // Every year the statements reach, for the chart's "Year" view: a year
      // with none of this category reads as zero, not as missing, and a year
      // the statements only partly cover says so.
      const yearly: { year: string; total: number; count: number; partial: boolean }[] = [];
      if (firstTxn && lastTxn) {
        for (let y = Number(firstTxn.slice(0, 4)); y <= Number(lastTxn.slice(0, 4)); y++) {
          const rows = mine.filter((r) => r.date.startsWith(`${y}-`));
          yearly.push({
            year: String(y),
            total: Math.round(rows.reduce((a, r) => a + costOf(r, rules), 0) * 100) / 100,
            count: rows.length,
            partial: Array.from({ length: 12 }, (_, i) => `${y}-${String(i + 1).padStart(2, "0")}`).some((m) => !covered.has(m)),
          });
        }
      }

      const merchants = merchantsByCategory(inYear, rules, 20)[wanted] ?? [];
      // Stats over whole months only: a part-month would understate the low
      // and the average alike. The average is computed here, beside the
      // count of months it is over, so the label and the division cannot
      // drift apart again — the page averaged in the part-month itself.
      const spent = series.filter((m) => m.hasData && !m.partial).map((m) => m.total);
      const colour = rules.find((r) => r.category === wanted)?.colour ?? null;

      return {
        category: wanted,
        colour,
        years,
        year: year ?? null,
        series,
        yearly,
        merchants,
        stats: {
          total: Math.round(inYear.reduce((a, r) => a + costOf(r, rules), 0) * 100) / 100,
          count: inYear.length,
          activeMonths: spent.length,
          /** Mean of the complete months with spending — "over activeMonths months". */
          average: spent.length ? Math.round((spent.reduce((a, v) => a + v, 0) / spent.length) * 100) / 100 : 0,
          high: spent.length ? Math.max(...spent) : 0,
          low: spent.length ? Math.min(...spent) : 0,
        },
      };
    },
  );

  /**
   * One month in full: every transaction in it, what each category cost, and
   * how that compares with a typical month.
   *
   * This is what a column of the spending chart, or a point on a category line,
   * actually opens. Without it the charts are read-only pictures; with it every
   * bar is a door, which is the whole point of the app.
   */
  app.get<{ Params: { month: string }; Querystring: { category?: string } }>(
    "/api/finance/month/:month",
    auth,
    async (req) => {
      const user = store.aclUser(req.userId);
      const today = isoLocal();
      const month = req.params.month;
      if (!/^\d{4}-\d{2}$/.test(month)) throw new HttpError(400, "month must be YYYY-MM");

      const subsNote = financeNote(store, user, "subscriptions");
      const subscriptions = subsNote ? parseSubscriptions(subsNote.content, today) : [];
      const rulesNote = store.readable(user).find((n) => n.tags.some((t) => t.tag === "spending-categories"));
      const { txns, complete: covered } = statementsFor(store, user);
      const rules = buildRules(rulesNote ? parseCategoryRules(rulesNote.content) : [], subscriptions, txns);

      const catMonths = monthlyByCategory(txns, rules);
      const finished = completeMonths(catMonths, covered);

      const wanted = req.query.category?.trim() || null;
      const inMonth = txns
        .filter((r) => r.date.startsWith(month))
        .filter((r) => (wanted ? categoryOfRow(r.description, rules) === wanted : true))
        .sort((a, b) => b.date.localeCompare(a.date) || b.amount - a.amount);

      /**
       * Spending, defined exactly as the charts define it: a card payment or an
       * ATM withdrawal, plus any fee. NOT transfers.
       *
       * Counting every negative amount is what made this page disagree with the
       * chart that opened it — May read €1,975 here against €1,000 on the
       * Spending page, because €590 of rent left as a transfer to a housing
       * association and landed in "Other". Transfers are still reported, under
       * their own heading, because they are money leaving; they are simply not
       * the same question as "what did I spend".
       */
      // The one definition, shared with the charts: a card payment, or a
      // transfer the rules note has claimed. See costOf in core/spending.ts.
      const cost = (r: (typeof txns)[number]) => costOf(r, rules);
      // A transfer the rules did NOT claim: money that left without being
      // spent, reported separately so nothing is silently dropped.
      const isMoved = (r: (typeof txns)[number]) =>
        (r.flow === "moved" || r.flow === "other") && costOf(r, rules) <= 0;
      const r2 = (n: number) => Math.round(n * 100) / 100;

      // Per category, this month against the median of the complete months —
      // the comparison is the reason to open a month at all.
      const byCategory = new Map<string, { total: number; count: number }>();
      for (const r of inMonth) {
        if (cost(r) <= 0) continue;
        const cat = categoryOfRow(r.description, rules);
        const at = byCategory.get(cat) ?? { total: 0, count: 0 };
        at.total += cost(r);
        at.count += 1;
        byCategory.set(cat, at);
      }
      /**
       * The complete months this one is being compared against — itself
       * excluded, because a month is not evidence for what is typical of it.
       * Both comparisons on this page (the header and each category row) read
       * from here through the one `typicalMonth` in core.
       *
       * No three-month floor here, unlike the overview's headline. The two are
       * different claims: "a typical month costs €X" is an assertion about the
       * data and wants evidence behind it, while "this month against the
       * others" is a comparison that simply gets weaker with fewer months. The
       * floor also contradicts a release-blocking test — the category
       * comparison at finance.test.ts has three complete months, so excluding
       * the one being read leaves two.
       */
      // The months around this one, not every month on record (see monthsAround).
      const others = monthsAround(finished, month);
      const typicalOther = (category: string | null) => typicalMonth(others, category, 1) ?? 0;

      const categories = [...byCategory]
        .map(([category, v]) => ({
          category,
          total: r2(v.total),
          count: v.count,
          // The rules note's own colour, so a category is the same colour here
          // as on every other page. Re-deriving it client-side from a hash gave
          // Shopping a different colour on this page than on the chart it was
          // opened from, which reads as two different categories.
          colour: rules.find((r) => r.category === category)?.colour ?? null,
          typical: typicalOther(category),
        }))
        .sort((a, b) => b.total - a.total);

      const total = r2(inMonth.reduce((a, r) => a + cost(r), 0));
      // Money that left without being spent, and money that came back. Both are
      // stated rather than folded into the headline, which is about spending.
      const movedOut = r2(inMonth.filter((r) => isMoved(r) && r.amount < 0).reduce((a, r) => a + -r.amount, 0));
      const movedIn = r2(inMonth.filter((r) => isMoved(r) && r.amount > 0).reduce((a, r) => a + r.amount, 0));
      const refunded = r2(inMonth.filter((r) => r.flow === "refund" && r.amount > 0).reduce((a, r) => a + r.amount, 0));
      const complete = finished.some((f) => f.month === month);
      const months = catMonths.map((m) => m.month);

      return {
        month,
        category: wanted,
        /** Is this month finished, or is the statement still inside it? */
        complete,
        total,
        movedOut,
        movedIn,
        refunded,
        count: inMonth.filter((r) => cost(r) > 0).length,
        transferCount: inMonth.filter(isMoved).length,
        /**
         * A typical complete month, for the header comparison — like for like:
         * filtered to a category, "a typical month" means a typical month OF
         * THAT CATEGORY. Comparing one category's month against the whole
         * month's median is how €250 of shopping reads as €740 under a typical
         * €1,000.
         */
        typical: typicalOther(wanted),
        categories,
        /** Neighbours, so the page can step month to month without going back. */
        prev: months.filter((m) => m < month).pop() ?? null,
        next: months.find((m) => m > month) ?? null,
        transactions: inMonth.map((r) => ({
          date: r.date,
          description: r.description,
          // A transfer keeps its real size; it is simply not counted as spend.
          amount: r2(isMoved(r) || r.flow === "refund" ? Math.abs(r.amount) : cost(r)),
          refund: r.flow === "refund" || (r.amount > 0 && !isMoved(r)),
          moved: isMoved(r),
          type: r.type,
          balance: r.balance,
          category: isMoved(r) ? TRANSFER_CATEGORY : categoryOfRow(r.description, rules),
        })),
      };
    },
  );

  /**
   * One merchant: every transaction with it, newest first, grouped by the
   * client into months. The end of the drill-down — category, then merchant,
   * then the actual line items, which is where a number stops being a summary
   * and becomes something you remember doing.
   */
  app.get<{ Params: { name: string }; Querystring: { year?: string } }>(
    "/api/finance/merchant/:name",
    auth,
    async (req) => {
      const user = store.aclUser(req.userId);
      const wanted = decodeURIComponent(req.params.name).trim().toUpperCase();

      const txns = txnsFor(store, user);

      // Matched on the same normalisation the merchant lists are built with, so
      // what you clicked is exactly what comes back.
      const norm = (v: string) => v.trim().replace(/\s+/g, " ").toUpperCase();
      const mine = txns.filter((r) => norm(r.description) === wanted);
      const years = [...new Set(mine.map((r) => r.date.slice(0, 4)))].sort().reverse();
      const year = req.query.year && years.includes(req.query.year) ? req.query.year : years[0];
      const inYear = (year ? mine.filter((r) => r.date.startsWith(year)) : []).sort((a, b) =>
        b.date.localeCompare(a.date),
      );

      /**
       * A merchant is not always somewhere you spend.
       *
       * "PAYMENT FROM <NAME>" is €300 arriving nine times; scoring it
       * with the outgoing rule (negatives only) gave a page of €0.00 rows under
       * a €0.00 total, which is the same direction bug the ledger cards had.
       * So the page works out which way the money mostly goes and reports THAT
       * side — while every row keeps its own true size and sign.
       */
      // A purchase counts what it ended up costing: settleRefunds has already
      // taken each refund off the purchase it refunds, so the refund row itself
      // is neither money out nor money in here. Counting both — the purchase
      // in full and the refund as "in" — put €100 on the merchant page for a
      // €100 purchase with €40 returned, against €60 on the category page and
      // the month page that opened it (audit FIN-001).
      const out = (r: (typeof txns)[number]) => (r.amount < 0 ? -r.amount - (r.refunded ?? 0) : 0) + r.fee;
      const inn = (r: (typeof txns)[number]) => (r.amount > 0 && r.flow !== "refund" ? r.amount : 0);
      const outTotal = inYear.reduce((a, r) => a + out(r), 0);
      const inTotal = inYear.reduce((a, r) => a + inn(r), 0);
      const direction: "in" | "out" = inTotal > outTotal ? "in" : "out";
      const value = direction === "in" ? inn : out;

      const amounts = inYear.map(value).filter((n) => n > 0);
      const total = amounts.reduce((a, b) => a + b, 0);
      /**
       * For money ARRIVING the typical payment is the median, not the mean.
       * DUO pays €324.52 most months and occasionally settles a backlog; the
       * mean of that is €588, a figure that has never once landed and never
       * will. The median is what you can count on. Spending keeps the mean,
       * where a total spread over a count is the useful reading.
       */
      const median = (xs: number[]) => {
        if (xs.length === 0) return 0;
        const t = [...xs].sort((a, b) => a - b);
        const mid = Math.floor(t.length / 2);
        return t.length % 2 ? t[mid]! : (t[mid - 1]! + t[mid]!) / 2;
      };
      const byMonth = new Map<string, number>();
      for (const r of inYear) byMonth.set(r.date.slice(0, 7), (byMonth.get(r.date.slice(0, 7)) ?? 0) + value(r));

      const r2 = (n: number) => Math.round(n * 100) / 100;
      return {
        merchant: wanted,
        years,
        year: year ?? null,
        /** Which way the money mostly goes here, so the page can say so. */
        direction,
        transactions: inYear.map((r) => ({
          date: r.date,
          // Its real size, whichever way it went.
          amount: r2(Math.abs(r.amount) + r.fee),
          // A refund, or money arriving, shows as what it was.
          refund: r.flow === "refund" || r.amount > 0,
          type: r.type,
          balance: r.balance,
        })),
        months: [...byMonth].map(([month, sum]) => ({ month, total: r2(sum) })).sort((a, b) => a.month.localeCompare(b.month)),
        stats: {
          total: r2(total),
          count: inYear.length,
          average: amounts.length ? r2(direction === "in" ? median(amounts) : total / amounts.length) : 0,
          biggest: amounts.length ? r2(Math.max(...amounts)) : 0,
          first: inYear.length ? inYear[inYear.length - 1]!.date : null,
          last: inYear.length ? inYear[0]!.date : null,
          allTime: r2(mine.reduce((a, r) => a + value(r), 0)),
        },
      };
    },
  );

  /**
   * Upload a payslip: store the PDF, read its text, file the figures as a row.
   * The document is kept whatever happens — a payslip we could not parse is
   * still a payslip worth having, and the response says which case it was so
   * the UI can ask for the numbers by hand.
   */
  app.post("/api/finance/payslip", { ...auth, bodyLimit: MAX_UPLOAD + 2 * 1024 * 1024 }, async (req) => {
    const user = store.aclUser(req.userId);
    requireFinanceFiles(store, user, true);
    const body = (req.body ?? {}) as { name?: string; dataBase64?: string };
    const name = safeUploadName(body.name);
    const data = Buffer.from(String(body.dataBase64 ?? ""), "base64");
    if (data.length === 0) throw new HttpError(400, "empty file");
    if (data.length > MAX_UPLOAD) throw new HttpError(413, "file too large (15 MB max)");

    const dir = filesDir(store.vaultRoot);
    fs.mkdirSync(dir, { recursive: true });
    const abs = path.join(dir, name);
    if (path.dirname(abs) !== dir) throw new HttpError(400, "invalid filename");
    writeFileAtomic(abs, data);

    if (!name.toLowerCase().endsWith(".pdf")) return { ok: true, name, parsed: null, filed: false };

    let parsed = null;
    try {
      const doc = await getDocumentProxy(new Uint8Array(data));
      const { text } = await extractText(doc, { mergePages: true });
      parsed = parsePayslip(text);
    } catch {
      return { ok: true, name, parsed: null, filed: false, reason: "could not read the PDF's text" };
    }
    if (!payslipUsable(parsed)) return { ok: true, name, parsed, filed: false, reason: "unfamiliar payslip layout" };

    const slipNote = store.readable(user).find((n) => n.tags.some((t) => t.tag === "payslips"));
    if (!slipNote) return { ok: true, name, parsed, filed: false, reason: "no note tagged #payslips" };
    // Re-filing the same month would double-count it in every average.
    if (parsePayslipTable(slipNote.content).some((r) => r.month === parsed!.month))
      return { ok: true, name, parsed, filed: false, reason: `${parsed.month} is already filed` };

    const next = appendPayslipRow(slipNote.content, parsed, name);
    if (next === null) return { ok: true, name, parsed, filed: false, reason: "the payslips note has no table" };
    store.write(user, slipNote.path, next);
    return { ok: true, name, parsed, filed: true };
  });

  /**
   * A stored .xlsx as rows, so a Revolut export can be read inside the app the
   * way a project document can. The parsing happens here, not in the browser:
   * a workbook parser has no business in the web bundle, and the same reasoning
   * (and the same caps) already governs /api/projects/:slug/files/:name/sheet.
   */
  app.get<{ Params: { name: string } }>("/api/finance/files/:name/sheet", auth, async (req) => {
    requireFinanceFiles(store, store.aclUser(req.userId));
    const name = safeUploadName(req.params.name);
    if (!/\.xlsx$/i.test(name)) throw new HttpError(400, "only .xlsx converts to rows");
    const dir = filesDir(store.vaultRoot);
    const abs = path.join(dir, name);
    if (path.dirname(abs) !== dir || !fs.existsSync(abs)) throw new HttpError(404, "not found");

    const { default: ExcelJS } = await import("exceljs");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(abs);

    const cell = (v: unknown): string => {
      if (v === null || v === undefined) return "";
      if (v instanceof Date) return v.toISOString().slice(0, 10);
      if (typeof v === "object") {
        const o = v as { result?: unknown; text?: unknown; richText?: { text: string }[]; hyperlink?: string };
        if (o.richText) return o.richText.map((r) => r.text).join("");
        if (o.result !== undefined) return cell(o.result);
        if (o.text !== undefined) return String(o.text);
        if (o.hyperlink) return String(o.hyperlink);
        return "";
      }
      return String(v);
    };

    const sheets = wb.worksheets.slice(0, MAX_SHEETS).map((ws) => {
      const rows: string[][] = [];
      let truncated = false;
      ws.eachRow({ includeEmpty: false }, (row, n) => {
        if (n > MAX_SHEET_ROWS) {
          truncated = true;
          return;
        }
        // `row.values` is 1-based AND sparse: `.map` skips the holes, which then
        // serialise as nulls and reach the client as non-strings. Build it dense.
        const values = Array.isArray(row.values) ? row.values : [];
        const width = Math.min(Math.max(values.length - 1, 0), MAX_SHEET_COLS);
        rows.push(Array.from({ length: width }, (_, i) => cell(values[i + 1])));
      });
      const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
      return {
        name: ws.name,
        rows: rows.map((r) => [...r, ...Array(Math.max(0, width - r.length)).fill("")]),
        truncated: truncated || ws.actualColumnCount > MAX_SHEET_COLS,
        totalRows: ws.actualRowCount,
      };
    });
    return { sheets, sheetCount: wb.worksheets.length };
  });

  /** Serve a stored document. Never inline: a downloaded attachment only. */
  app.get<{ Params: { name: string } }>("/api/finance/files/:name", auth, async (req, reply) => {
    requireFinanceFiles(store, store.aclUser(req.userId));
    const name = safeUploadName(req.params.name);
    const abs = path.join(filesDir(store.vaultRoot), name);
    if (path.dirname(abs) !== filesDir(store.vaultRoot) || !fs.existsSync(abs)) throw new HttpError(404, "not found");
    const type = name.toLowerCase().endsWith(".pdf")
      ? "application/pdf"
      : name.toLowerCase().endsWith(".xlsx")
        ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        : "text/csv";
    return reply
      .header("content-type", type)
      .header("content-disposition", `attachment; filename="${name.replace(/"/g, "")}"`)
      .send(fs.createReadStream(abs));
  });
}
