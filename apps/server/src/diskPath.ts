/**
 * The vault's path identity is the spelling on disk (audit ACL-001, STO-012).
 *
 * APFS (and NTFS) treat `Shared/eng secret.md` and `Shared/Eng Secret.md` as
 * one file, and APFS also treats a composed `Résumé.md` and a decomposed one
 * as one. The index, the folder grants and the watcher compared paths as
 * strings, so a second spelling of a note was a NEW note: judged with no tags,
 * then renamed over the real file; and a case-only rename in Obsidian started
 * an endless restamp loop. Two rules close it, on any filesystem:
 *
 *  - a path a caller sends is resolved to the entry the directory holds —
 *    exact first, then case- and NFC-insensitively (`onDisk`);
 *  - the watcher believes a spelling only when the directory lists it exactly
 *    (`listedExactly`): `existsSync` on a case-insensitive volume says yes to
 *    every spelling of a file, so it is no proof the name an event carries
 *    is still the file's name.
 */
import fs from "node:fs";
import path from "node:path";
import { foldPath } from "@basalt/core";

function names(dir: string): string[] | null {
  try {
    return fs.readdirSync(dir);
  } catch {
    return null;
  }
}

export class AmbiguousPathError extends Error {}

/**
 * `rel` (vault-relative, `/`-separated) with each segment that names an
 * existing entry spelled as the directory spells it. Segments past the first
 * one with no entry are kept as given — that part is new. `found` says whether
 * the whole path names an existing entry. On a case-sensitive volume holding
 * two entries that fold together and neither matching exactly, the path is
 * ambiguous and nothing is guessed.
 */
export function onDisk(root: string, rel: string): { rel: string; found: boolean } {
  const out: string[] = [];
  let dir = root;
  let found = true;
  for (const seg of rel.split("/")) {
    const listed = found ? names(dir) : null;
    let pick = seg;
    if (listed && !listed.includes(seg)) {
      const want = foldPath(seg);
      const matches = listed.filter((n) => foldPath(n) === want);
      if (matches.length > 1) throw new AmbiguousPathError(`"${rel}" matches ${matches.length} files that differ only in case`);
      if (matches.length === 1) pick = matches[0]!;
      else found = false;
    } else if (!listed) {
      found = false;
    }
    out.push(pick);
    dir = path.join(dir, pick);
  }
  return { rel: out.join("/"), found };
}

/** Whether every segment of `rel` is listed, spelled exactly so, in its folder. */
export function listedExactly(root: string, rel: string): boolean {
  let dir = root;
  for (const seg of rel.split("/")) {
    if (!names(dir)?.includes(seg)) return false;
    dir = path.join(dir, seg);
  }
  return true;
}

/** Whether two existing paths are one file (one inode), whatever their spelling. */
export function sameFile(a: string, b: string): boolean {
  try {
    const sa = fs.statSync(a);
    const sb = fs.statSync(b);
    return sa.ino === sb.ino && sa.dev === sb.dev;
  } catch {
    return false;
  }
}
