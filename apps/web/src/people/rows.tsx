/**
 * People's rows (the board's `.row.pp`): a ring for a person, a square for a company, the name,
 * one line — "Role · Company", then the relation that speaks for them — and, at the end, the
 * newest note that mentions them. The whole row opens them; every name inside it opens its own
 * thing (§1.7 #1), without opening the row.
 */
import { type MouseEvent, type ReactNode } from "react";
import type { Company, Contact } from "@basalt/schema/responses";
import { Row } from "../ui/layout.js";
import { Ring, Square } from "../ui/controls.js";
import { HeadMark } from "../ui/orr/Orr.js";
import { dayMonthLabel, toDate } from "../ui/dates.js";
import { navigate, routeHref, type Route } from "../ui/router.js";
import { keyRelation, linkText, type Brief, type Entry } from "./model.js";

const plainClick = (e: MouseEvent) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

/** A name inside a row: a link of its own, so it never opens the row it sits in. */
export function Name({ to, children }: { to: Route | null; children: ReactNode }) {
  if (!to) return <>{children}</>;
  return (
    <a
      className="ui-nm"
      href={routeHref(to)}
      onClick={(e) => {
        e.stopPropagation();
        if (!plainClick(e)) return;
        e.preventDefault();
        navigate(to);
      }}
      onKeyDown={(e) => e.stopPropagation()}
    >
      {children}
    </a>
  );
}

/** "Today", "Yesterday", else "25 Sep" (with the year when it is not this one). */
export function whenLabel(at: string, now = new Date()): string {
  const d = toDate(at);
  if (!d) return "";
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86_400_000);
  return diff === 0 ? "Today" : diff === 1 ? "Yesterday" : dayMonthLabel(d, now);
}

/** Where a related thing lives: a person's or company's page, a project, else the note. */
export type RouteOf = (b: Brief) => Route;

function Relation({ entry, kind, routeOf, after }: { entry: Entry | undefined; kind: "person" | "company"; routeOf: RouteOf; after: boolean }) {
  const r = keyRelation(entry, kind);
  if (!r) return null;
  return (
    <em>
      {after && " · "}
      {r.phrase} <Name to={routeOf(r.first)}>{r.first.title}</Name>
      {r.more > 0 && ` and ${r.more} more`}
    </em>
  );
}

function Mention({ entry }: { entry: Entry | undefined }) {
  const m = entry?.mention;
  if (!m) return null;
  return (
    <>
      <b>{whenLabel(m.at)}</b>
      <Name to={{ kind: "notes", id: m.id }}>{m.title}</Name>
    </>
  );
}

export function PersonRow({
  person,
  company,
  entry,
  routeOf,
  letter,
}: {
  person: Contact & { slug: string };
  /** The company note their `company:` names, when there is one. */
  company: { route: Route } | null;
  entry: Entry | undefined;
  routeOf: RouteOf;
  /** The first row of a letter carries it, for the phone's A–Z rail. */
  letter?: string;
}) {
  const at = linkText(person.company);
  const to: Route = { kind: "person", slug: person.slug };
  return (
    <div className="pp-wrap" data-letter={letter}>
      <Row
        className="pp"
        lead={<Ring name={person.name} />}
        title={
          <>
            {person.name}
            {person.personal && <span className="pp-private">private</span>}
          </>
        }
        titleAttr={person.name}
        meta={
          <span className="rl">
            {person.role}
            {person.role && at && " · "}
            {at && <Name to={company?.route ?? null}>{at}</Name>}
            <Relation entry={entry} kind="person" routeOf={routeOf} after={!!(person.role || at)} />
          </span>
        }
        trailing={entry?.mention ? <Mention entry={entry} /> : undefined}
        onOpen={() => navigate(to)}
      />
    </div>
  );
}

export function CompanyRow({ company, entry, routeOf, letter }: { company: Company & { slug: string }; entry: Entry | undefined; routeOf: RouteOf; letter?: string }) {
  return (
    <div className="pp-wrap" data-letter={letter}>
      <Row
        className="pp"
        lead={<Square name={company.name} />}
        title={
          <>
            {company.name}
            {company.personal && <span className="pp-private">private</span>}
          </>
        }
        titleAttr={company.name}
        meta={
          <span className="rl">
            {company.description || company.location}
            <Relation entry={entry} kind="company" routeOf={routeOf} after={!!(company.description || company.location)} />
          </span>
        }
        trailing={entry?.mention ? <Mention entry={entry} /> : undefined}
        onOpen={() => navigate({ kind: "company", slug: company.slug })}
      />
    </div>
  );
}

/**
 * A company people work at that has no note yet: Orr's warning, as on the board — "No note
 * yet: Pieter Bakker works here", and the row creates it.
 */
export function GhostRow({ name, people, onCreate, personRoute, letter }: { name: string; people: Contact[]; onCreate: () => void; personRoute: (c: Contact) => Route; letter?: string }) {
  const first = people[0]!;
  return (
    <div className="pp-wrap" data-letter={letter}>
      <Row
        className="pp warn"
        lead={<Square name={name} />}
        title={name}
        titleAttr={`${name}: no note yet`}
        meta={
          <span className="rl orrw">
            <HeadMark size={14} />
            <span>
              No note yet: <Name to={personRoute(first)}>{first.name}</Name>
              {people.length > 1 ? ` and ${people.length - 1} more work here` : " works here"}
            </span>
          </span>
        }
        trailing={
          <>
            <b>Create it</b>from what you know
          </>
        }
        onOpen={onCreate}
      />
    </div>
  );
}
