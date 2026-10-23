/**
 * People (was Contacts; structure.md §2.7, boards mockups/screens/people.html): an index of the
 * people and companies you know, side by side under one search and one sector select. Each row
 * is a person (a ring) or a company (a square), "Role · Company" and the relation that speaks for
 * them, and the newest note that mentions them; it opens them at their address. On the phone it
 * is one list with a People / Companies switch and the A–Z rail (§8 #8: the rail is phone-only).
 *
 * People are notes tagged #contact and companies notes tagged #company (`/api/contacts`,
 * `/api/companies`); the line and the mention come from `/api/people/context`, which is plain
 * on a vault without an ontology. Search and the sector are in the address (`?q=`, `&sector=`).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Company, Contact, PeopleContext, ProjectRow } from "@orrama/schema/responses";
import { api, isAbort, type Me } from "../api.js";
import { onWs } from "../ws.js";
import { Button, Segmented, Tabs } from "../ui/controls.js";
import { SearchField, Select } from "../ui/fields.js";
import { Group, RowList } from "../ui/layout.js";
import { Menu } from "../ui/overlays.js";
import { EmptyState, Notice, Skeleton } from "../ui/states.js";
import { navigate, useRoute, type Route } from "../ui/router.js";
import { readKey, writeKey } from "../storage.js";
import {
  byName,
  byRecent,
  companiesWithoutNote,
  companyFor,
  companyName,
  groupsOf,
  letterOf,
  matches,
  sameSector,
  sectorsIn,
  slugOf,
  type Brief,
  type Entry,
} from "./model.js";
import { NewCompany, NewPerson } from "./NewDialogs.js";
import { CompanyRow, GhostRow, PersonRow } from "./rows.js";

type Person = Contact & { slug: string };
type Firm = Company & { slug: string };
type Sort = "az" | "recent";
type Show = "people" | "companies";

const SORT_KEY = "orrama-people-sort";
const SHOW_KEY = "orrama-people-show";
const LETTERS = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ", "#"];

interface Data {
  contacts: Contact[];
  companies: Company[];
  context: PeopleContext;
  projects: ProjectRow[];
}

function useData() {
  const [data, setData] = useState<Data | null>(null);
  const [failed, setFailed] = useState(false);
  const ctl = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    ctl.current?.abort();
    const c = (ctl.current = new AbortController());
    const opts = { signal: c.signal };
    try {
      const [contacts, companies, context, projects] = await Promise.all([
        api<Contact[]>("GET", "/api/contacts", undefined, opts),
        api<Company[]>("GET", "/api/companies", undefined, opts),
        api<PeopleContext>("GET", "/api/people/context", undefined, opts),
        api<ProjectRow[]>("GET", "/api/projects", undefined, opts),
      ]);
      setData({ contacts, companies, context, projects });
      setFailed(false);
    } catch (e) {
      if (!isAbort(e)) setFailed(true);
    }
  }, []);
  useEffect(() => {
    void load();
    let timer: ReturnType<typeof setTimeout>;
    const off = onWs((msg) => {
      if (msg.type !== "note-changed") return;
      clearTimeout(timer);
      timer = setTimeout(() => void load(), 500);
    });
    return () => {
      off();
      clearTimeout(timer);
      ctl.current?.abort();
    };
  }, [load]);
  return { data, failed, load };
}

export function People({ me, onAsk }: { me: Me; onAsk?: () => void }) {
  const route = useRoute();
  const { data, failed, load } = useData();
  const listRoute = route?.kind === "people" ? route : null;

  // The search and the sector live in the address; while a person is open they stay as they were.
  const [q, setQ] = useState(listRoute?.q ?? "");
  const [sector, setSector] = useState(listRoute?.sector ?? "");
  useEffect(() => {
    if (!listRoute) return;
    setQ(listRoute.q ?? "");
    setSector(listRoute.sector ?? "");
  }, [listRoute]);
  const listAddress = useCallback((next: { q?: string; sector?: string }): Route => {
    const r: Route = { kind: "people" };
    if (next.q?.trim()) r.q = next.q;
    if (next.sector) r.sector = next.sector;
    return r;
  }, []);
  const setFilter = (next: { q?: string; sector?: string }) => {
    const merged = { q, sector, ...next };
    setQ(merged.q);
    setSector(merged.sector);
    navigate(listAddress(merged), { replace: true });
  };

  const [sort, setSortState] = useState<{ people: Sort; companies: Sort }>(() => {
    const s = readKey(SORT_KEY);
    return { people: s?.startsWith("recent") ? "recent" : "az", companies: s?.endsWith(":recent") ? "recent" : "az" };
  });
  const setSort = (which: Show, to: Sort) => {
    const next = { ...sort, [which]: to };
    setSortState(next);
    writeKey(SORT_KEY, `${next.people}:${next.companies}`);
  };
  const [show, setShowState] = useState<Show>(() => (readKey(SHOW_KEY) === "companies" ? "companies" : "people"));
  const setShow = (s: Show) => {
    setShowState(s);
    writeKey(SHOW_KEY, s);
  };

  const [adding, setAdding] = useState<null | { kind: "person" } | { kind: "company"; name?: string }>(null);
  const [newMenu, setNewMenu] = useState(false);
  const newBtn = useRef<HTMLButtonElement>(null);
  const [sectorMenu, setSectorMenu] = useState(false);
  const sectorBtn = useRef<HTMLButtonElement>(null);

  /* ---- the lists, as the page shows them ---- */
  const people: Person[] = useMemo(() => (data ? data.contacts.map((c) => ({ ...c, slug: slugOf(c.path) })) : []), [data]);
  const firms: Firm[] = useMemo(() => (data ? data.companies.map((c) => ({ ...c, slug: slugOf(c.path) })) : []), [data]);
  const entries = useMemo(() => new Map((data?.context.entries ?? []).map((e) => [e.id, e])), [data]);
  const sectors = useMemo(() => sectorsIn([people, firms]), [people, firms]);

  const projectSlug = useMemo(() => new Map((data?.projects ?? []).filter((p) => p.noteId).map((p) => [p.noteId!, p.slug])), [data]);
  const personOf = useMemo(() => new Map(people.map((p) => [p.id, p])), [people]);
  const firmOf = useMemo(() => new Map(firms.map((f) => [f.id, f])), [firms]);
  /** Where a related thing opens: a person's or company's page, a project, else its note. */
  const routeOf = useCallback(
    (b: Brief): Route => {
      const p = personOf.get(b.id);
      if (p) return { kind: "person", slug: p.slug };
      const f = firmOf.get(b.id);
      if (f) return { kind: "company", slug: f.slug };
      const slug = projectSlug.get(b.id);
      if (slug) return { kind: "project", slug };
      return { kind: "notes", id: b.id };
    },
    [personOf, firmOf, projectSlug],
  );
  const companyOf = useCallback(
    (p: Contact) => {
      const c = companyFor(p, firms);
      return c ? { name: c.name, route: { kind: "company", slug: (c as Firm).slug } as Route } : null;
    },
    [firms],
  );
  const relatedTitles = (id: string) => (entries.get(id)?.relations ?? []).flatMap((r) => r.to.map((t) => t.title));
  const at = (id: string) => entries.get(id)?.mention?.at;

  const shownPeople = useMemo(() => {
    const list = people.filter((p) => (!sector || sameSector(p.sector, sector)) && matches(q, [p.name, p.role, companyName(p, firms), p.sector, p.email, ...relatedTitles(p.id)]));
    return sort.people === "recent" ? byRecent(list, (p) => p.name, (p) => at(p.id)) : byName(list, (p) => p.name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [people, firms, q, sector, sort.people, entries]);
  const ghosts = useMemo(() => (sector ? [] : companiesWithoutNote(people).filter((g) => matches(q, [g.name, ...g.people.map((p) => p.name)]))), [people, q, sector]);
  const shownFirms = useMemo(() => {
    const list: ({ ghost: false; firm: Firm } | { ghost: true; name: string; people: Contact[] })[] = [
      ...firms.filter((c) => (!sector || sameSector(c.sector, sector)) && matches(q, [c.name, c.description, c.sector, c.location, ...c.positions, ...relatedTitles(c.id)])).map((firm) => ({ ghost: false as const, firm })),
      ...ghosts.map((g) => ({ ghost: true as const, ...g })),
    ];
    const name = (x: (typeof list)[number]) => (x.ghost ? x.name : x.firm.name);
    return sort.companies === "recent" ? byRecent(list, name, (x) => (x.ghost ? undefined : at(x.firm.id))) : byName(list, name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firms, ghosts, q, sector, sort.companies, entries]);

  const total = { people: people.length, companies: firms.length };
  const filtering = !!q.trim() || !!sector;

  const personRows = (list: Person[], grouped: boolean) => {
    const seen = new Set<string>();
    const row = (p: Person) => {
      const l = letterOf(p.name);
      const first = !seen.has(l);
      seen.add(l);
      return <PersonRow key={p.id} person={p} company={companyOf(p)} entry={entries.get(p.id)} routeOf={routeOf} letter={first ? l : undefined} />;
    };
    if (!grouped) return <RowList label="People">{list.map(row)}</RowList>;
    return groupsOf(list, (p) => p.name).map((g) => (
      <div key={g.label} className="pp-grp">
        <Group>{g.label}</Group>
        <RowList label={`People, ${g.label}`}>{g.items.map(row)}</RowList>
      </div>
    ));
  };

  const firmRows = () => {
    const seen = new Set<string>();
    return (
      <RowList label="Companies">
        {shownFirms.map((x) => {
          const name = x.ghost ? x.name : x.firm.name;
          const l = letterOf(name);
          const letter = seen.has(l) ? undefined : l;
          seen.add(l);
          return x.ghost ? (
            <GhostRow key={`ghost:${x.name}`} name={x.name} people={x.people} letter={letter} personRoute={(c) => ({ kind: "person", slug: slugOf(c.path) })} onCreate={() => setAdding({ kind: "company", name: x.name })} />
          ) : (
            <CompanyRow key={x.firm.id} company={x.firm} entry={entries.get(x.firm.id)} routeOf={routeOf} letter={letter} />
          );
        })}
      </RowList>
    );
  };

  const sortControl = (which: Show) => (
    <span className="pp-sort">
      <Segmented
        label={`Sort ${which}`}
        value={sort[which]}
        onChange={(v) => setSort(which, v)}
        items={[
          { id: "az", label: "A–Z" },
          { id: "recent", label: "Recent" },
        ]}
      />
    </span>
  );

  const noMatch = (what: string) => <p className="pp-none">{filtering ? `No ${what} match${what === "person" ? "es" : ""} ${q.trim() ? `"${q.trim()}"` : "this sector"}.` : `No ${what === "person" ? "people" : "companies"} yet.`}</p>;

  const body = () => {
    if (failed && !data)
      return (
        <Notice
          title="Couldn't load People."
          text="The server didn't answer. Everything else keeps working."
          actions={
            <Button size="sm" onClick={() => void load()}>
              Try again
            </Button>
          }
        />
      );
    if (!data)
      return (
        <div className="pp-cols">
          <section className="mod">
            <Skeleton rows={6} label="Loading people" />
          </section>
          <section className="mod">
            <Skeleton rows={4} label="Loading companies" />
          </section>
        </div>
      );
    if (people.length === 0 && firms.length === 0)
      return (
        <section className="mod pp-empty">
          <EmptyState
            pose="wave"
            title="No one here yet"
            text={onAsk ? "Add the first one, or let me find them in your notes." : "Add the first one."}
            actions={
              <>
                <Button kind="solid" icon="plus" onClick={() => setAdding({ kind: "person" })}>
                  Person
                </Button>
                <Button icon="plus" onClick={() => setAdding({ kind: "company" })}>
                  Company
                </Button>
                {onAsk && (
                  <Button orr onClick={onAsk}>
                    Ask Orr
                  </Button>
                )}
              </>
            }
          />
        </section>
      );
    return (
      <div className="pp-cols" data-show={show}>
        <section className="mod pp-people" aria-label="People">
          <div className="mh">
            <h2>People</h2>
            <span className="c">{shownPeople.length}</span>
            {sortControl("people")}
          </div>
          {shownPeople.length === 0 ? noMatch("person") : personRows(shownPeople, sort.people === "az")}
        </section>
        <section className="mod pp-firms" aria-label="Companies">
          <div className="mh">
            <h2>Companies</h2>
            <span className="c">{shownFirms.length - ghosts.length}</span>
            {sortControl("companies")}
          </div>
          {shownFirms.length === 0 ? noMatch("company") : firmRows()}
        </section>
      </div>
    );
  };

  const search = (
    <SearchField
      label="Find a person or a company"
      placeholder="Find a person or a company"
      value={q}
      onChange={(e) => setFilter({ q: e.target.value })}
      onKeyDown={(e) => {
        if (e.key === "Escape" && q) {
          e.stopPropagation();
          setFilter({ q: "" });
        }
      }}
    />
  );

  return (
    <div className="people">
      <header className="phead pp-head">
        <h1>People</h1>
        {data && (
          <span className="meta">
            {total.people} {total.people === 1 ? "person" : "people"} · {total.companies} {total.companies === 1 ? "company" : "companies"}
          </span>
        )}
        <span className="pp-find">{search}</span>
        <Select className="pp-sector" aria-label="Sector" value={sector} onChange={(e) => setFilter({ sector: e.target.value })}>
          <option value="">All sectors</option>
          {sectors.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>
        <span className="sp" />
        <Button icon="plus" onClick={() => setAdding({ kind: "person" })}>
          Person
        </Button>
        <Button icon="plus" onClick={() => setAdding({ kind: "company" })}>
          Company
        </Button>
      </header>

      {/* The phone: one search, the switch, a New button, the A–Z rail. */}
      <div className="pp-phone">
        <div className="pp-find-p">
          {search}
          {sectors.length > 1 && (
            <Button
              ref={sectorBtn}
              icon="filter"
              className={sector ? "on" : undefined}
              aria-label={sector ? `Sector: ${sector}` : "Filter by sector"}
              aria-haspopup="menu"
              aria-expanded={sectorMenu}
              onClick={() => setSectorMenu(true)}
            />
          )}
          <Button ref={newBtn} icon="plus" aria-label="New person or company" aria-haspopup="menu" aria-expanded={newMenu} onClick={() => setNewMenu(true)} />
        </div>
        <Tabs<Show>
          label="Show"
          bare
          value={show}
          onChange={setShow}
          items={[
            { id: "people", label: "People", count: shownPeople.length },
            { id: "companies", label: "Companies", count: shownFirms.length - ghosts.length },
          ]}
        />
      </div>
      {sectorMenu && (
        <Menu
          anchor={sectorBtn}
          label="Sector"
          align="end"
          onClose={() => setSectorMenu(false)}
          items={[{ label: "All sectors", checked: !sector, onSelect: () => setFilter({ sector: "" }) }, "-", ...sectors.map((x) => ({ label: x, checked: sameSector(x, sector), onSelect: () => setFilter({ sector: x }) }))]}
        />
      )}
      {newMenu && (
        <Menu
          anchor={newBtn}
          label="New"
          align="end"
          onClose={() => setNewMenu(false)}
          items={[
            { label: "New person", onSelect: () => setAdding({ kind: "person" }) },
            { label: "New company", onSelect: () => setAdding({ kind: "company" }) },
          ]}
        />
      )}

      <div className="pp-body">
        {body()}
        {data && <AZRail show={show} />}
      </div>

      {adding?.kind === "person" && (
        <NewPerson
          me={me}
          onClose={() => setAdding(null)}
          onSaved={(made) => {
            setAdding(null);
            navigate({ kind: "person", slug: slugOf(made.path) });
          }}
        />
      )}
      {adding?.kind === "company" && (
        <NewCompany
          me={me}
          name={adding.name}
          onClose={() => setAdding(null)}
          onSaved={() => {
            setAdding(null);
            void load();
          }}
        />
      )}

    </div>
  );
}

/**
 * The phone's A–Z rail (§2.7; desktop has none, §8 #8): tap a letter, or drag down the rail, to
 * jump to the first name at or after it in the list on show.
 */
function AZRail({ show }: { show: Show }) {
  const rail = useRef<HTMLDivElement>(null);
  const [scrub, setScrub] = useState<string | null>(null);
  const dragging = useRef(false);
  // The letters the list on show holds, read after each render; set only when they change.
  const [present, setPresent] = useState("");
  const list = () => document.querySelector<HTMLElement>(show === "people" ? ".people .pp-people" : ".people .pp-firms");
  // After every render on purpose: the letters are read from the DOM the list just drew. It
  // settles at once — the state changes only when the letters do.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const now = [...(list()?.querySelectorAll<HTMLElement>("[data-letter]") ?? [])].map((x) => x.dataset.letter!).join("");
    if (now !== present) setPresent(now);
  });
  const jump = (letter: string, smooth: boolean) => {
    const el = list();
    if (!el) return;
    const from = LETTERS.indexOf(letter);
    const rows = [...el.querySelectorAll<HTMLElement>("[data-letter]")];
    const to = rows.find((r) => LETTERS.indexOf(r.dataset.letter!) >= from) ?? rows[rows.length - 1];
    to?.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "start" });
  };
  // Only the letters the list holds, as on the board; a drag maps the finger onto them.
  const letters = LETTERS.filter((l) => present.includes(l));
  const at = (y: number) => {
    const r = rail.current?.getBoundingClientRect();
    if (!r || letters.length === 0) return LETTERS[0]!;
    return letters[Math.max(0, Math.min(letters.length - 1, Math.floor(((y - r.top) / r.height) * letters.length)))]!;
  };
  return (
    <div
      className="pp-az"
      ref={rail}
      role="navigation"
      aria-label="Jump to a letter"
      onPointerDown={(e) => {
        if (e.pointerType === "mouse") return;
        e.currentTarget.setPointerCapture(e.pointerId);
        dragging.current = true;
        setScrub(at(e.clientY));
      }}
      onPointerMove={(e) => {
        if (!dragging.current) return;
        const l = at(e.clientY);
        setScrub(l);
        jump(l, false);
      }}
      onPointerUp={() => {
        dragging.current = false;
        setScrub(null);
      }}
      onPointerCancel={() => {
        dragging.current = false;
        setScrub(null);
      }}
    >
      {letters.map((l) => (
        <button key={l} type="button" className="l" aria-label={`Jump to ${l}`} onClick={() => jump(l, true)}>
          {l}
        </button>
      ))}
      {scrub && (
        <span className="pp-bubble" aria-hidden="true">
          {scrub}
        </span>
      )}
    </div>
  );
}

export type { Entry };
