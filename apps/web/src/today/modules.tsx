/**
 * Today's seven modules (structure.md §2.1): Due, Mail, People today, Coming up, Projects, Money
 * and Orr noticed. Each is a rule, a heading with a count and a link, then rows; the heading and
 * the count open the place they summarise (§1.7 #2). Each shows grey row shapes while it loads,
 * says what failed and offers one action when it breaks, and has a plain form when there is
 * nothing to show, never a wall of zeros.
 *
 * The data comes in through props: Today.tsx asks the server, these only draw.
 */
import type { MouseEvent, ReactNode } from "react";
import type { Company, Contact, DashboardTask, HomeData, InboxItem, PendingDraft, ProjectRow } from "@basalt/schema/responses";
import { Bar, Checkbox, DeadlineChip, Dot, LinkButton, ProgressRing, Ring, Square } from "../ui/controls.js";
import { dateLabel, dayMonthLabel, minutesLabel, timeLabel, toDate, weekdayLabel } from "../ui/dates.js";
import { Group, Module, Row, RowList } from "../ui/layout.js";
import { HeadMark, Orr } from "../ui/orr/Orr.js";
import { Notice, Skeleton } from "../ui/states.js";
import { entitySlug, matchSender } from "../mail/people.js";
import { boxState, daysLate, type ComingRow, type DueGroups, type DueTask, type MoneyPace, type PersonToday } from "./model.js";
import type { Link } from "./Timetable.js";

const plainClick = (e: MouseEvent) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
const follow = (l: Link) => (e: MouseEvent) => {
  if (!plainClick(e)) return;
  e.preventDefault();
  l.onOpen();
};

/** A module's data: still coming, failed (with a way to try again), or here. */
export type Loaded<T> = { state: "loading" } | { state: "error"; retry: () => void } | { state: "ok"; data: T };

/** Grey rows while loading; the failure, said plainly, with its one action. */
function Pending({ what, loaded, rows = 3 }: { what: string; loaded: Loaded<unknown>; rows?: number }) {
  if (loaded.state === "loading") return <Skeleton rows={rows} label={`Loading ${what}`} />;
  if (loaded.state === "error")
    return (
      <Notice
        title={`${what} didn't load.`}
        text="The rest of Today is up to date."
        actions={
          <button type="button" className="btn sm" onClick={loaded.retry}>
            Retry
          </button>
        }
      />
    );
  return null;
}

/** The plain form of a module with nothing to show: one line, and its first step. */
function Plain({ children, step }: { children: ReactNode; step?: Link & { label: string } }) {
  return (
    <div className="td-plain">
      <p>{children}</p>
      {step && (
        <LinkButton size="sm" href={step.href} onClick={follow(step)}>
          {step.label}
        </LinkButton>
      )}
    </div>
  );
}

const eur = (n: number, decimals = false) =>
  new Intl.NumberFormat("en-GB", { style: "currency", currency: "EUR", maximumFractionDigits: decimals ? 2 : 0, minimumFractionDigits: decimals ? 2 : 0 }).format(n);
const money = (n: number, currency: string | null) =>
  new Intl.NumberFormat("en-GB", { style: "currency", currency: currency || "EUR" }).format(Math.abs(n));

/* ---- Due ------------------------------------------------------------------------------------ */

/**
 * A task row: the checkbox ticks it, the rest of the row opens its card. Two controls side by
 * side, never one inside the other: the link covers the row, the box sits above it.
 */
function TaskRow({
  task,
  meta,
  trailing,
  late,
  open,
  onTick,
  className,
}: {
  task: DashboardTask;
  meta: ReactNode;
  trailing?: ReactNode;
  late?: boolean;
  open: Link;
  onTick: () => void;
  className?: string;
}) {
  return (
    <div className={`row td-row${className ? ` ${className}` : ""}`}>
      <span className="lead">
        <Checkbox state={boxState(task.status)} onToggle={onTick} label={`Done: ${task.text}`} />
      </span>
      <a className="x td-open" href={open.href} title={task.text} data-row="" onClick={follow(open)}>
        <span className="t">{task.text}</span>
        <span className="m">{meta}</span>
      </a>
      {trailing !== undefined && (
        <span className="end">
          <span className={late ? "r late" : "r"}>{trailing}</span>
        </span>
      )}
    </div>
  );
}

const STATUS_WORD: Partial<Record<DashboardTask["status"], string>> = { "in-progress": "in progress", blocked: "blocked" };

/** Where a task belongs, in its area's colour, and what state it is in. */
function taskMeta(t: DueTask, colour: (project: string | null) => string, now: number) {
  const parts = [t.project ?? t.noteTitle];
  if (STATUS_WORD[t.status]) parts.push(STATUS_WORD[t.status]!);
  if (t.booked && !(t.booked.start <= now && now < t.booked.end)) parts.push(`booked ${minutesLabel(t.booked.start)}`);
  return (
    <>
      <Dot color={colour(t.project)} />
      <span className="td-ell">{parts.join(" · ")}</span>
    </>
  );
}

/** "Tomorrow", "Today", "Sun", or a date further out. */
function whenWord(days: number, date: string) {
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days < 7) return weekdayLabel(date);
  return dayMonthLabel(date);
}

export function DueModule({
  loaded,
  now,
  colour,
  openTask,
  onTick,
  week,
  firstStep,
}: {
  loaded: Loaded<DueGroups>;
  now: number;
  colour: (project: string | null) => string;
  openTask: (t: DashboardTask) => Link;
  onTick: (t: DashboardTask) => void;
  week: Link;
  firstStep: Link;
}) {
  const g = loaded.state === "ok" ? loaded.data : null;
  const LATE = 3;
  const LATER = 2;
  return (
    <Module
      title="Due"
      titleHref={week.href}
      onTitle={week.onOpen}
      count={g ? `${g.count} this week` : undefined}
      onCount={g ? week.onOpen : undefined}
      link={{ label: "Planning →", href: week.href, onOpen: week.onOpen }}
      className="td-due"
    >
      <Pending what="Your tasks" loaded={loaded} rows={5} />
      {g && !g.key && g.today.length + g.late.length + g.later.length === 0 && (
        <Plain step={{ ...firstStep, label: "Add a date to a task" }}>Nothing is due this week.</Plain>
      )}
      {g && (
        <RowList label="Due">
          {g.key && (
            <a className="row keyrow" href={openTask(g.key).href} onClick={follow(openTask(g.key))} data-row="" title={g.key.text}>
              <DeadlineChip>Key deadline</DeadlineChip>
              <span className="x">
                <span className="t">{g.key.text}</span>
                <span className="m">
                  <span className="td-ell">{[g.key.project, g.key.noteTitle].filter((s, i, a) => s && a.indexOf(s) === i).join(" · ")}</span>
                </span>
              </span>
              <span className="when">
                {whenWord(g.key.days, g.key.due!)}
                <small>{dateLabel(g.key.due!)}</small>
              </span>
            </a>
          )}
          {g.today.length > 0 && <Group count={g.today.length}>Today</Group>}
          {g.today.map((t) => {
            const on = t.booked && t.booked.start <= now && now < t.booked.end;
            const trailing = t.booked ? (on ? `until ${minutesLabel(t.booked.end)}` : t.booked.start > now ? minutesLabel(t.booked.start) : undefined) : undefined;
            return <TaskRow key={`${t.noteId}:${t.line}`} task={t} meta={taskMeta(t, colour, now)} trailing={trailing} open={openTask(t)} onTick={() => onTick(t)} />;
          })}
          {g.late.length > 0 && (
            <Group count={g.late.length} late>
              Late
            </Group>
          )}
          {g.late.slice(0, LATE).map((t, i) => (
            <TaskRow
              key={`${t.noteId}:${t.line}`}
              task={t}
              meta={taskMeta(t, colour, now)}
              trailing={daysLate(t.days)}
              late
              open={openTask(t)}
              onTick={() => onTick(t)}
              className={i >= 2 ? "hide-p" : undefined}
            />
          ))}
          {g.late.length > LATE && (
            <a className="td-more" href={week.href} onClick={follow(week)}>
              {g.late.length - LATE} more late
            </a>
          )}
          {g.later.length > 0 && (
            <div className="hide-p">
              <Group count={g.later.length}>Later this week</Group>
            </div>
          )}
          {g.later.slice(0, LATER).map((t) => (
            <TaskRow key={`${t.noteId}:${t.line}`} task={t} meta={taskMeta(t, colour, now)} trailing={weekdayLabel(t.due!)} open={openTask(t)} onTick={() => onTick(t)} className="hide-p" />
          ))}
          {g.later.length > LATER && (
            <a className="td-more hide-p" href={week.href} onClick={follow(week)}>
              {g.later.length - LATER} more this week
            </a>
          )}
        </RowList>
      )}
    </Module>
  );
}

/* ---- Mail ----------------------------------------------------------------------------------- */

export interface MailData {
  connected: boolean;
  /** Unread messages in Primary, newest first; null when the inbox could not be read. */
  unread: InboxItem[] | null;
  drafts: PendingDraft[];
  retryInbox: () => void;
}

/** "10:01" today, "Yesterday", else a date. */
function mailWhen(date: string | null, today: string) {
  const d = date ? toDate(date) : null;
  if (!d) return "";
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  if (day === today) return timeLabel(d);
  const y = new Date(`${today}T12:00:00`);
  y.setDate(y.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return dateLabel(d);
}

export function MailModule({
  loaded,
  today,
  contacts,
  companies,
  relation,
  go,
}: {
  loaded: Loaded<MailData>;
  today: string;
  contacts: Contact[];
  companies: Company[];
  /** How you know a contact, from the graph ("supervises Graduation thesis"); null when it doesn't say. */
  relation: (contactId: string) => string | null;
  go: { mail: Link; message: (uid: number) => Link; waiting: Link; settings: Link };
}) {
  const m = loaded.state === "ok" ? loaded.data : null;
  const unread = m?.unread ?? [];
  const fromOrr = m ? m.drafts.every((d) => d.createdBy === "agent") : false;
  return (
    <Module
      title="Mail"
      titleHref={go.mail.href}
      onTitle={go.mail.onOpen}
      count={m?.connected && m.unread ? `${unread.length} unread` : undefined}
      onCount={go.mail.onOpen}
      link={{ label: "Mail →", href: go.mail.href, onOpen: go.mail.onOpen }}
      className="td-mail"
    >
      <Pending what="Mail" loaded={loaded} rows={2} />
      {m && !m.connected && <Plain step={{ ...go.settings, label: "Connect your mail" }}>Your mail isn't connected yet.</Plain>}
      {m?.connected && m.unread === null && (
        <Notice
          title="Couldn't reach your mail."
          text="Drafts and the rest of Today still work."
          actions={
            <>
              <button type="button" className="btn sm" onClick={m.retryInbox}>
                Retry
              </button>
              <LinkButton size="sm" kind="quiet" href={go.settings.href} onClick={follow(go.settings)}>
                Settings → Connections
              </LinkButton>
            </>
          }
        />
      )}
      {m?.connected && m.unread && unread.length === 0 && m.drafts.length === 0 && <Plain>Everything's answered.</Plain>}
      {unread.length > 0 && (
        <RowList label="Unread mail">
          {unread.slice(0, 3).map((msg, i) => {
            const s = matchSender(msg.from, msg.fromName, contacts, companies);
            const name = s.contact?.name ?? (msg.fromName || msg.from);
            const how = (s.contact && relation(s.contact.id)) ?? s.contact?.role ?? s.company?.name ?? s.companyName ?? null;
            const l = go.message(msg.uid);
            return (
              <Row
                key={msg.uid}
                className={i >= 2 ? "hide-p" : undefined}
                href={l.href}
                onOpen={l.onOpen}
                lead={s.kind === "company" ? <Square name={s.company?.name ?? name} small /> : <Ring name={name} small />}
                title={msg.subject || "(no subject)"}
                titleAttr={msg.subject}
                meta={
                  <span className="td-ell">
                    {name}
                    {how && (
                      <>
                        {" · "}
                        <em>{how}</em>
                      </>
                    )}
                  </span>
                }
                trailing={mailWhen(msg.date, today)}
              />
            );
          })}
        </RowList>
      )}
      {m && m.drafts.length > 0 && (
        <div className="oprop">
          <HeadMark size={18} />
          <div>
            <p>
              <a className="ui-nm" href={go.waiting.href} onClick={follow(go.waiting)}>
                {m.drafts.length} {m.drafts.length === 1 ? "draft" : "drafts"}
                {fromOrr ? " from Orr" : ""}
              </a>{" "}
              {m.drafts.length === 1 ? "is" : "are"} waiting: {draftList(m.drafts)}.
            </p>
            <div className="acts">
              <LinkButton size="sm" href={go.waiting.href} onClick={follow(go.waiting)}>
                Review {m.drafts.length === 1 ? "the draft" : "drafts"}
              </LinkButton>
            </div>
          </div>
        </div>
      )}
    </Module>
  );
}

/** "“Re: Research plan” and “Agenda for Friday”", the first two, then how many more. */
function draftList(drafts: PendingDraft[]) {
  const subjects = drafts.map((d) => `“${d.subject || "no subject"}”`);
  if (subjects.length <= 2) return subjects.join(" and ");
  return `${subjects.slice(0, 2).join(", ")} and ${subjects.length - 2} more`;
}

/* ---- People today --------------------------------------------------------------------------- */

export function PeopleModule({
  loaded,
  relation,
  go,
}: {
  loaded: Loaded<PersonToday[]>;
  relation: (contactId: string) => string | null;
  go: { people: Link; person: (c: Contact) => Link };
}) {
  const people = loaded.state === "ok" ? loaded.data : null;
  return (
    <Module
      title="People today"
      titleHref={go.people.href}
      onTitle={go.people.onOpen}
      count={people ? people.length : undefined}
      link={{ label: "People →", href: go.people.href, onOpen: go.people.onOpen }}
      className="td-people"
    >
      <Pending what="People" loaded={loaded} rows={2} />
      {people && people.length === 0 && <Plain>No one you know is on today's calendar or in today's mail.</Plain>}
      {people && people.length > 0 && (
        <RowList label="People today">
          {people.slice(0, 4).map((p) => {
            const l = go.person(p.contact);
            const company = p.contact.company.replace(/\[\[|\]\]/g, "").trim();
            // Their role or their company, then how you know them; a relation that only repeats
            // the company ("works at AMSIB") is not said twice.
            const role = p.contact.role || company;
            const how = relation(p.contact.id);
            const saysCompany = !!how && !!company && how.endsWith(` ${company}`) && how.startsWith("works at");
            const when = "minute" in p.at ? minutesLabel(p.at.minute) : timeLabel(p.at.ms);
            return (
              <Row
                key={p.contact.id}
                href={l.href}
                onOpen={l.onOpen}
                lead={<Ring name={p.contact.name} small />}
                title={p.via === "mail" ? `${p.contact.name} · wrote at ${when}` : namesThem(p.what, p.contact.name) ? p.what : `${p.contact.name} · ${p.what}`}
                titleAttr={p.what}
                meta={
                  <span className="td-ell">
                    {role}
                    {how && !(saysCompany && role === company) && (
                      <>
                        {role ? " · " : ""}
                        <em>{how}</em>
                      </>
                    )}
                  </span>
                }
                trailing={p.via === "event" ? when : undefined}
              />
            );
          })}
        </RowList>
      )}
    </Module>
  );
}

/** Does an event's title already name the person ("Drinks with Emma Jansen")? */
const namesThem = (what: string, name: string) => what.toLocaleLowerCase("en").includes(name.toLocaleLowerCase("en"));

/* ---- Coming up ------------------------------------------------------------------------------ */

export function ComingUpModule({ loaded, open, month }: { loaded: Loaded<ComingRow[]>; open: (r: ComingRow) => Link; month: Link }) {
  const rows = loaded.state === "ok" ? loaded.data : null;
  return (
    <Module title="Coming up" titleHref={month.href} onTitle={month.onOpen} count="next 3 weeks" link={{ label: "Month →", href: month.href, onOpen: month.onOpen }} className="td-up">
      <Pending what="Your calendar" loaded={loaded} rows={3} />
      {rows && rows.length === 0 && <Plain step={{ ...month, label: "Open the month" }}>Nothing dated in the next three weeks.</Plain>}
      {rows && rows.length > 0 && (
        <RowList label="Coming up">
          {rows.slice(0, 4).map((r) => {
            const l = open(r);
            const d = toDate(r.date)!;
            const meta = [r.start !== null ? minutesLabel(r.start) : null, r.source].filter(Boolean).join(" · ");
            return (
              <Row
                key={r.id}
                className="up"
                href={l.href}
                onOpen={l.onOpen}
                lead={
                  <span className="date">
                    <b>{d.getDate()}</b>
                    {weekdayLabel(r.date)}
                  </span>
                }
                title={r.title}
                titleAttr={`${r.title}, ${dateLabel(r.date)}`}
                meta={meta ? <span className="td-ell">{meta}</span> : undefined}
                trailing={r.kind === "key" ? <DeadlineChip small>Key deadline</DeadlineChip> : ""}
              />
            );
          })}
        </RowList>
      )}
    </Module>
  );
}

/* ---- Projects ------------------------------------------------------------------------------- */

export function ProjectsModule({ loaded, open, all }: { loaded: Loaded<(ProjectRow & { when: string | null })[]>; open: (p: ProjectRow) => Link; all: Link }) {
  const list = loaded.state === "ok" ? loaded.data : null;
  return (
    <Module
      title="Projects"
      titleHref={all.href}
      onTitle={all.onOpen}
      count={list ? `${list.length} open` : undefined}
      onCount={all.onOpen}
      link={{ label: "All →", href: all.href, onOpen: all.onOpen }}
      className="td-proj"
    >
      <Pending what="Projects" loaded={loaded} rows={2} />
      {list && list.length === 0 && <Plain step={{ ...all, label: "Open Projects" }}>No projects in motion.</Plain>}
      {list && list.length > 0 && (
        <RowList label="Projects">
          {list.slice(0, 3).map((p) => {
            const l = open(p);
            const share = p.total > 0 ? p.done / p.total : 0;
            const date = p.deadline ? `Deadline ${dateLabel(p.deadline)}` : p.nextDue ? `Next step ${dateLabel(p.nextDue)}` : p.total > 0 ? `${p.done} of ${p.total} steps` : "No steps yet";
            return (
              <Row
                key={p.slug}
                className="proj"
                href={l.href}
                onOpen={l.onOpen}
                lead={<ProgressRing value={share} label={`${Math.round(share * 100)}% done`} />}
                title={p.name}
                meta={
                  <span className={p.overdue > 0 ? "td-ell late" : "td-ell"}>
                    {date}
                    {p.overdue > 0 && ` · ${p.overdue} late`}
                  </span>
                }
                trailing={`${Math.round(share * 100)}%`}
              />
            );
          })}
        </RowList>
      )}
    </Module>
  );
}

/* ---- Money ---------------------------------------------------------------------------------- */

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** "October", or "October 2025" when it is not this year. */
export function monthWord(month: string, today: string) {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return `${MONTHS[m - 1]}${String(y) === today.slice(0, 4) ? "" : ` ${y}`}`;
}

export function MoneyModule({
  loaded,
  today,
  charges,
  go,
}: {
  loaded: Loaded<MoneyPace | null>;
  today: string;
  /** Charges in the next seven days, from the subscriptions ledger, soonest first. */
  charges: HomeData["agenda"];
  go: { month: (m: string) => Link; subscriptions: Link; money: Link; upload: Link };
}) {
  const pace = loaded.state === "ok" ? loaded.data : undefined;
  const charge = charges[0];
  return (
    <Module
      title="Money"
      titleHref={go.money.href}
      onTitle={go.money.onOpen}
      count={pace ? monthWord(pace.month, today) : undefined}
      link={{ label: "Money →", href: go.money.href, onOpen: go.money.onOpen }}
      className="td-money"
    >
      <Pending what="Money" loaded={loaded} rows={2} />
      {pace === null && <Plain step={{ ...go.upload, label: "Add a bank export" }}>No bank statement yet.</Plain>}
      {pace && (
        <>
          <a className="big" href={go.month(pace.month).href} onClick={follow(go.month(pace.month))}>
            {eur(pace.spent)} <small>{pace.dayOf ? `spent by day ${pace.dayOf}` : `spent in ${monthWord(pace.month, today)}`}</small>
          </a>
          <Bar value={pace.typical > 0 ? pace.spent / pace.typical : 0} label={`${eur(pace.spent)} of a typical ${eur(pace.typical)}`} />
          <p>
            {paceSentence(pace)}
            {charge && (
              <>
                {" "}
                <a className="ui-nm" href={go.subscriptions.href} onClick={follow(go.subscriptions)}>
                  {charge.title}
                </a>{" "}
                charges {money(charge.amount ?? 0, charge.currency)} {charge.date === today ? "today" : `on ${dateLabel(charge.date)}`}.
              </>
            )}
          </p>
        </>
      )}
    </Module>
  );
}

/**
 * Against a typical month, whole. Not "on pace by now": spending is not spread evenly over a
 * month (rent leaves on the 1st), and the server gives no typical figure by day of the month.
 */
export function paceSentence(p: MoneyPace): string {
  const share = p.typical > 0 ? Math.round((p.spent / p.typical) * 100) : null;
  if (share === null) return "";
  if (!p.dayOf) return `A typical month comes to ${eur(p.typical)}; this one was ${share}% of it.`;
  return `A typical month comes to ${eur(p.typical)}; ${share}% of that is spent so far.`;
}

/* ---- Orr noticed ---------------------------------------------------------------------------- */

export interface NoticedData {
  /** The vault has an ontology note: its types are known. */
  typed: boolean;
  total: number;
  /** The most common warning, said as a sentence, and how many it covers. */
  first: { text: string; count: number } | null;
  notes: number;
}

export function NoticedModule({ loaded, health }: { loaded: Loaded<NoticedData>; health: Link }) {
  const n = loaded.state === "ok" ? loaded.data : null;
  return (
    <Module title="Orr noticed" count={n && n.total > 0 ? `${n.total} in the graph` : undefined} onCount={health.onOpen} className="td-noticed">
      <Pending what="The graph" loaded={loaded} rows={2} />
      {n && n.total > 0 && (
        <div className="noticed">
          <div className="orrbox">
            <Orr pose="search" size={50} />
          </div>
          <div>
            <p>
              {n.first ? n.first.text : `${n.total} things need a look`}
              {n.first && n.total > n.first.count && (
                <>
                  , and{" "}
                  <a className="ui-nm" href={health.href} onClick={follow(health)}>
                    {n.total - n.first.count} more
                  </a>
                </>
              )}
              .
            </p>
            <LinkButton size="sm" href={health.href} onClick={follow(health)}>
              Review
            </LinkButton>
          </div>
        </div>
      )}
      {n && n.total === 0 && (
        <Plain step={n.typed ? undefined : { ...health, label: "What Orr checks" }}>
          {n.typed ? `Nothing in the graph needs a look. Read from ${n.notes} notes.` : `Your notes have no types yet, so there is nothing to check. Read from ${n.notes} notes.`}
        </Plain>
      )}
    </Module>
  );
}

export { entitySlug };
