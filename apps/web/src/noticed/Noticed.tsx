/**
 * Orr noticed (structure.md §2.15), `/notes/health`: the knowledge graph's warnings said as
 * sentences about the notes they are about, each with one fix, then the graph at a glance (its
 * types, relations and statuses with counts, and the note they are read from). You reach it from
 * Today's module, Settings → Notes and an entity page's warning. Orr's pose here is Search.
 *
 * Nothing changes until a fix is clicked. A company that has no note opens People's New company
 * prefilled; a project's status is written through the project's own PATCH; a tag naming a
 * project with no note creates that project's note; anything else opens the note to change by
 * hand. Without an ontology note there is nothing to check, and the page says so plainly.
 */
import type { GraphSchema, GraphWarnings, Me, NotesOverview } from "@basalt/schema/responses";
import { api } from "../api.js";
import { useKnown, useLoad, useNotesTick, type Load } from "../entity/known.js";
import { anchor, linkTo, notePath } from "../entity/links.js";
import { Button, NameLink } from "../ui/controls.js";
import { Module, PageHeader } from "../ui/layout.js";
import { Orr } from "../ui/orr/Orr.js";
import { type Route } from "../ui/router.js";
import { EmptyState, Notice, Skeleton } from "../ui/states.js";
import { NoticeRow, useFixes } from "./fixes.js";
import { itemsOf, statusWord, typeCount } from "./model.js";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function Noticed({ me }: { me: Me }) {
  const [tick, refresh] = useNotesTick();
  const warnings = useLoad((signal) => api<GraphWarnings>("GET", "/api/graph/warnings", undefined, { signal }), [tick]);
  const schema = useLoad((signal) => api<GraphSchema>("GET", "/api/graph/schema", undefined, { signal }), [tick]);
  const overview = useLoad((signal) => api<NotesOverview>("GET", "/api/notes/overview", undefined, { signal }), [tick]);
  const { known } = useKnown();
  const { run, dialog } = useFixes(me, known, refresh);

  const items = warnings.state === "ok" ? itemsOf(warnings.data.warnings) : [];
  const typed = warnings.state === "ok" && warnings.data.typed;

  const meta =
    overview.state === "ok"
      ? `Read from ${plural(overview.data.notes, "note")}${overview.data.conversations ? ` and ${plural(overview.data.conversations, "conversation")}` : ""}`
      : undefined;

  return (
    <div className="ui noticed-page">
      <PageHeader title="Orr noticed" meta={meta} crumbs={[{ label: "Notes", ...linkTo({ kind: "notes" }) }, { label: "Orr noticed" }]} />
      <div className="noti-cols">
        <Module title="What needs a look" count={items.length > 0 ? items.length : undefined} className="noti-look">
          {warnings.state === "loading" && <Skeleton rows={4} />}
          {warnings.state === "failed" && <Notice title="The graph didn't load." text="Your notes are fine. Try again in a moment." actions={<Button size="sm" onClick={refresh}>Try again</Button>} />}
          {warnings.state === "ok" && !typed && (
            <div className="noti-plain">
              <div className="orrbox">
                <Orr pose="search" size={60} />
              </div>
              <p>
                Your notes have no ontology yet, so there is nothing for Orr to check. A note tagged <code>#vault-ontology</code> says what kinds of
                things your notes are (people, companies, projects) and how they relate; until there is one, pages show plain links.
              </p>
            </div>
          )}
          {warnings.state === "ok" && typed && items.length === 0 && <EmptyState pose="search" title="Nothing needs a look." text="Every person has a company, every project a status, and every link in the graph lands on a note." />}
          {items.length > 0 && (
            <>
              <div className="noti-intro">
                <div className="orrbox">
                  <Orr pose="search" size={56} />
                </div>
                <p>Each one is said with one fix. Nothing changes until you click.</p>
              </div>
              <ul className="noti-list" aria-label="What needs a look">
                {items.map((it) => (
                  <NoticeRow key={it.key} item={it} known={known} onFix={(f, v) => void run(it, f, v)} />
                ))}
              </ul>
            </>
          )}
        </Module>
        <Glance schema={schema} warnings={warnings} overview={overview} />
      </div>
      {dialog}
    </div>
  );
}

function Glance({ schema, warnings, overview }: { schema: Load<GraphSchema>; warnings: Load<GraphWarnings>; overview: Load<NotesOverview> }) {
  const ont = warnings.state === "ok" ? warnings.data.ontology : null;
  const s = schema.state === "ok" ? schema.data : null;
  const typed = !!s && s.types.length > 0;
  const placeOfType: Record<string, Route> = { person: { kind: "people" }, company: { kind: "people" }, project: { kind: "projects" } };
  return (
    <aside className="noti-side">
      <Module title="Your notes at a glance" className="noti-glance">
        {overview.state === "ok" && (
          <dl className="noti-counts">
            <div>
              <dt>Notes</dt>
              <dd>{overview.data.notes}</dd>
            </div>
            <div>
              <dt>Conversations</dt>
              <dd>{overview.data.conversations}</dd>
            </div>
            <div>
              <dt>Steps open</dt>
              <dd>{overview.data.openTasks}</dd>
            </div>
            <div>
              <dt>Steps done</dt>
              <dd>{overview.data.doneTasks}</dd>
            </div>
          </dl>
        )}
        {schema.state === "loading" && <Skeleton rows={3} />}
        {typed && (
          <>
            <h3 className="noti-h">Types</h3>
            <ul className="noti-tally">
              {s.types
                .filter((t) => t.count > 0)
                .map((t) => (
                  <li key={t.id}>
                    {placeOfType[t.id] ? <NameLink {...linkTo(placeOfType[t.id]!)}>{typeCount(t.id, t.count)}</NameLink> : <span>{typeCount(t.id, t.count)}</span>}
                    {t.description && <small>{t.description}</small>}
                  </li>
                ))}
            </ul>
            <h3 className="noti-h">Relations</h3>
            <ul className="noti-tally">
              {s.relations.map((r) => (
                <li key={r.id}>
                  <span>
                    {r.id.replace(/_/g, " ")} <b className="tnum">{r.count}</b>
                  </span>
                  {r.description && <small>{r.description}</small>}
                </li>
              ))}
            </ul>
            {s.statuses.length > 0 && (
              <>
                <h3 className="noti-h">Statuses</h3>
                <ul className="noti-statuses">
                  {s.statuses.map((st) => (
                    <li key={st.id}>
                      <a className={`status ${st.id}`} {...anchor(linkTo({ kind: "projects" }))}>
                        {statusWord(st.id)}
                      </a>
                      <b className="tnum">{st.count}</b>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
        {ont && (
          <p className="noti-src">
            Read from{" "}
            <NameLink {...linkTo({ kind: "notes", path: notePath(ont.path) })}>{ont.title}</NameLink>, the note tagged <code>#vault-ontology</code>.
          </p>
        )}
      </Module>
    </aside>
  );
}
