/**
 * The entity page (structure.md §2.6, board mockups/screens/notes-entity.html): one page shape
 * for a person, a company, a conversation and a document, at their addresses (`/people/<slug>`,
 * `/companies/<slug>`, `/conversations/<slug>`, `/documents/<path>`). Header; then facts, the
 * relations in words (both directions), how you know someone, what is going on with them; then
 * the note. Orr's warnings about this one thing sit at the top of the side, as his work.
 *
 * Built on R8's pieces (EntityHeader, useRelations) and the shared lists (`useKnown`). On a vault
 * without an ontology note the graph has nothing typed: relations become the plain links the
 * note has, and the blocks that would be empty are not drawn.
 */
import { useMemo, useRef, useState } from "react";
import type { Company, Contact, ContactProject, GraphPath, PeopleContext } from "@orrama/schema/responses";
import { api, type Me } from "../api.js";
import { trashNoteWithUndo, type Moved } from "../noteActions.js";
import { RenameNoteDialog } from "../notes/actions.js";
import { CompanyEdit } from "../people/CompanyEdit.js";
import { companyFor, linkText, peopleAt, sectorsIn } from "../people/model.js";
import { PersonEdit } from "../people/PersonEdit.js";
import { ProjectPicker, WorksAtDialog } from "../people/pickers.js";
import { slugOf as orrerySlug } from "../orrery/model.js";
import { Button, LinkButton, NameLink, Ring, Square } from "../ui/controls.js";
import { dateLabel } from "../ui/dates.js";
import { Row, RowList } from "../ui/layout.js";
import { Menu, Sheet, toast } from "../ui/overlays.js";
import { navigate, routeHref, type Route } from "../ui/router.js";
import { attempt } from "../ui/writes.js";
import { Notice, Skeleton } from "../ui/states.js";
import { ActivityModule, useActivitySources, type Who } from "./activity.js";
import { ConversationPage } from "./ConversationPage.js";
import { Missing, WarningsBox, orreryRoute, plainLinks } from "./shared.js";
import { DocumentPage } from "./DocumentPage.js";
import { EntityHeader } from "./EntityHeader.js";
import { useKnown, useLoad, useNotesTick, type KnownData, type Load } from "./known.js";
import { anchor, bySlug, linkTo, notePath, type Known } from "./links.js";
import { companyDomains, documentAt, pathWorthSaying, relationGroups, worksWith, youOf } from "./model.js";
import { usePageTitle } from "./title.js";
import { Facts, Mark, NoteBlock, PathBlock, RelationsBlock, useAreaColor, useHref, useNote, type FactItem } from "./parts.js";
import { useRelations } from "./relations.js";

export type EntityRoute = Extract<Route, { kind: "person" | "company" | "conversation" | "document" }>;

/** The name of what an address shows, once the lists are in. */
export function titleFor(route: EntityRoute, data: KnownData | null, known: Known | null): string | null {
  if (!data || !known) return null;
  switch (route.kind) {
    case "person":
      return bySlug(data.contacts, route.slug)?.name ?? null;
    case "company":
      return bySlug(data.companies, route.slug)?.name ?? null;
    case "conversation":
      return bySlug(data.tree.filter((n) => known.conversations.has(n.id)), route.slug)?.title ?? null;
    case "document": {
      const at = documentAt(route.path);
      return at.kind === "note" ? (data.tree.find((n) => n.path === at.path)?.title ?? null) : at.name;
    }
  }
}

export function EntityPage({ me, route }: { me: Me; route: EntityRoute }) {
  const { data, known, failed, reload } = useKnown();
  usePageTitle(routeHref(route), titleFor(route, data, known));
  if (!data || !known) {
    return (
      <div className="ui ent-page">
        {failed ? <Notice title="This page didn't load." text="Your notes are fine. Try again in a moment." actions={<Button size="sm" onClick={() => void reload()}>Try again</Button>} /> : <Skeleton rows={6} />}
      </div>
    );
  }
  switch (route.kind) {
    case "person": {
      const p = bySlug(data.contacts, route.slug);
      return p ? <PersonPage key={p.id} me={me} person={p} data={data} known={known} onChanged={reload} /> : <Missing what="person" />;
    }
    case "company": {
      const c = bySlug(data.companies, route.slug);
      return c ? <CompanyPage key={c.id} me={me} company={c} data={data} known={known} onChanged={reload} /> : <Missing what="company" />;
    }
    case "conversation": {
      const talks = data.tree.filter((n) => known.conversations.has(n.id));
      const c = bySlug(talks, route.slug);
      return c ? <ConversationPage key={c.id} me={me} note={c} data={data} known={known} /> : <Missing what="conversation" />;
    }
    case "document":
      return <DocumentPage key={route.path} me={me} path={route.path} data={data} known={known} />;
  }
}

const href = (url: string) => `https://${url.replace(/^https?:\/\//, "")}`;
const bare = (url: string) => url.replace(/^https?:\/\//, "").replace(/\/$/, "");

/** Who a page is about, in the words a title would use: "Ines" for "Ines Vermaat". */
const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

/* ---- a person ----------------------------------------------------------------------------- */

function PersonPage({ me, person, data, known, onChanged }: { me: Me; person: Contact; data: KnownData; known: Known; onChanged: () => void }) {
  const [tick, bump] = useNotesTick();
  const refresh = () => {
    bump();
    onChanged();
  };
  const [editing, setEditing] = useState(false);
  const [placing, setPlacing] = useState(false);
  const rel = useRelations(person.id, tick);
  const { note, sync, state } = useNote(person.id);
  const ctx = useLoad((signal) => api<PeopleContext>("GET", "/api/people/context", undefined, { signal }), [tick]);
  const you = youOf(data.contacts, me);
  const path = useLoad(
    you && you.id !== person.id ? (signal) => api<GraphPath>("GET", `/api/graph/path?from=${encodeURIComponent(you.id)}&to=${encodeURIComponent(person.id)}`, undefined, { signal }) : null,
    [tick, you?.id, person.id],
  );
  const sources = useActivitySources(tick);
  const hrefOf = useHref(data, known);
  const colorOf = useAreaColor(data);

  const company = companyFor(person, data.companies);
  const at = company?.name ?? linkText(person.company);
  const entry = ctx.state === "ok" ? ctx.data.entries.find((e) => e.id === person.id) : undefined;
  const titles = useMemo(() => new Map(data.contacts.map((c) => [c.id, c.name])), [data.contacts]);
  const projects = useLoad((signal) => api<ContactProject[]>("GET", `/api/contacts/${person.id}/projects`, undefined, { signal }), [tick, person.id]);
  // Where they work and their projects have their own controls above: the words below say the
  // rest, never those again (a project's `## People` link reads as a mention too).
  const shown = new Set([...(projects.state === "ok" ? projects.data.map((p) => p.id) : []), ...(company ? [company.id] : [])]);
  const said = new Map([...rel.by].filter(([r]) => !OWN_CONTROLS.has(r)));
  const { mentions, links } = plainLinks(note, data, known);
  const groups = relationGroups({
    relations: said,
    mentions: mentions.filter((b) => !shown.has(b.id)),
    links: links.filter((b) => !shown.has(b.id)),
    worksWith: ctx.state === "ok" ? worksWith(person.id, ctx.data.entries, (id) => titles.get(id)) : [],
  });
  const plain = rel.by.size === 0;
  const steps = path.state === "ok" && path.data.found ? path.data.paths[0] : undefined;
  const who: Who = { names: [person.name], addresses: person.email ? [person.email] : [], domains: new Set() };
  const companyRoute: Route | null = company ? { kind: "company", slug: slugOfPath(company.path) } : null;
  const canEdit = note?.canEdit ?? false;

  const facts: FactItem[] = [];
  facts.push({
    k: "Works at",
    v: (
      <span className="ent-wa">
        {companyRoute ? <NameLink {...linkTo(companyRoute)}>{company!.name}</NameLink> : at ? <b>{at}</b> : null}
        {canEdit && (
          <button type="button" className="ent-link ent-change" onClick={() => setPlacing(true)} aria-label={at ? `Change where ${firstName(person.name)} works` : undefined}>
            {at ? "Change" : "Add where they work"}
          </button>
        )}
      </span>
    ),
  });
  if (person.role) facts.push({ k: "Role", v: <b>{person.role}</b> });
  if (person.email) facts.push({ k: "Email", v: <a className="ent-v" href={`mailto:${person.email}`}>{person.email}</a> });
  if (person.phone) facts.push({ k: "Phone", v: <a className="ent-v" href={`tel:${person.phone.replace(/\s/g, "")}`}>{person.phone}</a> });
  if (person.linkedin) facts.push({ k: "LinkedIn", v: <a className="ent-v" href={href(person.linkedin)} target="_blank" rel="noreferrer">{bare(person.linkedin)}</a> });
  if (entry?.mention) facts.push({ k: "Last in touch", v: <NameLink {...linkTo({ kind: "notes", id: entry.mention.id })}>{dateLabel(entry.mention.at)}</NameLink> });
  facts.push({ k: "Sector", v: <b>{person.sector}</b> });

  return (
    <div className="ui ent-page ent-person">
      <EntityHeader
        crumbs={[{ label: "People", ...linkTo({ kind: "people" }) }, { label: person.name }]}
        lead={<Ring name={person.name} />}
        title={person.name}
        meta={
          (person.role || at) && (
            <span className="ent-sub">
              {person.role || "Works"}
              {at && (
                <>
                  {" at "}
                  {companyRoute ? <NameLink {...linkTo(companyRoute)}>{company!.name}</NameLink> : at}
                </>
              )}
            </span>
          )
        }
        actions={
          <>
            {person.email && (
              <LinkButton className="ent-wide" icon="mail" href={`mailto:${person.email}`}>
                Email
              </LinkButton>
            )}
            {canEdit && (
              <Button className="ent-wide" icon="pen" onClick={() => setEditing(true)}>
                Edit
              </Button>
            )}
            <LinkButton className="ent-wide" icon="orbit" {...anchor(linkTo(orreryRoute(person.path)))}>
              Show in the Orrery
            </LinkButton>
            <LinkButton icon="notes" aria-label="Open the note" data-tip="Open the note" {...anchor(linkTo({ kind: "notes", path: notePath(person.path) }))} />
            {canEdit && <NoteMenu item={person} sync={sync} route={(p) => ({ kind: "person", slug: slugOfPath(p) })} onChanged={refresh} />}
          </>
        }
      />
      <div className="ent-pacts">
        {person.email && (
          <LinkButton icon="mail" href={`mailto:${person.email}`}>
            Email
          </LinkButton>
        )}
        {canEdit && (
          <Button icon="pen" onClick={() => setEditing(true)}>
            Edit
          </Button>
        )}
        <LinkButton icon="notes" {...anchor(linkTo({ kind: "notes", path: notePath(person.path) }))}>
          Note
        </LinkButton>
        {canEdit && <NoteMenu item={person} sync={sync} route={(p) => ({ kind: "person", slug: slugOfPath(p) })} onChanged={refresh} />}
      </div>
      <div className="ent-cols">
        <div className="ent-main">
          <Facts items={facts} />
          <ProjectsBlock person={person} list={projects} canEdit={canEdit} colorOf={colorOf} onChanged={refresh} />
          <RelationsBlock title={`How ${firstName(person.name)} relates`} groups={groups} hrefOf={hrefOf} colorOf={colorOf} plain={plain} />
          {steps && pathWorthSaying(steps) && <PathBlock name={person.name} steps={steps} hrefOf={hrefOf} colorOf={colorOf} />}
        </div>
        <aside className="ent-side">
          <WarningsBox me={me} id={person.id} tick={tick} known={known} onFixed={refresh} />
          <ActivityModule title={`With ${firstName(person.name)}`} sources={sources} who={who} onChanged={bump} />
        </aside>
        <div className="ent-notecol">
          <NoteBlock title="The note" note={note} sync={sync} state={state} data={data} known={known} />
        </div>
      </div>
      {editing && (
        <Sheet title={`Edit ${person.name}`} onClose={() => setEditing(false)} className="ent-edit">
          <PersonEdit person={person} sectors={sectorsIn([data.contacts, data.companies])} onDone={() => setEditing(false)} onSaved={refresh} />
        </Sheet>
      )}
      {placing && <WorksAtDialog person={person} companies={data.companies} onClose={() => setPlacing(false)} onSaved={refresh} />}
    </div>
  );
}

const slugOfPath = (path: string) => orrerySlug(path);

/** The relations the person's page changes with its own controls, not said again in words. */
const OWN_CONTROLS = new Set(["works_at", "supervises", "involved_in"]);

/**
 * A person's projects (1F): what they supervise and the projects they are in, each opening the
 * project, with a ⋯ that takes them off it; and the two ways to add one, picked from the list.
 * Read from the notes (`GET /api/contacts/:id/projects`), so it holds without an ontology.
 */
function ProjectsBlock({ person, list, canEdit, colorOf, onChanged }: { person: Contact; list: Load<ContactProject[]>; canEdit: boolean; colorOf: (id: string) => string; onChanged: () => void }) {
  const [adding, setAdding] = useState<ContactProject["relation"] | null>(null);
  const rows = list.state === "ok" ? list.data : [];
  const name = firstName(person.name);
  const add = (relation: ContactProject["relation"], p: { noteId: string | null; slug: string; name: string }) =>
    (relation === "supervises" ? api("POST", `/api/contacts/${person.id}/supervises`, { projectId: p.noteId }) : api("POST", `/api/projects/${encodeURIComponent(p.slug)}/people`, { noteId: person.id })).then(() => {
      toast(relation === "supervises" ? `${name} supervises ${p.name} now.` : `${name} is in ${p.name} now.`);
      onChanged();
    });
  const remove = (p: ContactProject) =>
    void attempt(`${person.name} wasn't taken off ${p.title}.`, async () => {
      await (p.relation === "supervises" ? api("DELETE", `/api/contacts/${person.id}/supervises/${p.id}`) : api("DELETE", `/api/projects/${encodeURIComponent(p.slug)}/people/${person.id}`));
      onChanged();
      toast(p.relation === "supervises" ? `${name} no longer supervises ${p.title}.` : `${name} is off ${p.title}.`, {
        ms: 8000,
        action: { label: "Undo", run: () => void attempt("It wasn't put back.", () => add(p.relation, { noteId: p.id, slug: p.slug, name: p.title })) },
      });
    });
  if (rows.length === 0 && !canEdit) return null;
  return (
    <section className="ent-block ent-projects" aria-label="Projects">
      <h2>Projects</h2>
      {rows.length > 0 && (
        <RowList label="Projects">
          {rows.map((p) => (
            <ProjectRow key={`${p.relation}:${p.id}`} p={p} color={colorOf(p.id)} onRemove={canEdit ? () => remove(p) : undefined} removeLabel={p.relation === "supervises" ? "No longer supervises" : "Take off this project"} />
          ))}
        </RowList>
      )}
      {rows.length === 0 && list.state === "ok" && <p className="q3 ent-none">Not on a project yet.</p>}
      {canEdit && (
        <div className="ent-adds">
          <Button size="sm" kind="quiet" icon="plus" onClick={() => setAdding("involved")}>
            Add to a project
          </Button>
          <Button size="sm" kind="quiet" icon="plus" onClick={() => setAdding("supervises")}>
            Supervises a project
          </Button>
        </div>
      )}
      {adding && (
        <ProjectPicker
          title={adding === "supervises" ? `What does ${name} supervise?` : `Which project is ${name} in?`}
          taken={new Set(rows.filter((r) => r.relation === adding).map((r) => r.id))}
          pick={(p) => add(adding, p)}
          onClose={() => setAdding(null)}
        />
      )}
    </section>
  );
}

/** One project on a person's page: the row opens it; the ⋯ beside it (never inside) takes them off. */
function ProjectRow({ p, color, onRemove, removeLabel }: { p: ContactProject; color: string; onRemove?: () => void; removeLabel: string }) {
  const [menu, setMenu] = useState(false);
  const at = useRef<HTMLButtonElement>(null);
  return (
    <div className={`ent-proj${onRemove ? " has-act" : ""}${menu ? " open" : ""}`}>
      <Row className="ent-rel" lead={<Mark b={{ id: p.id, title: p.title, type: "project" }} color={color} />} title={p.title} trailing={p.relation === "supervises" ? "supervises" : "involved"} {...linkTo({ kind: "project", slug: p.slug })} />
      {onRemove && (
        <>
          <Button ref={at} kind="quiet" size="sm" icon="dots" className="ent-proj-act" aria-label={`More for ${p.title}`} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((v) => !v)} />
          {menu && <Menu anchor={at} align="end" label={p.title} onClose={() => setMenu(false)} items={[{ label: removeLabel, danger: true, onSelect: onRemove }]} />}
        </>
      )}
    </div>
  );
}

/**
 * The page's ⋯ for a person or a company: Rename (the file, its title line and the links that
 * name it follow, 1C's dialog) and Move to the trash (Undo in the toast brings it back). Typing
 * in the note is saved first, so neither loses a word.
 */
function NoteMenu({ item, sync, route, onChanged }: { item: { id: string; name: string; path: string }; sync: { flush: () => Promise<void> } | null; route: (path: string) => Route; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const more = useRef<HTMLButtonElement>(null);
  const moved = (m: Moved) => {
    onChanged();
    navigate(route(m.path), { replace: true });
  };
  const trash = async () => {
    await sync?.flush().catch(() => {});
    await trashNoteWithUndo(item.path, item.name, {
      after: () => navigate({ kind: "people" }),
      restored: () => navigate(route(item.path)),
    });
  };
  return (
    <>
      <Button ref={more} kind="quiet" icon="dots" aria-label={`More for ${item.name}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)} />
      {open && (
        <Menu
          anchor={more}
          align="end"
          label={item.name}
          onClose={() => setOpen(false)}
          items={[
            { label: "Rename…", onSelect: () => void (sync?.flush() ?? Promise.resolve()).catch(() => {}).finally(() => setRenaming(true)) },
            "-",
            { label: "Move to the trash", danger: true, onSelect: () => void trash() },
          ]}
        />
      )}
      {renaming && <RenameNoteDialog note={{ id: item.id, path: item.path }} onDone={moved} onClose={() => setRenaming(false)} />}
    </>
  );
}

/* ---- a company ---------------------------------------------------------------------------- */

function CompanyPage({ me, company, data, known, onChanged }: { me: Me; company: Company; data: KnownData; known: Known; onChanged: () => void }) {
  const [tick, bump] = useNotesTick();
  const refresh = () => {
    bump();
    onChanged();
  };
  const [editing, setEditing] = useState(false);
  const rel = useRelations(company.id, tick);
  const { note, sync, state } = useNote(company.id);
  const sources = useActivitySources(tick);
  const hrefOf = useHref(data, known);
  const colorOf = useAreaColor(data);

  // People whose `company:` names this one, as People has always read it (R9): with or without
  // the ontology, so an untyped vault still lists who works here.
  const here = peopleAt(company, data.contacts);
  const relations = new Map(rel.by);
  const employs = new Map((relations.get("employs") ?? []).map((b) => [b.id, b]));
  for (const p of here) if (!employs.has(p.id)) employs.set(p.id, { id: p.id, title: p.name, type: "person" });
  if (employs.size) relations.set("employs", [...employs.values()].sort((a, b) => a.title.localeCompare(b.title)));
  const { mentions, links } = plainLinks(note, data, known);
  const groups = relationGroups({ relations, mentions, links: rel.by.size ? [] : links });
  const who: Who = { names: [company.name], addresses: [], domains: companyDomains(company, here) };

  const facts: FactItem[] = [];
  if (company.sector) facts.push({ k: "Sector", v: <b>{company.sector}</b> });
  if (company.location) facts.push({ k: "Location", v: <b>{company.location}</b> });
  if (company.website) facts.push({ k: "Website", v: <a className="ent-v" href={href(company.website)} target="_blank" rel="noreferrer">{bare(company.website)}</a> });
  if (company.linkedin) facts.push({ k: "LinkedIn", v: <a className="ent-v" href={href(company.linkedin)} target="_blank" rel="noreferrer">{bare(company.linkedin)}</a> });
  if (company.careers) facts.push({ k: "Jobs page", v: <a className="ent-v" href={href(company.careers)} target="_blank" rel="noreferrer">{bare(company.careers)}</a> });
  if (company.positions.length) facts.push({ k: "Positions seen", v: <b>{company.positions.join(", ")}</b> });

  return (
    <div className="ui ent-page ent-company">
      <EntityHeader
        crumbs={[{ label: "People", ...linkTo({ kind: "people" }) }, { label: company.name }]}
        lead={<Square name={company.name} />}
        title={company.name}
        meta={company.description ? <span className="ent-sub">{company.description}</span> : company.sector ? <span className="ent-sub">{company.sector}</span> : undefined}
        actions={
          <>
            <Button className="ent-wide" icon="pen" onClick={() => setEditing(true)}>
              Edit
            </Button>
            <LinkButton className="ent-wide" icon="orbit" {...anchor(linkTo(orreryRoute(company.path)))}>
              Show in the Orrery
            </LinkButton>
            <LinkButton icon="notes" aria-label="Open the note" data-tip="Open the note" {...anchor(linkTo({ kind: "notes", path: notePath(company.path) }))} />
            {note?.canEdit && <NoteMenu item={company} sync={sync} route={(p) => ({ kind: "company", slug: slugOfPath(p) })} onChanged={refresh} />}
          </>
        }
      />
      <div className="ent-pacts">
        <Button icon="pen" onClick={() => setEditing(true)}>
          Edit
        </Button>
        <LinkButton icon="notes" {...anchor(linkTo({ kind: "notes", path: notePath(company.path) }))}>
          Note
        </LinkButton>
        {note?.canEdit && <NoteMenu item={company} sync={sync} route={(p) => ({ kind: "company", slug: slugOfPath(p) })} onChanged={refresh} />}
      </div>
      <div className="ent-cols">
        <div className="ent-main">
          <Facts items={facts} />
          <RelationsBlock title={`How ${company.name} relates`} groups={groups} hrefOf={hrefOf} colorOf={colorOf} plain={rel.by.size === 0} />
        </div>
        <aside className="ent-side">
          <WarningsBox me={me} id={company.id} tick={tick} known={known} onFixed={refresh} />
          <ActivityModule title={`With ${company.name}`} sources={sources} who={who} onChanged={bump} />
        </aside>
        <div className="ent-notecol">
          <NoteBlock title="The note" note={note} sync={sync} state={state} data={data} known={known} />
        </div>
      </div>
      {editing && (
        <Sheet title={`Edit ${company.name}`} onClose={() => setEditing(false)} className="ent-edit">
          <CompanyEdit company={company} onDone={() => setEditing(false)} onSaved={refresh} />
        </Sheet>
      )}
    </div>
  );
}
