/**
 * What the map says about typed edges, apart from drawing them: a relation's
 * name as words, and a node's relations as the lines its readout lists.
 * The map stays monochrome — the relation is told in words, and weight
 * (a typed edge is heavier, an implied one dashed), never in colour.
 */
export interface MapEdge {
  from: string;
  to: string;
  relation?: string;
  implied?: true;
}

export interface RelationLine {
  /** "out": this note is the subject (works at → Scooperz). "in": it is the object (← works at Mara). */
  dir: "out" | "in";
  label: string;
  title: string;
}

export const relationLabel = (relation: string): string => relation.replace(/_/g, " ");

/** Most lines a readout lists; the rest are counted, not drawn. */
export const READOUT_RELATIONS = 6;

export function relationsAt(
  edges: readonly MapEdge[],
  id: string,
  titleOf: (id: string) => string | undefined,
  limit = READOUT_RELATIONS,
): { lines: RelationLine[]; more: number } {
  const all: RelationLine[] = [];
  for (const e of edges) {
    if (!e.relation || (e.from !== id && e.to !== id)) continue;
    const other = titleOf(e.from === id ? e.to : e.from);
    if (other === undefined) continue;
    all.push({ dir: e.from === id ? "out" : "in", label: relationLabel(e.relation), title: other });
  }
  all.sort((a, b) => a.label.localeCompare(b.label) || a.title.localeCompare(b.title));
  return { lines: all.slice(0, limit), more: Math.max(0, all.length - limit) };
}

/** The edges the map draws: with relations off, the plain links only, unnamed. */
export function edgesFor(edges: readonly MapEdge[], relations: boolean): MapEdge[] {
  return relations ? [...edges] : edges.filter((e) => !e.implied).map(({ from, to }) => ({ from, to }));
}
