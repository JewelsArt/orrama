/**
 * Money's writes: a row of a ledger added, changed, removed or moved, and a shop put in a
 * category (routes/finance.ts). The ledgers stay tables in notes; the server re-reads the note,
 * changes that one row with core's writer and saves it through the store. A row is named as the
 * screen saw it, by its index, its name and the version of the table it was read at, so a table
 * changed elsewhere since is refused (409) rather than changed in the wrong place.
 */
import type { FinanceData, LedgerRowData, LedgerTableData } from "@orrama/schema/responses";
import { CADENCES, type Cadence } from "@orrama/core/subscriptions";
import { api } from "../api.js";

export type LedgerId = keyof FinanceData["tables"];

/** A row as it was read: the table it is in, and the row. */
export interface RowAt {
  table: LedgerTableData;
  row: LedgerRowData;
}

const ref = (at: RowAt) => ({ version: at.table.version, name: at.row.name });

export const addRow = (id: LedgerId, body: Record<string, unknown>) => api<{ ok: true; noteId: string; path: string }>("POST", `/api/finance/${id}`, body);
export const changeRow = (id: LedgerId, at: RowAt, set: Record<string, string>) => api("PATCH", `/api/finance/${id}/${at.row.index}`, { ...ref(at), set });
export const removeRow = (id: LedgerId, at: RowAt) => api("DELETE", `/api/finance/${id}/${at.row.index}`, ref(at));
/** Move a category to where category `to` is (its index). */
export const moveCategory = (at: RowAt, to: number) => api("POST", `/api/finance/categories/${at.row.index}/move`, { ...ref(at), to });
/** Every row of a shop into a category; the answer says where they were. */
export const fileShop = (merchant: string, category: string) => api<{ from: string; to: string; term: string }>("POST", "/api/finance/categories/shop", { merchant, category });

/** The row of a table that is on line `line` of its note. */
export function rowAt(table: LedgerTableData | null, line: number | undefined): RowAt | null {
  const row = table && line !== undefined ? table.rows.find((r) => r.line === line) : undefined;
  return table && row ? { table, row } : null;
}

/** Only what was changed: a cell left as it was is not sent, so it stays exactly as written. */
export const changedCells = (before: Record<string, string>, after: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(after).filter(([k, v]) => (before[k] ?? "") !== v));

/** How each cadence reads on a screen; the ledger keeps the word on the left. */
export const CADENCE_WORDS: Record<Cadence, string> = {
  weekly: "every week",
  biweekly: "every 2 weeks",
  "4-weekly": "every 4 weeks",
  monthly: "every month",
  "2-monthly": "every 2 months",
  quarterly: "every 3 months",
  "half-yearly": "every 6 months",
  yearly: "every year",
};
export { CADENCES };

/** What a page asks Money to open for a change; Money.tsx draws it over the page. */
export type EditReq =
  | { kind: "line"; ledger: "subscriptions" | "income"; line?: number; prefill?: Partial<{ service: string; amount: string; cadence: Cadence; next: string; note: string }>; shop?: string | null }
  | { kind: "categories"; focus?: string }
  | { kind: "payslip"; line?: number; month?: string | null; file?: string | null }
  | { kind: "account"; line?: number }
  | { kind: "shop"; shop: string; current: string };
