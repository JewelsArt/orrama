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
import { useMemo, useState } from "react";
import type { Company, Contact, GraphPath, PeopleContext } from "@orrama/schema/responses";
import { api, ApiError, type Me } from "../api.js";
import { CompanyEdit } from "../people/CompanyEdit.js";
import { companyFor, linkText, peopleAt, sameSector } from "../people/model.js";
import { SECTOR_SUGGESTIONS } from "../people/NewDialogs.js";
import { slugOf as orrerySlug } from "../orrery/model.js";
import { Button, LinkButton, NameLink, Ring, Square } from "../ui/controls.js";
import { dateLabel } from "../ui/dates.js";
import { Select } from "../ui/fields.js";
import { Sheet } from "../ui/overlays.js";
import { routeHref, type Route } from "../ui/router.js";
import { Notice, Skeleton } from "../ui/states.js";
import { ActivityModule, useActivitySources, type Who } from "./activity.js";
import { ConversationPage } from "./ConversationPage.js";
import { Missing, WarningsBox, orreryRoute, plainLinks } from "./shared.js";
import { DocumentPage } from "./DocumentPage.js";
import { EntityHeader } from "./EntityHeader.js";
import { useKnown, useLoad, useNotesTick, type KnownData } from "./known.js";
import { anchor, bySlug, linkTo, notePath, type Known } from "./links.js";
import { companyDomains, documentAt, pathWorthSaying, relationGroups, worksWith, youOf } from "./model.js";
import { usePageTitle } from "./title.js";
import { Facts, NoteBlock, PathBlock, RelationsBlock, useAreaColor, useHref, useNote, type FactItem } from "./parts.js";
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
  const at = linkText(person.company);
  const entry = ctx.state === "ok" ? ctx.data.entries.find((e) => e.id === person.id) : undefined;
  const titles = useMemo(() => new Map(data.contacts.map((c) => [c.id, c.name])), [data.contacts]);
  const { mentions, links } = plainLinks(note, data, known);
  const groups = relationGroups({
    relations: rel.by,
    mentions,
    links,
    worksWith: ctx.state === "ok" ? worksWith(person.id, ctx.data.entries, (id) => titles.get(id)) : [],
  });
  const plain = rel.by.size === 0;
  const steps = path.state === "ok" && path.data.found ? path.data.paths[0] : undefined;
  const who: Who = { names: [person.name], addresses: person.email ? [person.email] : [], domains: new Set() };
  const companyRoute: Route | null = company ? { kind: "company", slug: slugOfPath(company.path) } : null;

  const facts: FactItem[] = [];
  if (at) facts.push({ k: "Works at", v: companyRoute ? <NameLink {...linkTo(companyRoute)}>{company!.name}</NameLink> : <b>{at}</b> });
  if (person.role) facts.push({ k: "Role", v: <b>{person.role}</b> });
  if (person.email) facts.push({ k: "Email", v: <a className="ent-v" href={`mailto:${person.email}`}>{person.email}</a> });
  if (person.phone) facts.push({ k: "Phone", v: <a className="ent-v" href={`tel:${person.phone.replace(/\s/g, "")}`}>{person.phone}</a> });
  if (person.linkedin) facts.push({ k: "LinkedIn", v: <a className="ent-v" href={href(person.linkedin)} target="_blank" rel="noreferrer">{bare(person.linkedin)}</a> });
  if (entry?.mention) facts.push({ k: "Last in touch", v: <NameLink {...linkTo({ kind: "notes", id: entry.mention.id })}>{dateLabel(entry.mention.at)}</NameLink> });
  facts.push({ k: "Sector", v: <SectorPick person={person} onChanged={refresh} /> });

  return (
    <div className="ui ent-page ent-person">
      <EntityHeader
        crumbs={[{ label: "People", ...linkTo({ kind: "people" }) }, { label: person.name }]}
        lead={<Ring name={person.name} />}
        title={person.name}
        meta={
          (person.role || at) && (
            <span className="ent-sub">
              {person.role || "Works"} at {companyRoute ? <NameLink {...linkTo(companyRoute)}>{company!.name}</NameLink> : at}
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
            <LinkButton className="ent-wide" icon="orbit" {...anchor(linkTo(orreryRoute(person.path)))}>
              Show in the Orrery
            </LinkButton>
            <LinkButton icon="notes" aria-label="Open the note" data-tip="Open the note" {...anchor(linkTo({ kind: "notes", path: notePath(person.path) }))} />
          </>
        }
      />
      <div className="ent-pacts">
        {person.email && (
          <LinkButton icon="mail" href={`mailto:${person.email}`}>
            Email
          </LinkButton>
        )}
        <LinkButton icon="notes" {...anchor(linkTo({ kind: "notes", path: notePath(person.path) }))}>
          Note
        </LinkButton>
      </div>
      <div className="ent-cols">
        <div className="ent-main">
          <Facts items={facts} />
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
    </div>
  );
}

const slugOfPath = (path: string) => orrerySlug(path);

/** A person's sector, set by the server (WEB-022): the page never edits the note's text. */
function SectorPick({ person, onChanged }: { person: Contact; onChanged: () => void }) {
  const [sector, setSector] = useState(person.sector);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const options = SECTOR_SUGGESTIONS.some((s) => sameSector(s, sector)) ? SECTOR_SUGGESTIONS : [sector, ...SECTOR_SUGGESTIONS];
  const change = async (next: string) => {
    const was = sector;
    setSector(next);
    setBusy(true);
    setFailure(null);
    try {
      await api("PATCH", `/api/contacts/${person.id}`, { sector: next });
      onChanged();
    } catch (e) {
      setSector(was);
      setFailure(e instanceof ApiError && e.status === 409 ? e.message : e instanceof ApiError && e.status === 403 ? "You can read this note but not edit it." : "The server didn't answer. Try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Select className="ent-sector" aria-label="Sector" value={options.find((s) => sameSector(s, sector)) ?? sector} disabled={busy} onChange={(e) => void change(e.target.value)}>
        {options.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </Select>
      {failure && (
        <span className="ent-fail" role="alert">
          Not changed: {failure}
        </span>
      )}
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
