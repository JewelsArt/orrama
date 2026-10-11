/**
 * Which note a wiki link opens (WEB-007). The server already resolved every link of the open
 * note — by path, filename, title and alias, the strongest kind winning (CLAUDE.md "Design
 * rules") — and sent it as `NoteDetail.links[].targetId`, so a cmd-click asks that first. The
 * tree is only the fallback, for a link typed since the note was last loaded, and follows the
 * same order: a path, then a file name, then a title.
 */
export interface LinkRef {
  target: string;
  targetId?: string | null;
  locked?: boolean;
}

export interface TreeRef {
  id: string;
  path: string;
  title: string;
}

const fold = (s: string) => s.normalize("NFC").trim().toLowerCase();
const noExt = (s: string) => s.replace(/\.md$/i, "");

export function noteForLink(target: string, links: LinkRef[], tree: TreeRef[]): string | null {
  const key = fold(target);
  const known = links.find((l) => fold(l.target) === key);
  if (known) return known.locked ? null : (known.targetId ?? null);
  const path = noExt(key);
  const byPath = tree.find((n) => fold(noExt(n.path)) === path);
  if (byPath) return byPath.id;
  const byFile = tree.find((n) => fold(noExt(n.path.slice(n.path.lastIndexOf("/") + 1))) === path);
  if (byFile) return byFile.id;
  return tree.find((n) => fold(n.title) === key)?.id ?? null;
}
