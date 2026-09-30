/**
 * One note id, one file (audit item 11). A note copied outside Basalt —
 * Obsidian's "Make a copy", a Finder duplicate, `cp`, a sync conflict copy —
 * carries the original's `id: n-…`, and everything is keyed by that id: the
 * index, the notes table, task objects, calendar blocks, the Y.Doc history.
 * The copy used to take all of it over (or, depending on walk order, hide
 * behind the original until deleting it deleted the original too).
 *
 * The rule: the file that already owns the id keeps it; the other one is
 * given an id of its own, stamped into its front matter and logged. Live,
 * "already owns" is the file the index holds under that id, if it is still
 * on disk with that id (otherwise the newcomer is that note, renamed). At
 * boot, when several files carry one id, it is decided here.
 */
import { parseFrontmatter } from "@basalt/core";

/** The id a note's front matter carries — what parseNote would read. */
export function carriedId(content: string): string | undefined {
  const id = parseFrontmatter(content).data["id"];
  return typeof id === "string" ? id : undefined;
}

export interface IdCandidate {
  rel: string;
  /** 0 where the filesystem does not record creation time. */
  birthtimeMs: number;
  mtimeMs: number;
}

/**
 * Which of several files carrying one id keeps it, deterministically:
 *
 * 1. the file at the path the notes table already has for the id — the one
 *    Basalt knew as this note;
 * 2. else the one created first. A copy is born after its original, while
 *    mtime says little: the original is the file that keeps being edited, so
 *    a stale copy is often the one with the OLDER mtime. Skipped when any
 *    candidate has no creation time;
 * 3. else the older mtime;
 * 4. else the path, in code-unit order.
 */
export function chooseIdOwner<C extends IdCandidate>(candidates: C[], knownPath: string | undefined): C {
  const known = knownPath === undefined ? undefined : candidates.find((c) => c.rel === knownPath);
  if (known) return known;
  const births = candidates.every((c) => c.birthtimeMs > 0);
  return [...candidates].sort(
    (a, b) =>
      (births ? a.birthtimeMs - b.birthtimeMs : 0) ||
      a.mtimeMs - b.mtimeMs ||
      (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0),
  )[0]!;
}
