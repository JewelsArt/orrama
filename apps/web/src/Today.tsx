/**
 * Today (structure.md §2.1, was the Dashboard): an overview of what's up, under today's
 * timetable. The header (the date, the week, Plan tomorrow, New), the timetable with Orr at the
 * foot of the now line, then seven modules with an order: Due, Mail, People today, Coming up,
 * Projects, Money, Orr noticed. "Updated …" and Customise at the foot.
 *
 * Every request Today makes is here, so the contract test sees each one; the pieces that draw are
 * in `today/`. Nothing on the page is stored apart from the notes: tasks are checkboxes, the day
 * is the calendar notes, money is the ledgers and statements (CLAUDE.md, "the dashboard is a pure
 * view").
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { addDays, isoLocal } from "@orrama/core/dates";
import type { CalEvent, Company, Contact, DashboardTask, Feed, GraphRelations, GraphSchema, GraphWarnings, HomeData, InboxItem, MailAccount, PendingDraft, ProjectRow } from "@orrama/schema/responses";
import { api, ApiError } from "./api.js";
import { DOMAIN_COLOR } from "./categories.js";
import { New } from "./create/New.js";
import { addressOf } from "./mail/people.js";
import { readJson, writeKey } from "./storage.js";
import { TaskCard, type PlannableTask } from "./TaskCard.js";
import { Button, LinkButton } from "./ui/controls.js";
import { timeLabel, toDate } from "./ui/dates.js";
import { Switch } from "./ui/fields.js";
import { Icon } from "./ui/Icon.js";
import { PageHeader } from "./ui/layout.js";
import { Popover, toast } from "./ui/overlays.js";
import { navigate, routeHref, type Route } from "./ui/router.js";
import { Skeleton } from "./ui/states.js";
import { attempt } from "./ui/writes.js";
import { AddMoneyRow } from "./today/AddMoneyRow.js";
import { minuteOf, poseAt, type DayItem } from "./today/day.js";
import { comingUp, dueGroups, moneyPace, peopleToday, projectsInMotion, relationLine, taskKey, type ComingRow } from "./today/model.js";
import { itemsOf } from "./noticed/model.js";
import { ComingUpModule, DueModule, MailModule, MoneyModule, NoticedModule, PeopleModule, ProjectsModule, entitySlug, type Loaded, type MailData, type NoticedData } from "./today/modules.js";
import { Timetable, type Link } from "./today/Timetable.js";
import { isoWeek, todayTitle } from "./today/title.js";
import { onWs } from "./ws.js";

/** The seven modules, in their order (structure.md §2.1). */
export const MODULES = [
  { id: "due", label: "Due" },
  { id: "mail", label: "Mail" },
  { id: "people", label: "People today" },
  { id: "coming", label: "Coming up" },
  { id: "projects", label: "Projects" },
  { id: "money", label: "Money" },
  { id: "noticed", label: "Orr noticed" },
] as const;
export type ModuleId = (typeof MODULES)[number]["id"];
/** The three columns on a desktop, as on the board; on a phone the modules stack in their order. */
const COLUMNS: { weight: number; ids: ModuleId[] }[] = [
  { weight: 1.15, ids: ["due"] },
  { weight: 1, ids: ["mail", "people"] },
  { weight: 1, ids: ["coming", "projects", "money", "noticed"] },
];
/** The modules switched off in Customise, on this device. */
export const HIDDEN_KEY = "orrama-today-hidden";
/** How long Orr jumps when a key deadline is met or a project finishes. */
export const JUMP_MS = 2400;

const L = (to: Route): Link => ({ href: routeHref(to), onOpen: () => navigate(to) });

/**
 * One request's answer, kept while the next is on its way, so a live reload never flashes grey
 * rows. `ask` null means "not asked" (mail that isn't connected). `deps` say when to ask again.
 */
function useAsk<T>(ask: (() => Promise<T>) | null, deps: unknown[]): Loaded<T> {
  const [state, setState] = useState<Loaded<T>>({ state: "loading" });
  const [again, setAgain] = useState(0);
  const retry = useCallback(() => setAgain((n) => n + 1), []);
  useEffect(() => {
    if (!ask) return;
    let live = true;
    ask().then(
      (data) => live && setState({ state: "ok", data }),
      () => live && setState((s) => (s.state === "ok" ? s : { state: "error", retry })),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, again, !!ask]);
  return state;
}

const ok = <T,>(l: Loaded<T>): T | undefined => (l.state === "ok" ? l.data : undefined);
/** Several answers as one: loading until all are in, failed if one failed. */
function all<T extends unknown[]>(...ls: { [K in keyof T]: Loaded<T[K]> }): Loaded<T> {
  const failed = ls.find((l) => l.state === "error");
  if (failed && failed.state === "error") return { state: "error", retry: () => ls.forEach((l) => l.state === "error" && l.retry()) };
  if (ls.some((l) => l.state === "loading")) return { state: "loading" };
  return { state: "ok", data: ls.map((l) => (l as { data: unknown }).data) as T };
}
const map = <T, U>(l: Loaded<T>, f: (t: T) => U): Loaded<U> => (l.state === "ok" ? { state: "ok", data: f(l.data) } : l);

export function Today() {
  /* ---- the clock: the now line moves, and a new day reloads ---- */
  const [clock, setClock] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setClock(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);
  const today = isoLocal(clock);
  const now = minuteOf(clock);

  /* ---- what the server knows; `tick` asks again after a change in the notes ---- */
  const [tick, setTick] = useState(0);
  const [loadedAt, setLoadedAt] = useState(() => new Date());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const off = onWs((msg) => {
      if (msg.type !== "note-changed") return;
      clearTimeout(timer);
      timer = setTimeout(() => setTick((n) => n + 1), 600);
    });
    return () => {
      off();
      clearTimeout(timer);
    };
  }, []);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  const until = addDays(today, 21);
  const home = useAsk(() => api<HomeData>("GET", "/api/home"), [tick, today]);
  const tasks = useAsk(() => api<DashboardTask[]>("GET", "/api/tasks"), [tick, today]);
  const projects = useAsk(() => api<ProjectRow[]>("GET", "/api/projects"), [tick]);
  const events = useAsk(() => api<CalEvent[]>("GET", `/api/events?from=${addDays(today, 1)}&to=${until}`), [tick, today]);
  const contacts = useAsk(() => api<Contact[]>("GET", "/api/contacts"), [tick]);
  const companies = useAsk(() => api<Company[]>("GET", "/api/companies"), [tick]);
  const schema = useAsk(() => api<GraphSchema>("GET", "/api/graph/schema"), [tick]);
  // Orr noticed's own list (R11): the module names the first problem as the page says it.
  const warnings = useAsk(() => api<GraphWarnings>("GET", "/api/graph/warnings"), [tick]);
  const feeds = useAsk(() => api<Feed[]>("GET", "/api/calendar/feeds"), []);
  const account = useAsk(() => api<MailAccount>("GET", "/api/mail/account"), []);
  const connected = ok(account)?.connected === true;
  const drafts = useAsk(connected ? () => api<PendingDraft[]>("GET", "/api/mail/drafts") : null, [tick]);
  // The inbox is live IMAP, seconds away: asked once, and again on Retry, never on a note change.
  const inbox = useAsk(connected ? () => api<{ messages: InboxItem[] }>("GET", "/api/mail/inbox") : null, []);
  useEffect(() => {
    if (home.state === "ok" || tasks.state === "ok") setLoadedAt(new Date());
  }, [home, tasks]);

  /* ---- the day on the track ---- */
  const agendaToday = useMemo(() => (ok(home)?.agenda ?? []).filter((a) => a.date === today && a.startMin !== null), [home, today]);
  const items = useMemo<DayItem[]>(
    () =>
      agendaToday.map((a, i) => ({
        id: `${a.kind}:${i}:${a.startMin}`,
        kind: a.kind === "task" ? "block" : a.source ? "feed" : "event",
        title: a.title,
        start: a.startMin!,
        end: a.startMin! + (a.durationMin ?? 30),
        noteId: a.noteId,
        line: a.line,
        project: null,
      })),
    [agendaToday],
  );
  const booked = useMemo(() => {
    const m = new Map<string, { start: number; end: number }>();
    for (const it of items) if (it.kind === "block" && it.noteId && it.line !== null && it.line !== undefined) m.set(`${it.noteId}:${it.line}`, { start: it.start, end: it.end });
    return m;
  }, [items]);
  const taskByKey = useMemo(() => new Map((ok(tasks) ?? []).map((t) => [taskKey(t), t])), [tasks]);
  const projectByName = useMemo(() => new Map((ok(projects) ?? []).map((p) => [p.name, p])), [projects]);
  const colour = useCallback((project: string | null) => DOMAIN_COLOR[projectByName.get(project ?? "")?.domain ?? ""] ?? "var(--c-other)", [projectByName]);

  /* ---- Orr jumps once: a key deadline met, a project finished ---- */
  const [jumping, setJumping] = useState(false);
  const jump = useCallback(() => {
    setJumping(true);
    setTimeout(() => setJumping(false), JUMP_MS);
  }, []);
  // Watched across reloads, so it counts wherever it happened: here, in Planning, in Obsidian.
  const finished = useRef<Set<string> | null>(null);
  useEffect(() => {
    const list = ok(projects);
    if (!list) return;
    const done = new Set(list.filter((p) => p.total > 0 && p.done >= p.total).map((p) => p.slug));
    if (finished.current && [...done].some((s) => !finished.current!.has(s))) jump();
    finished.current = done;
  }, [projects, jump]);
  const keysOpen = useRef<Set<string> | null>(null);
  useEffect(() => {
    const list = ok(tasks);
    if (!list) return;
    const key = (t: DashboardTask) => `${t.noteId}:${t.blockId ?? t.text}`;
    const met = list.filter((t) => t.key && t.checked).map(key);
    if (keysOpen.current && met.some((k) => keysOpen.current!.has(k))) jump();
    keysOpen.current = new Set(list.filter((t) => t.key && !t.checked).map(key));
  }, [tasks, jump]);
  const pose = poseAt(items, now, jumping);

  /* ---- the task card, Planning's own ---- */
  const [card, setCard] = useState<PlannableTask | null>(null);
  const openCard = useCallback(async (t: DashboardTask) => {
    let hit: PlannableTask | undefined;
    try {
      const plan = await api<{ assignees: { tasks: PlannableTask[] }[] }>("GET", "/api/plan");
      hit = plan.assignees.flatMap((a) => a.tasks).find((p) => p.noteId === t.noteId && p.line === t.line);
    } catch {
      /* the card still opens, without estimates */
    }
    setCard(
      hit ?? {
        noteId: t.noteId, noteTitle: t.noteTitle, line: t.line, blockId: t.blockId ?? null, text: t.text, project: t.project,
        due: t.due ?? null, priority: t.priority ?? null, estimateHours: 0, scheduledHours: 0, remainingHours: 0, atRisk: false,
      },
    );
  }, []);
  const taskLink = useCallback((t: DashboardTask): Link => ({ href: routeHref({ kind: "notes", id: t.noteId }), onOpen: () => void openCard(t) }), [openCard]);
  const dayLink = L({ kind: "planning", scale: "day", at: today });

  /* ---- ticking a task: the checkbox in its note ---- */
  const tick1 = useCallback(
    (t: DashboardTask) =>
      attempt("The task wasn't ticked.", async () => {
        try {
          // Named by its block id or its text, the line only a hint (COR-001): a note that moved
          // since this page was drawn gets the right task or a 409, never its neighbour.
          await api("POST", "/api/tasks/check", { noteId: t.noteId, line: t.line, blockId: t.blockId, text: t.text, checked: true });
        } catch (e) {
          // Anything else (the server down, a 500) is said by attempt, with Retry (WEB-010).
          if (!(e instanceof ApiError && e.status === 409)) throw e;
          toast("That task changed in its note since Today was drawn. Here it is as it is now.");
        } finally {
          reload();
        }
      }),
    [reload],
  );

  /* ---- the modules' data ---- */
  const due = map(all(tasks, home), ([ts]) => dueGroups(ts, today, booked));
  const keyRow = ok(due)?.key;
  const coming = map(all(events, tasks, projects), ([ev, ts, ps]) => comingUp({ events: ev, tasks: ts, projects: ps }, today, new Set(keyRow ? [taskKey(keyRow)] : [])));
  const moving = map(projects, projectsInMotion);
  const pace = map(home, (h) => moneyPace(h.spending));
  const charges = useMemo(
    () => (ok(home)?.agenda ?? []).filter((a) => a.kind === "charge" && a.date >= today).sort((a, b) => a.date.localeCompare(b.date)),
    [home, today],
  );

  const unread = useMemo(() => {
    const msgs = ok(inbox)?.messages;
    if (!msgs) return null;
    return msgs.filter((m) => !m.seen && m.category === "primary").sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
  }, [inbox]);
  const mail: Loaded<MailData> =
    account.state !== "ok"
      ? account
      : !account.data.connected
        ? { state: "ok", data: { connected: false, unread: [], drafts: [], retryInbox: () => {} } }
        : inbox.state === "loading" || drafts.state === "loading"
          ? { state: "loading" }
          : { state: "ok", data: { connected: true, unread: inbox.state === "ok" ? unread : null, drafts: ok(drafts) ?? [], retryInbox: inbox.state === "error" ? inbox.retry : () => {} } };

  const people = map(all(home, contacts), ([, cs]) =>
    peopleToday({
      events: items.filter((it) => it.kind !== "block").map((it) => ({ title: it.title, start: it.start })),
      mail: (unread ?? []).flatMap((m) => {
        const d = m.date ? toDate(m.date) : null;
        return d && isoLocal(d) === today ? [{ from: addressOf(m.from), uid: m.uid, ms: d.getTime() }] : [];
      }),
      contacts: cs,
    }),
  );

  /* ---- how you know someone, from the graph (nothing on a vault without an ontology) ---- */
  const typed = (ok(schema)?.types.length ?? 0) > 0;
  const askAbout = useMemo(() => {
    const ids = new Set<string>();
    for (const p of ok(people) ?? []) ids.add(p.contact.id);
    const cs = ok(contacts) ?? [];
    for (const m of (unread ?? []).slice(0, 3)) {
      const a = addressOf(m.from);
      const c = cs.find((x) => x.email && x.email.split(/[,;\s]+/).some((e) => e.trim().toLowerCase() === a));
      if (c) ids.add(c.id);
    }
    return [...ids].sort();
  }, [people, contacts, unread]);
  const [relations, setRelations] = useState<Map<string, string>>(new Map());
  const askKey = typed ? askAbout.join(",") : "";
  useEffect(() => {
    if (!askKey) return;
    let live = true;
    void Promise.all(
      askKey.split(",").map((id) =>
        api<GraphRelations>("GET", `/api/graph/relations?entity=${encodeURIComponent(id)}`)
          .then((r) => [id, relationLine(r)] as const)
          .catch(() => [id, null] as const),
      ),
    ).then((rows) => {
      if (!live) return;
      setRelations(new Map(rows.flatMap(([id, r]) => (r ? [[id, `${r.relation} ${r.to.title}`] as [string, string]] : []))));
    });
    return () => {
      live = false;
    };
  }, [askKey]);
  const relation = useCallback((id: string) => relations.get(id) ?? null, [relations]);

  const noticed = map(all(warnings, home), ([w, h]): NoticedData => {
    const items = itemsOf(w.warnings);
    return { typed: w.typed, total: items.length, first: items[0]?.parts ?? null, notes: h.stats.notes };
  });
  /** Where a name in Orr's sentence opens: People's, the board's and the saved chats' own pages. */
  const knownNow = useMemo(
    () => ({
      people: new Set((ok(contacts) ?? []).map((c) => c.id)),
      companies: new Set((ok(companies) ?? []).map((c) => c.id)),
      projects: new Map((ok(projects) ?? []).filter((p) => p.noteId).map((p) => [p.noteId!, p.slug])),
      conversations: new Set<string>(),
    }),
    [contacts, companies, projects],
  );

  /* ---- Customise: which modules show, on this device ---- */
  const [hidden, setHidden] = useState<Set<ModuleId>>(() => {
    const saved = readJson<unknown>(HIDDEN_KEY, []);
    return new Set(Array.isArray(saved) ? (saved.filter((id) => MODULES.some((m) => m.id === id)) as ModuleId[]) : []);
  });
  const setShown = (id: ModuleId, on: boolean) =>
    setHidden((h) => {
      const next = new Set(h);
      if (on) next.delete(id);
      else next.add(id);
      writeKey(HIDDEN_KEY, JSON.stringify([...next]));
      return next;
    });
  const customiseRef = useRef<HTMLButtonElement>(null);
  const [customising, setCustomising] = useState(false);

  /* ---- New ---- */
  const newRef = useRef<HTMLButtonElement>(null);
  const [newOpen, setNewOpen] = useState(false);
  const closeNew = useCallback(() => setNewOpen(false), []);
  const [adding, setAdding] = useState<"income" | "subscriptions" | null>(null);

  /* ---- links ---- */
  const openItem = (it: DayItem): Link => {
    const t = it.kind === "block" && it.noteId && it.line !== null && it.line !== undefined ? taskByKey.get(`${it.noteId}:${it.line}`) : undefined;
    return t ? taskLink(t) : dayLink;
  };
  const itemProject = (it: DayItem) => {
    const t = it.noteId && it.line !== null && it.line !== undefined ? taskByKey.get(`${it.noteId}:${it.line}`) : undefined;
    const p = t?.project ? projectByName.get(t.project) : undefined;
    return p ? { ...L({ kind: "project", slug: p.slug }), name: p.name } : null;
  };
  const itemColour = (it: DayItem) => {
    const t = it.noteId && it.line !== null && it.line !== undefined ? taskByKey.get(`${it.noteId}:${it.line}`) : undefined;
    return t ? colour(t.project) : null;
  };
  const openComing = (r: ComingRow): Link => {
    if (r.task) return taskLink(r.task);
    if (r.project) return L({ kind: "project", slug: r.project.slug });
    return L({ kind: "planning", scale: "day", at: r.date });
  };

  /* ---- the foot: when, and from what ---- */
  const sources = [
    ok(home) ? `${ok(home)!.stats.notes} notes` : null,
    (ok(feeds)?.length ?? 0) > 0 ? `${ok(feeds)!.length} ${ok(feeds)!.length === 1 ? "calendar" : "calendars"}` : null,
    connected ? (/gmail|google/i.test(ok(account)?.imapHost ?? "") ? "Gmail" : "your mail") : null,
  ].filter(Boolean) as string[];
  const readFrom = sources.length > 1 ? `${sources.slice(0, -1).join(", ")} and ${sources[sources.length - 1]}` : sources[0];

  const show = (id: ModuleId) => !hidden.has(id);
  const columns = COLUMNS.map((c) => ({ ...c, ids: c.ids.filter(show) })).filter((c) => c.ids.length > 0);
  const module = (id: ModuleId) => {
    switch (id) {
      case "due":
        return <DueModule key={id} loaded={due} now={now} colour={colour} openTask={taskLink} onTick={(t) => void tick1(t)} week={L({ kind: "planning", scale: "week" })} firstStep={L({ kind: "planning", scale: "week" })} />;
      case "mail":
        return (
          <MailModule
            key={id}
            loaded={mail}
            today={today}
            contacts={ok(contacts) ?? []}
            companies={ok(companies) ?? []}
            relation={relation}
            go={{ mail: L({ kind: "mail" }), message: (uid) => L({ kind: "mail", id: String(uid) }), waiting: L({ kind: "mail", waiting: true }), settings: L({ kind: "settings", section: "connections" }) }}
          />
        );
      case "people":
        return <PeopleModule key={id} loaded={people} relation={relation} go={{ people: L({ kind: "people" }), person: (c) => L({ kind: "person", slug: entitySlug(c.path) }) }} />;
      case "coming":
        return <ComingUpModule key={id} loaded={coming} open={openComing} month={L({ kind: "planning", scale: "month" })} />;
      case "projects":
        return <ProjectsModule key={id} loaded={moving} open={(p) => L({ kind: "project", slug: p.slug })} all={L({ kind: "projects" })} />;
      case "money":
        return (
          <MoneyModule
            key={id}
            loaded={pace}
            today={today}
            charges={charges.filter((c) => c.date <= addDays(today, 7))}
            go={{ money: L({ kind: "money" }), month: (m) => L({ kind: "money", page: "spending", month: m }), subscriptions: L({ kind: "money", page: "subscriptions" }), upload: L({ kind: "money", page: "documents" }) }}
          />
        );
      case "noticed":
        return <NoticedModule key={id} loaded={noticed} health={L({ kind: "notes-health" })} known={knownNow} />;
    }
  };

  return (
    <div className="ui today">
      <PageHeader
        title={todayTitle(clock)}
        meta={`Week ${isoWeek(clock)}`}
        actions={
          <>
            <LinkButton icon="calendar" {...linkProps(L({ kind: "planning", scale: "day", at: addDays(today, 1) }))}>
              Plan tomorrow
            </LinkButton>
            <Button ref={newRef} kind="solid" icon="plus" aria-haspopup="menu" aria-expanded={newOpen} onClick={() => setNewOpen((v) => !v)}>
              New
            </Button>
          </>
        }
      />

      {home.state === "ok" ? (
        <Timetable
          items={items}
          now={now}
          pose={pose}
          open={openItem}
          project={itemProject}
          colour={itemColour}
          firstSteps={{ date: L({ kind: "planning", scale: "week" }), calendar: L({ kind: "settings", section: "connections" }) }}
        />
      ) : (
        <section className="tt" aria-label="Today, hour by hour">
          {home.state === "loading" ? (
            <Skeleton rows={2} label="Loading today" />
          ) : (
            <p className="td-plain">
              Today's calendar didn't load.{" "}
              <button type="button" className="btn sm" onClick={home.retry}>
                Retry
              </button>
            </p>
          )}
        </section>
      )}

      <div className="td-dash" style={{ gridTemplateColumns: columns.map((c) => `minmax(0, ${c.weight}fr)`).join(" ") }}>
        {columns.map((c) => (
          <div className="td-col" key={c.ids.join()}>
            {c.ids.map(module)}
          </div>
        ))}
      </div>

      <footer className="td-foot">
        <span>
          {home.state === "ok" && `Updated ${timeLabel(loadedAt)}`}
          {home.state === "ok" && readFrom && ` · read from ${readFrom}`}
        </span>
        <button ref={customiseRef} type="button" className="td-customise" aria-haspopup="dialog" aria-expanded={customising} onClick={() => setCustomising((v) => !v)}>
          Customise
        </button>
      </footer>

      {customising && (
        <Popover anchor={customiseRef} onClose={() => setCustomising(false)} label="Customise Today" className="popover td-custom" align="end">
          <b>On Today</b>
          {MODULES.map((m) => (
            <label key={m.id} className="td-sw">
              <span>{m.label}</span>
              <Switch checked={show(m.id)} onChange={(on) => setShown(m.id, on)} label={m.label} />
            </label>
          ))}
        </Popover>
      )}
      {newOpen && (
        <New
          anchor={newRef}
          route={{ kind: "today" }}
          extra={[
            { label: "Subscription", icon: <Icon name="repeat" size={16} />, onSelect: () => setAdding("subscriptions") },
            { label: "Income", icon: <Icon name="money" size={16} />, onSelect: () => setAdding("income") },
          ]}
          onDone={closeNew}
        />
      )}
      {adding && (
        <AddMoneyRow
          kind={adding}
          noteMissing={!(adding === "income" ? ok(home)?.finance.in.noteId : ok(home)?.finance.out.noteId)}
          onClose={() => setAdding(null)}
          onSaved={() => {
            setAdding(null);
            toast(adding === "income" ? "Income added to its note." : "Subscription added to its note.");
            reload();
          }}
        />
      )}
      {card && (
        <TaskCard
          task={card}
          onClose={() => setCard(null)}
          onOpenNote={(id) => navigate({ kind: "notes", id })}
          onOpenProject={(slug) => navigate({ kind: "project", slug })}
          onScheduled={reload}
        />
      )}
    </div>
  );
}

/** A link's address and its plain click, for a LinkButton. */
function linkProps(l: Link) {
  return {
    href: l.href,
    onClick: (e: React.MouseEvent) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      l.onOpen();
    },
  };
}
