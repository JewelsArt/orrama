/**
 * Reading and writing the Markdown tables the vault keeps ledgers in.
 *
 * Every table here is hand-editable in Obsidian, so nothing may depend on the
 * order or the exact spelling of its columns: a header is matched by NAME
 * through a synonym map, and a row is written back in whatever order that
 * table's own header declares. Rearranging columns by hand therefore cannot
 * turn a price into a date, and adding a column of your own is harmless.
 */

/** Split a `| a | b |` row into trimmed cells, dropping the outer pipes. */
export const cells = (row: string): string[] =>
  row
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
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
  const lines = content.split(/\r?\n/);
  const table = findTable(lines, headers, required);
  if (!table) return null;

  // A literal pipe would split one field into two and a newline would end the
  // row early, so both become spaces before they reach the table.
  const clean = (v: string) => (v ?? "").replace(/[|\r\n]/g, " ").trim();
  const row = `| ${table.cols.map((c) => clean(values[c] ?? "")).join(" | ")} |`;
  lines.splice(table.lastRowAt + 1, 0, row);
  return lines.join("\n");
}
