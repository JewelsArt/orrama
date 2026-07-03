/**
 * "Suggested links" (spec §9, surface 3): possibly related, not yet linked.
 * Pure local lexical similarity (TF-IDF cosine) — no API call, free and instant.
 * The server-side embedding index can replace the scorer later; the interface stays.
 */
import type { IndexedNote, NoteId } from "./types.js";

const STOP = new Set(
  "the a an and or but of to in on for with at by from as is are was were be been it its this that these those we you i they he she not no do does did have has had will would can could should".split(" "),
);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOP.has(t));
}

export interface RelatedNote {
  id: NoteId;
  title: string;
  path: string;
  score: number;
}

/** Rank candidate notes by lexical similarity to `note`, excluding already-linked ones. */
export function suggestRelated(
  note: IndexedNote,
  candidates: IndexedNote[],
  resolveLink: (target: string) => IndexedNote | undefined,
  limit = 5,
): RelatedNote[] {
  const linked = new Set<NoteId>();
  for (const l of note.links) {
    const t = resolveLink(l.target);
    if (t) linked.add(t.id);
  }

  const docs = candidates.filter((c) => c.id !== note.id);
  const df = new Map<string, number>();
  const docTokens = new Map<NoteId, Map<string, number>>();
  for (const d of [note, ...docs]) {
    const tf = new Map<string, number>();
    for (const tok of tokenize(d.title + " " + d.content)) tf.set(tok, (tf.get(tok) ?? 0) + 1);
    docTokens.set(d.id, tf);
    for (const tok of tf.keys()) df.set(tok, (df.get(tok) ?? 0) + 1);
  }
  const n = docs.length + 1;
  const vec = (id: NoteId): Map<string, number> => {
    const tf = docTokens.get(id)!;
    const v = new Map<string, number>();
    for (const [tok, count] of tf) v.set(tok, (1 + Math.log(count)) * Math.log(n / (df.get(tok) ?? 1)));
    return v;
  };
  const target = vec(note.id);
  const norm = (v: Map<string, number>) => Math.sqrt([...v.values()].reduce((s, x) => s + x * x, 0)) || 1;
  const tNorm = norm(target);

  return docs
    .filter((d) => !linked.has(d.id))
    .map((d) => {
      const v = vec(d.id);
      let dot = 0;
      for (const [tok, w] of target) dot += w * (v.get(tok) ?? 0);
      return { id: d.id, title: d.title, path: d.path, score: dot / (tNorm * norm(v)) };
    })
    .filter((r) => r.score > 0.05)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
