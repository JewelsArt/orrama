/**
 * Relations, in words (structure.md §2.6, §6 #27), and Orr's warnings about one entity.
 *
 * `useRelations(noteId)` asks the knowledge graph what this note is related to, both ways
 * (`GET /api/graph/relations`): supervised by, involves, discussed in, works at. Without a
 * `#vault-ontology` note the graph has no types and answers with nothing, and the page shows the
 * plain links it already has; that is what a vault without the ontology looks like, not an
 * error. `RelationRows` draws people, companies, conversations and notes as rows with the
 * relation's word at the end; `OrrWarnings` puts the entity's own warnings at the top as Orr's
 * work (§5).
 */
import { useEffect, useState, type ReactNode } from "react";
import type { GraphRelations } from "@orrama/schema/responses";
import { api, isAbort } from "../api.js";
import { Ring, Square } from "../ui/controls.js";
import { Icon } from "../ui/Icon.js";
import { RowList, Row } from "../ui/layout.js";
import { HeadMark } from "../ui/orr/Orr.js";

export interface Related {
  id: string;
  title: string;
  type: string;
}

export interface RelationsState {
  loaded: boolean;
  /** relation id → what this note has it to (`supervised_by` → [Ines Vermaat]). */
  by: Map<string, Related[]>;
  warnings: string[];
}

const EMPTY: RelationsState = { loaded: false, by: new Map(), warnings: [] };

/** The graph's relations of one note. `refresh` changes when the page reloads its data. */
export function useRelations(noteId: string | null | undefined, refresh?: unknown): RelationsState {
  const [state, setState] = useState<RelationsState>(EMPTY);
  useEffect(() => {
    if (!noteId) return;
    const ac = new AbortController();
    api<GraphRelations>("GET", `/api/graph/relations?entity=${encodeURIComponent(noteId)}`, undefined, { signal: ac.signal })
      .then((r) =>
        setState({
          loaded: true,
          by: new Map(r.relations.map((g) => [g.relation, g.to.map((t) => ({ id: t.id, title: t.title, type: t.type }))])),
          warnings: r.warnings,
        }),
      )
      .catch((e) => {
        if (isAbort(e)) return;
        // A note the graph does not hold (no ontology, or not readable): no relations.
        setState({ loaded: true, by: new Map(), warnings: [] });
      });
    return () => ac.abort();
  }, [noteId, refresh]);
  return state;
}

/**
 * The word for what someone is to this entity, from the relation the entity has to them:
 * a project `supervised_by` Ines reads "supervises" beside her.
 */
const ROLE: Record<string, string> = {
  supervised_by: "supervises",
  involves: "involved",
  company_involved_in: "involved",
  involves_company: "involved",
  employs: "works here",
  works_at: "works at",
  involved_in: "involved in",
  supervises: "supervised",
  discussed_in: "discussed",
  has_part: "part",
  part_of: "part of",
  about: "about",
};
/** Stronger words win when a note is related twice (Ines supervises AND is involved). */
const STRENGTH = ["supervised_by", "employs", "works_at", "involves", "company_involved_in", "involves_company"];

export function roleWord(relation: string): string {
  return ROLE[relation] ?? relation.replace(/_/g, " ");
}

/** For each related note, the strongest word for it. */
export function rolesOf(by: Map<string, Related[]>): Map<string, string> {
  const out = new Map<string, string>();
  const order = [...by.keys()].sort((a, b) => (STRENGTH.indexOf(a) + 1 || 99) - (STRENGTH.indexOf(b) + 1 || 99));
  for (const rel of order) for (const r of by.get(rel)!) if (!out.has(r.id)) out.set(r.id, roleWord(rel));
  return out;
}

export interface RelationItem {
  id: string;
  title: string;
  kind: "person" | "company" | "conversation" | "note" | "document";
  meta?: ReactNode;
  /** The relation's word, at the row's end ("supervises"). */
  word?: string;
  href?: string;
  onOpen?: () => void;
  /** Secondary actions, at the end on hover. */
  hover?: ReactNode;
}

const leadOf = (it: RelationItem) =>
  it.kind === "person" ? (
    <Ring name={it.title} small />
  ) : it.kind === "company" ? (
    <Square name={it.title} small />
  ) : (
    <Icon name={it.kind === "conversation" ? "chat" : "notes"} size={18} />
  );

/** Related things as rows: a ring for a person, a square for a company, then the word. */
export function RelationRows({ items, label }: { items: RelationItem[]; label?: string }) {
  return (
    <RowList label={label}>
      {items.map((it) => (
        <Row
          key={it.id}
          className="ent-rel"
          lead={leadOf(it)}
          title={it.title}
          meta={it.meta}
          trailing={it.word ?? ""}
          hover={it.hover}
          href={it.href}
          onOpen={it.onOpen}
        />
      ))}
    </RowList>
  );
}

/** The entity's own warnings, as Orr's work at the top of the page (§2.6). Nothing when there are none. */
export function OrrWarnings({ warnings, actions }: { warnings: string[]; actions?: ReactNode }) {
  if (warnings.length === 0) return null;
  return (
    <div className="oprop boxed ent-warn" role="note" aria-label="Orr noticed">
      <HeadMark size={18} />
      <div>
        {warnings.length === 1 ? (
          <p>{warnings[0]}</p>
        ) : (
          <ul>
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        )}
        {actions && <div className="acts">{actions}</div>}
      </div>
    </div>
  );
}
