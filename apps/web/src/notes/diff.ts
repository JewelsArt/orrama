/**
 * A line diff for a note's history (1C): an earlier version against the note as it is now,
 * as the History sheet shows it. Pure, so it is tested alone.
 */

export interface DiffLine {
  kind: "same" | "add" | "del";
  text: string;
}

/** Past this many cells (old lines × new lines, after the common start and end) the middle is
 *  shown as removed then added, not matched line by line: a note rewritten whole. */
const MAX_CELLS = 2_000_000;

/** `before` → `after`, line by line: the longest common subsequence, kept lines as `same`. */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const head = a.slice(0, start).map((text): DiffLine => ({ kind: "same", text }));
  const tail = a.slice(endA).map((text): DiffLine => ({ kind: "same", text }));
  const x = a.slice(start, endA);
  const y = b.slice(start, endB);
  let middle: DiffLine[];
  if (x.length * y.length > MAX_CELLS) {
    middle = [...x.map((text): DiffLine => ({ kind: "del", text })), ...y.map((text): DiffLine => ({ kind: "add", text }))];
  } else {
    // lcs[i][j]: the longest common run of x[i..] and y[j..], one row at a time.
    const w = y.length + 1;
    const lcs = new Uint32Array((x.length + 1) * w);
    for (let i = x.length - 1; i >= 0; i--) {
      for (let j = y.length - 1; j >= 0; j--) {
        lcs[i * w + j] = x[i] === y[j] ? lcs[(i + 1) * w + j + 1]! + 1 : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!);
      }
    }
    middle = [];
    let i = 0;
    let j = 0;
    while (i < x.length && j < y.length) {
      if (x[i] === y[j]) {
        middle.push({ kind: "same", text: x[i]! });
        i++;
        j++;
      } else if (lcs[(i + 1) * w + j]! >= lcs[i * w + j + 1]!) {
        middle.push({ kind: "del", text: x[i++]! });
      } else {
        middle.push({ kind: "add", text: y[j++]! });
      }
    }
    while (i < x.length) middle.push({ kind: "del", text: x[i++]! });
    while (j < y.length) middle.push({ kind: "add", text: y[j++]! });
  }
  return [...head, ...middle, ...tail];
}

/** A run of unchanged lines folded away, or one line to show. */
export type Shown = DiffLine | { kind: "fold"; count: number };

/** The changes with `context` unchanged lines around each; longer unchanged runs fold. */
export function withContext(lines: DiffLine[], context = 2): Shown[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((l, i) => {
    if (l.kind === "same") return;
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true;
  });
  const out: Shown[] = [];
  let folded = 0;
  lines.forEach((l, i) => {
    if (keep[i]) {
      if (folded) out.push({ kind: "fold", count: folded });
      folded = 0;
      out.push(l);
    } else folded++;
  });
  if (folded) out.push({ kind: "fold", count: folded });
  return out;
}

/** "3 lines added, 1 removed" — or null when nothing differs. */
export function changeWords(lines: DiffLine[]): string | null {
  const add = lines.filter((l) => l.kind === "add").length;
  const del = lines.filter((l) => l.kind === "del").length;
  if (!add && !del) return null;
  const n = (k: number, w: string) => `${k} ${k === 1 ? "line" : "lines"} ${w}`;
  if (add && del) return `${n(add, "added")}, ${del} removed`;
  return add ? n(add, "added") : n(del, "removed");
}
