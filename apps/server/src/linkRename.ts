/**
 * Links follow a renamed or moved note (Jules, 21 Oct 2026: "yes, only the exact forms").
 *
 * A wiki link names a note by its file name, its title or its vault path (core vault.ts,
 * `linkKeys`). A rename changes the file name (and the title with it); a move changes the
 * path. Here a link is rewritten only when it is one of those exact forms — `[[Old]]`,
 * `[[folder/Old]]`, `[[Old.md]]`, with any `#heading`, `#^block` or `|label` kept as written —
 * and only when that form would stop naming the note. A link by an alias still works and is
 * left alone; a Markdown link (`[text](Old.md)`) is counted as one that won't follow, never
 * rewritten. Links inside code (fences, inline spans) are text, as the parser reads them.
 */
import { codeLines, foldPath, noteLines, parseFrontmatter, titleFromPath } from "@orrama/core";

/**
 * The parser's link grammar (core parse.ts LINK_RE): `[[target#heading|alias]]`, the alias
 * pipe escaped as `\|` inside a table. Kept identical; `linkRename.test.ts` holds the two
 * together by checking every link the parser finds is one this finds.
 */
const LINK_RE = /\[\[([^\[\]\|#]+?)(?:#([^\[\]\|]+?))?(?:\\?\|([^\[\]]+))?\]\]/g;

/** A note's names before and after: its vault path and its title. */
export interface Renaming {
  from: { path: string; title: string };
  to: { path: string; title: string };
}

/**
 * The new target for a wiki link's `target`, or null when the link doesn't change — it names
 * the note some other way (an alias), or by a name the rename keeps.
 */
export function retarget(target: string, r: Renaming): string | null {
  const t = foldPath(target.trim());
  const oldStem = titleFromPath(r.from.path);
  const newStem = titleFromPath(r.to.path);
  if (t === foldPath(oldStem)) return oldStem === newStem ? null : newStem;
  if (t === foldPath(r.from.title)) return r.from.title === r.to.title ? null : r.to.title;
  if (r.from.path === r.to.path) return null;
  if (t === foldPath(r.from.path)) return r.to.path;
  if (t === foldPath(r.from.path.replace(/\.md$/i, ""))) return r.to.path.replace(/\.md$/i, "");
  return null;
}

/** Where a line's inline code spans are, [start, end) — CommonMark's runs of backticks. */
function codeSpans(line: string): [number, number][] {
  if (!line.includes("`")) return [];
  const runs = [...line.matchAll(/`+/g)].map((m) => ({ at: m.index, len: m[0].length }));
  const out: [number, number][] = [];
  for (let i = 0; i < runs.length; i++) {
    const j = runs.findIndex((r, k) => k > i && r.len === runs[i]!.len);
    if (j < 0) continue;
    out.push([runs[i]!.at, runs[j]!.at + runs[j]!.len]);
    i = j;
  }
  return out;
}

/**
 * `content` with each wiki link whose target `next` gives a new name for rewritten to it, and
 * how many were. `next` is asked with the target as written; null leaves the link as it is.
 * Front matter is rewritten too (a `company: "[[Acme]]"` line), but only when it still reads
 * back afterwards; otherwise the body alone. Every other byte is kept, line endings included.
 */
export function rewriteLinks(content: string, next: (target: string) => string | null): { content: string; count: number } {
  const fm = parseFrontmatter(content);
  const attempt = (inFrontMatter: boolean) => {
    const { lines, cr } = noteLines(content);
    const code = codeLines(lines.slice(fm.bodyStart));
    let count = 0;
    const out = lines.map((line, i) => {
      const body = i >= fm.bodyStart;
      if (body ? code[i - fm.bodyStart] : !inFrontMatter) return line;
      const spans = body ? codeSpans(line) : [];
      return line.replace(LINK_RE, (whole: string, target: string, ...rest: unknown[]) => {
        const at = rest[rest.length - 2] as number;
        if (spans.some(([a, b]) => at >= a && at < b)) return whole;
        const name = next(target.trim());
        if (name === null) return whole;
        count++;
        return `[[${name}${whole.slice(2 + target.length)}`;
      });
    });
    return { content: out.map((l, i) => l + cr[i]).join("\n"), count };
  };
  const all = attempt(true);
  if (fm.bodyStart === 0 || fm.malformed || fm.notMapping) return all;
  const after = parseFrontmatter(all.content);
  return after.malformed || after.notMapping ? attempt(false) : all;
}
