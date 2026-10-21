/**
 * Reading and writing the Markdown tables the vault keeps ledgers in.
 *
 * Every table here is hand-editable in Obsidian, so nothing may depend on the
 * order or the exact spelling of its columns: a header is matched by NAME
 * through a synonym map, and a row is written back in whatever order that
 * table's own header declares. Rearranging columns by hand therefore cannot
 * turn a price into a date, and adding a column of your own is harmless.
 */
import { noteLines, spliceNoteLines } from "./parse.js";

/**
 * Split a `| a | b |` row into trimmed cells, dropping the outer pipes. An
 * escaped pipe `\|` is part of its cell, as in Obsidian: a link written in a
 * table is `[[Note\|alias]]`, and splitting there cut one cell in two (COR-015).
 */
export const cells = (row: string): string[] =>
  row
    .replace(/^\s*\|/, "")
    .replace(/(?<!\\)\|\s*$/, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim());

/** `|---|:--:|` — the rule under a header, not data. */
export const isRule = (row: string[]): boolean => row.every((c) => /^:?-{2,}:?$/.test(c));

const normalise = (h: string) => h.toLowerCase().replace(/[^a-z ]/g, "").trim();

/** Map a header row onto canonical field names; "" for columns we do not know. */
export const mapHeader = (row: string[], headers: Record<string, string>): string[] =>
  row.map((c) => headers[normalise(c)] ?? "");

/**
 * Locate the first table whose header carries every required field.
 * `lastRowAt` is the last line belonging to it — where an append goes.
 */
export function findTable(
  lines: string[],
  headers: Record<string, string>,
  required: string[],
): { cols: string[]; headerAt: number; lastRowAt: number } | null {
  let cols: string[] | null = null;
  let headerAt = -1;
  let lastRowAt = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim().startsWith("|")) {
      if (cols) break; // the table ended — keep what we found
      continue;
    }
    const row = cells(line);
    if (isRule(row)) {
      if (cols) lastRowAt = i;
      continue;
    }
    if (!cols) {
      const mapped = mapHeader(row, headers);
      if (required.every((r) => mapped.includes(r))) {
        cols = mapped;
        headerAt = i;
        lastRowAt = i;
      }
      continue;
    }
    lastRowAt = i;
  }
  return cols && headerAt !== -1 ? { cols, headerAt, lastRowAt } : null;
}

/**
 * Append a row, returning the new content — or null if the note has no such
 * table, which is a refusal rather than an invitation to invent one.
 *
 * The row goes after the table's LAST line, found by re-reading the content
 * given. Never after a remembered index: the file may have changed in Obsidian
 * since it was read, and counting lines from a stale copy is how a write lands
 * in the middle of somebody's prose.
 */
export function appendRow(
  content: string,
  headers: Record<string, string>,
  required: string[],
  values: Record<string, string>,
): string | null {
  const table = findTable(noteLines(content).lines, headers, required);
  if (!table) return null;

  // A literal pipe would split one field into two and a newline would end the
  // row early, so both become spaces before they reach the table.
  const clean = (v: string) => (v ?? "").replace(/[|\r\n]/g, " ").trim();
  const row = `| ${table.cols.map((c) => clean(values[c] ?? "")).join(" | ")} |`;
  // Every other line keeps its bytes: joining on "\n" turned a CRLF ledger
  // into an LF one on the first append (audit COR-012).
  return spliceNoteLines(content, table.lastRowAt + 1, table.lastRowAt + 1, [row]);
}

/* ---- one row of a ledger, changed in place -------------------------------
   The screens change a row the way a person would in the note: that line and
   nothing else. Every other byte of the note stays as it was, a column the
   ledger does not know keeps its cell, and a row the ledger cannot read stays
   where it is, unread and untouched. */

/** Which tables of a note are this ledger, how its columns are named, and which column names a row. */
export interface LedgerSpec {
  headers: Record<string, string>;
  /** True for a header (mapped to field names) that makes a table this ledger. */
  accepts: (mapped: string[]) => boolean;
  /** The field that names a row: the service, the category, the account, the month. */
  key: string;
}

/** One row of a ledger, as written. */
export interface LedgerRow {
  /** Its place among the ledger's rows, from 0, over every table of the ledger in the note; rule lines are not rows. */
  index: number;
  /** 1-based line in the note. */
  line: number;
  /** The key column's cell. */
  name: string;
  /** Every known column's cell, by field, as written. */
  cells: Record<string, string>;
}

/** The ledger's rows and the version they were read at. */
export interface LedgerTable {
  /** Changes whenever any line of the ledger's tables does; prose around them does not count. */
  version: string;
  /** The fields the first table has a column for: what a new row or a change can fill in. */
  fields: string[];
  /** Every row with anything in it; a blank row keeps its index but is not listed. */
  rows: LedgerRow[];
}

/** A row as the person saw it: where it was, what it was called, and which version of the ledger they read. */
export interface RowRef {
  index: number;
  name: string;
  version: string;
}

/** A write's outcome: the note's new text, or why not, as the status a route answers with. */
export type RowWrite = { ok: true; content: string } | { ok: false; status: 409 | 422; reason: string };

interface Scanned {
  cols: string[];
  /** Every line of the table (header, rules, rows), in order. */
  lines: number[];
  /** The rows. */
  body: number[];
}

/**
 * Every table of the ledger, found exactly the way the parsers find them: a
 * line not starting with `|` ends a table, a rule line is skipped, and the
 * first pipe line that is not yet a table is tried as a header.
 */
function scan(lines: string[], spec: LedgerSpec): Scanned[] {
  const out: Scanned[] = [];
  let cur: Scanned | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim().startsWith("|")) {
      cur = null;
      continue;
    }
    const row = cells(line);
    if (isRule(row)) {
      cur?.lines.push(i);
      continue;
    }
    if (!cur) {
      const mapped = mapHeader(row, spec.headers);
      if (spec.accepts(mapped)) {
        cur = { cols: mapped, lines: [i], body: [] };
        out.push(cur);
      }
      continue;
    }
    cur.lines.push(i);
    cur.body.push(i);
  }
  return out;
}

/** FNV-1a, twice with two seeds: a version stamp, not a secret. */
function stamp(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x9e3779b9;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x01000193 + 0x3c6ef372) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

const versionOf = (lines: string[], tables: Scanned[]) => stamp(tables.map((t) => t.lines.map((i) => lines[i]!).join("\n")).join("\n\u0000\n"));

/** The ledger's rows, by field, with the version a change must name. */
export function readLedgerTable(content: string, spec: LedgerSpec): LedgerTable {
  const { lines } = noteLines(content);
  const tables = scan(lines, spec);
  const rows: LedgerRow[] = [];
  let index = 0;
  for (const t of tables)
    for (const at of t.body) {
      const row = cells(lines[at]!);
      const byField: Record<string, string> = {};
      t.cols.forEach((f, c) => {
        if (f && !(f in byField)) byField[f] = row[c] ?? "";
      });
      const i = index++;
      if (Object.values(byField).every((v) => v === "") && row.every((v) => v === "")) continue;
      rows.push({ index: i, line: at + 1, name: byField[spec.key] ?? "", cells: byField });
    }
  return { version: versionOf(lines, tables), fields: [...new Set((tables[0]?.cols ?? []).filter(Boolean))], rows };
}

const CHANGED = "This list changed since you opened it, so nothing was saved. Open it again and redo the change.";

/** The line a ref names, or why it names none. */
function locate(lines: string[], spec: LedgerSpec, ref: RowRef): { at: number; table: Scanned } | { ok: false; status: 409; reason: string } {
  const tables = scan(lines, spec);
  if (versionOf(lines, tables) !== ref.version) return { ok: false, status: 409, reason: CHANGED };
  let index = 0;
  for (const table of tables)
    for (const at of table.body) {
      if (index++ !== ref.index) continue;
      const k = table.cols.indexOf(spec.key);
      if ((k === -1 ? "" : (cells(lines[at]!)[k] ?? "")) !== ref.name) return { ok: false, status: 409, reason: CHANGED };
      return { at, table };
    }
  return { ok: false, status: 409, reason: CHANGED };
}

/** A value as a cell: a pipe would split it and a newline end the row, so both become spaces. */
const asCell = (v: string) => (v ?? "").replace(/[|\r\n]/g, " ").trim();

/**
 * Change some cells of one row, returning the note's new text. Only that line
 * is rewritten; the cells not named keep their text, unknown columns
 * included. A field the table has no column for is refused rather than
 * dropped: the person typed it and would lose it.
 */
export function changeRow(content: string, spec: LedgerSpec, ref: RowRef, set: Record<string, string>): RowWrite {
  const { lines } = noteLines(content);
  const found = locate(lines, spec, ref);
  if ("ok" in found) return found;
  const { at, table } = found;
  const row = cells(lines[at]!);
  while (row.length < table.cols.length) row.push("");
  let changed = false;
  for (const [field, value] of Object.entries(set)) {
    const c = table.cols.indexOf(field);
    if (c === -1) return { ok: false, status: 422, reason: `This list has no place for ${field}.` };
    changed ||= row[c] !== asCell(value);
    row[c] = asCell(value);
  }
  // The same cells written back are the same line, padding and all: a save that changes nothing changes no byte.
  if (!changed) return { ok: true, content };
  const indent = /^\s*/.exec(lines[at]!)![0];
  return { ok: true, content: spliceNoteLines(content, at, at + 1, [`${indent}| ${row.join(" | ")} |`]) };
}

/** Remove one row: its line goes, every other line stays. */
export function removeRow(content: string, spec: LedgerSpec, ref: RowRef): RowWrite {
  const { lines } = noteLines(content);
  const found = locate(lines, spec, ref);
  if ("ok" in found) return found;
  return { ok: true, content: spliceNoteLines(content, found.at, found.at + 1, []) };
}

/**
 * Move one row to where row `to` is, inside its own table: the order of a
 * ledger can mean something (the categories' order sets their colours).
 */
export function moveRow(content: string, spec: LedgerSpec, ref: RowRef, to: number): RowWrite {
  const { lines } = noteLines(content);
  const found = locate(lines, spec, ref);
  if ("ok" in found) return found;
  const { at, table } = found;
  const first = ref.index - table.body.indexOf(at);
  const target = table.body[to - first];
  if (target === undefined) return { ok: false, status: 422, reason: "A row moves only inside its own list." };
  if (target === at) return { ok: true, content };
  const lo = Math.min(at, target);
  const hi = Math.max(at, target);
  const span = lines.slice(lo, hi + 1);
  const moved = span.splice(at - lo, 1)[0]!;
  span.splice(target - lo, 0, moved);
  return { ok: true, content: spliceNoteLines(content, lo, hi + 1, span) };
}

/** A new table's first two lines, for a note that has none yet. */
export const tableHead = (labels: readonly string[]): string[] => [`| ${labels.join(" | ")} |`, `|${labels.map(() => "---").join("|")}|`];
