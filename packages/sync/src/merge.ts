/**
 * Three-way text merge: every edit `ours` and `theirs` each made against `base`
 * survives.
 *
 * `updateDocContent` expresses a new text as ONE splice — the common prefix and
 * suffix kept, everything between replaced. Against the live doc that is fine
 * when nothing else has moved. When something has (an Obsidian save the watcher
 * has not delivered yet, a second tab), one splice from line 5 to line 90 also
 * rewrites line 50 back to what the stale side last saw, and the other side's
 * edit there is gone. That is the audit's B5 failure.
 *
 * So each side is diffed against the base LINE BY LINE into separate hunks, and
 * the two hunk lists are composed over the base directly. Disjoint hunks compose
 * exactly. Where both sides change the same lines, both deletions apply and both
 * insertions are kept — text can appear twice, but no one's typing is thrown
 * away. The same hunk made on both sides is applied once.
 *
 * This is deliberately not a fork-and-merge of two Y.Docs. Yjs orders two
 * inserts that share both neighbours by client id, which is arbitrary here: "a
 * line added under L10" and "L11 rewritten" are two inserts at the same spot,
 * and which comes first is a question about what the edits MEAN. The rules below
 * answer it explicitly; a seeded randomised test in merge.test.ts holds them.
 */

/** A replacement of base[start, end) by `insert`, in character offsets. */
interface Hunk {
  start: number;
  end: number;
  insert: string;
}

/** Split keeping each line's own "\n", so offsets add back up to the text. */
const lines = (s: string): string[] => (s === "" ? [] : s.split(/(?<=\n)/));

/**
 * Above this many LCS cells the changed middle is treated as one hunk. The
 * largest note in the vault is ~1,600 lines, so this is a guard against a
 * pathological paste, not a limit ordinary notes come near.
 */
const MAX_CELLS = 4_000_000;

/** Line-level diff of `a` → `b` as hunks against `a`. */
export function lineHunks(a: string, b: string): Hunk[] {
  if (a === b) return [];
  const A = lines(a);
  const B = lines(b);

  // Common prefix/suffix lines first: most saves change a few lines, so the
  // table below is built over the changed middle only.
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;

  const midA = A.slice(pre, A.length - suf);
  const midB = B.slice(pre, B.length - suf);
  const offset = A.slice(0, pre).join("").length;
  const one = (): Hunk[] => [{ start: offset, end: offset + midA.join("").length, insert: midB.join("") }];
  if (midA.length === 0 || midB.length === 0 || midA.length * midB.length > MAX_CELLS) return one();

  // LCS table, suffix form: L[i][j] = LCS of midA[i..] and midB[j..].
  const n = midA.length;
  const m = midB.length;
  const L = new Uint32Array((n + 1) * (m + 1));
  const at = (i: number, j: number) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[at(i, j)] = midA[i] === midB[j] ? L[at(i + 1, j + 1)]! + 1 : Math.max(L[at(i + 1, j)]!, L[at(i, j + 1)]!);
    }
  }

  // Walk it, turning each run of unmatched lines into one hunk.
  const hunks: Hunk[] = [];
  let i = 0;
  let j = 0;
  let pos = offset;
  let open: Hunk | null = null;
  const close = () => {
    if (open) hunks.push(open);
    open = null;
  };
  while (i < n || j < m) {
    if (i < n && j < m && midA[i] === midB[j]) {
      close();
      pos += midA[i]!.length;
      i++;
      j++;
    } else if (j < m && (i === n || L[at(i, j + 1)]! >= L[at(i + 1, j)]!)) {
      open ??= { start: pos, end: pos, insert: "" };
      open.insert += midB[j]!;
      j++;
    } else {
      open ??= { start: pos, end: pos, insert: "" };
      pos += midA[i]!.length;
      open.end = pos;
      i++;
    }
  }
  close();
  return hunks;
}

type Sided = Hunk & { theirs: boolean };

export function mergeText(base: string, ours: string, theirs: string): string {
  if (ours === theirs || theirs === base) return ours;
  if (ours === base) return theirs;

  const T: Sided[] = lineHunks(base, theirs).map((h) => ({ ...h, theirs: true }));
  const same = (h: Hunk) => T.some((t) => t.start === h.start && t.end === h.end && t.insert === h.insert);
  const O: Sided[] = lineHunks(base, ours).filter((h) => !same(h)).map((h) => ({ ...h, theirs: false }));

  // Order at a shared start: a pure insertion sits on the boundary ABOVE the
  // line starting there, so it goes before a replacement of that line; two
  // insertions at one spot go theirs (already on disk) first. Hunks from one
  // side never touch each other — lineHunks separates them by a matched line.
  const pure = (h: Hunk) => h.end === h.start;
  const all = [...T, ...O].sort(
    (a, b) => a.start - b.start || Number(!pure(a)) - Number(!pure(b)) || Number(b.theirs) - Number(a.theirs),
  );

  // Hunks whose ranges genuinely overlap are one conflict: both deletions
  // apply, both insertions are kept (theirs first). Nobody's typing is lost;
  // at worst a line appears twice. Touching end-to-start is not an overlap.
  let out = "";
  let pos = 0;
  for (let k = 0; k < all.length; ) {
    let end = all[k]!.end;
    let j = k + 1;
    while (j < all.length && all[j]!.start < end) end = Math.max(end, all[j++]!.end);
    const cluster = all.slice(k, j);
    const insert = [...cluster.filter((h) => h.theirs), ...cluster.filter((h) => !h.theirs)].map((h) => h.insert).join("");
    out += base.slice(pos, cluster[0]!.start) + insert;
    pos = end;
    k = j;
  }
  return out + base.slice(pos);
}
