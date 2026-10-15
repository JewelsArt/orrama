/**
 * What Today's modules say, worked out from what the server sends (structure.md §2.1). Pure: no
 * fetching, no clock of its own (`today` is passed in), so each rule has a test.
 *
 * Nothing here invents a word the data doesn't hold. Where the graph has nothing (a vault with
 * no ontology note), a phrase comes back null and the module shows its plain form.
 */
import { addDays, daysTo } from "@orrama/core/dates";
import type { CalEvent, Contact, DashboardTask, GraphRelations, HomeData, ProjectRow } from "@orrama/schema/responses";
import { isProjectActive } from "../categories.js";

/* ---- Due ------------------------------------------------------------------------------------ */

/** A task as Due draws it: its line, and when it is booked today. */
export type DueTask = DashboardTask & { booked?: { start: number; end: number } };

export interface DueGroups {
  /** The next key deadline still ahead: the module's one red fill. */
  key: (DueTask & { days: number }) | null;
  /** Due today, or booked today. */
  today: DueTask[];
  /** Past its date, least late first. */
  late: (DueTask & { days: number })[];
  /** Due later this week (to Sunday). */
  later: DueTask[];
  /** How many of these fall due by Sunday, late ones included: the module's count. */
  count: number;
}

/** Sunday of the ISO week a date falls in. */
export function weekEnd(today: string): string {
  const [y, m, d] = today.split("-").map(Number) as [number, number, number];
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  return addDays(today, (7 - dow) % 7);
}

/** The task's place in its note, the key Today matches blocks and rows by. */
export const taskKey = (t: { noteId: string; line: number }) => `${t.noteId}:${t.line}`;

export function dueGroups(tasks: DashboardTask[], today: string, booked: Map<string, { start: number; end: number }>): DueGroups {
  const sunday = weekEnd(today);
  const open = tasks.filter((t) => !t.checked);
  const key =
    open
      .filter((t) => t.key && t.due && t.due >= today)
      .sort((a, b) => a.due!.localeCompare(b.due!) || a.noteTitle.localeCompare(b.noteTitle))
      .map((t) => ({ ...t, booked: booked.get(taskKey(t)), days: daysTo(today, t.due!) }))[0] ?? null;
  const notKey = (t: DashboardTask) => !key || taskKey(t) !== taskKey(key);

  const todayRows = open
    .filter((t) => notKey(t) && (t.due === today || booked.has(taskKey(t))))
    .map((t) => ({ ...t, booked: booked.get(taskKey(t)) }))
    // Booked ones in the order of the day, then what is due today without a time.
    .sort((a, b) => (a.booked?.start ?? 1e9) - (b.booked?.start ?? 1e9) || a.text.localeCompare(b.text));
  const inToday = new Set(todayRows.map(taskKey));
  const late = open
    .filter((t) => notKey(t) && !inToday.has(taskKey(t)) && t.due && t.due < today)
    .map((t) => ({ ...t, days: daysTo(t.due!, today) }))
    .sort((a, b) => a.days - b.days || a.text.localeCompare(b.text));
  const later = open
    .filter((t) => notKey(t) && !inToday.has(taskKey(t)) && t.due && t.due > today && t.due <= sunday)
    .sort((a, b) => a.due!.localeCompare(b.due!) || a.text.localeCompare(b.text));
  const keyThisWeek = key && key.due! <= sunday ? 1 : 0;
  return { key, today: todayRows, late, later, count: todayRows.length + late.length + later.length + keyThisWeek };
}

/** The checkbox's state, from the line's own mark. */
export const boxState = (s: DashboardTask["status"]) => (s === "in-progress" ? "progress" : s === "blocked" ? "blocked" : s === "done" ? "done" : "open") as "open" | "progress" | "blocked" | "done";

/** "3 days" late, or "1 day". */
export const daysLate = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;

/* ---- Coming up ------------------------------------------------------------------------------ */

export interface ComingRow {
  id: string;
  kind: "event" | "key" | "milestone";
  date: string;
  /** Minutes past midnight, for a timed event. */
  start: number | null;
  title: string;
  /** What it belongs to: a feed's name, a project. */
  source: string | null;
  task?: DashboardTask;
  project?: ProjectRow;
}

/**
 * The next three weeks after today: events, key deadlines and projects' own dates (start and
 * deadline), soonest first. Ordinary due dates stay in Due: thirty dated thesis questions would
 * bury the three things that matter.
 */
export function comingUp(
  { events, tasks, projects }: { events: CalEvent[]; tasks: DashboardTask[]; projects: ProjectRow[] },
  today: string,
  skip: Set<string> = new Set(),
  days = 21,
): ComingRow[] {
  const from = addDays(today, 1);
  const to = addDays(today, days);
  const inRange = (d: string | null | undefined): d is string => !!d && d >= from && d <= to;
  const rows: ComingRow[] = [];
  for (const e of events) {
    if (!inRange(e.date)) continue;
    rows.push({ id: `e:${e.id}:${e.date}`, kind: "event", date: e.date, start: e.allDay ? null : e.startMin, title: e.title, source: e.feedLabel ?? null });
  }
  for (const t of tasks) {
    if (t.checked || !t.key || !inRange(t.due) || skip.has(taskKey(t))) continue;
    rows.push({ id: `k:${taskKey(t)}`, kind: "key", date: t.due, start: null, title: t.text, source: t.project, task: t });
  }
  for (const p of projects.filter(isProjectActive)) {
    if (inRange(p.deadline)) rows.push({ id: `d:${p.slug}`, kind: "milestone", date: p.deadline, start: null, title: `${p.name} due`, source: p.name, project: p });
    if (inRange(p.start)) rows.push({ id: `s:${p.slug}`, kind: "milestone", date: p.start, start: null, title: `${p.name} starts`, source: p.name, project: p });
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date) || (a.start ?? -1) - (b.start ?? -1) || a.title.localeCompare(b.title));
}

/* ---- Projects ------------------------------------------------------------------------------- */

/** The projects in motion, the soonest date first; a project with no date after those. */
export function projectsInMotion(projects: ProjectRow[]): (ProjectRow & { when: string | null })[] {
  return projects
    .filter(isProjectActive)
    .map((p) => ({ ...p, when: p.deadline ?? p.nextDue }))
    .sort((a, b) => (a.when ?? "9999").localeCompare(b.when ?? "9999") || a.name.localeCompare(b.name));
}

/* ---- People today --------------------------------------------------------------------------- */

export interface PersonToday {
  contact: Contact;
  /** What brings them into today: an event's title, or that they wrote. */
  what: string;
  /** Minutes past midnight (an event), or a timestamp (mail). */
  at: { minute: number } | { ms: number };
  via: "event" | "mail";
  uid?: number;
}

const fold = (s: string) => s.normalize("NFC").toLocaleLowerCase("en");
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Who you'll see or who wrote: a contact whose whole name is in one of today's events, or whose
 * address sent unread mail today. A first name alone is not enough ("Lunch with Emma" names no
 * one in particular), so nobody is matched on a guess.
 */
export function peopleToday(
  { events, mail, contacts }: { events: { title: string; start: number }[]; mail: { from: string; uid: number; ms: number }[]; contacts: Contact[] },
): PersonToday[] {
  const out: PersonToday[] = [];
  const seen = new Set<string>();
  const named = contacts
    .filter((c) => c.name.trim().split(/\s+/).length >= 2)
    .map((c) => ({ c, re: new RegExp(`(^|[^\\p{L}])${escape(fold(c.name.trim()))}($|[^\\p{L}])`, "u") }));
  for (const e of [...events].sort((a, b) => a.start - b.start)) {
    for (const { c, re } of named) {
      if (seen.has(c.id) || !re.test(fold(e.title))) continue;
      seen.add(c.id);
      out.push({ contact: c, what: e.title, at: { minute: e.start }, via: "event" });
    }
  }
  const byEmail = new Map(contacts.filter((c) => c.email).map((c) => [fold(c.email.trim()), c]));
  for (const m of [...mail].sort((a, b) => a.ms - b.ms)) {
    const c = byEmail.get(fold(m.from.trim()));
    if (!c || seen.has(c.id)) continue;
    seen.add(c.id);
    out.push({ contact: c, what: "wrote to you", at: { ms: m.ms }, via: "mail", uid: m.uid });
  }
  return out;
}

/* ---- The graph ------------------------------------------------------------------------------ */

/**
 * One relation line for a person ("supervises Graduation thesis"), from the graph: a relation to
 * a project first, else the first one there is. Null when the graph knows none (no ontology note,
 * or nothing typed about them): the row then says what the contact note says, never a guess.
 */
export function relationLine(r: GraphRelations | null | undefined): { relation: string; to: { id: string; title: string; type: string } } | null {
  if (!r) return null;
  const all = r.relations.flatMap((g) => g.to.map((to) => ({ relation: g.relation.replace(/_/g, " "), to })));
  const pick = all.find((x) => x.to.type === "project") ?? all[0];
  return pick ? { relation: pick.relation, to: { id: pick.to.id, title: pick.to.title, type: pick.to.type } } : null;
}

/* ---- Money ---------------------------------------------------------------------------------- */

export interface MoneyPace {
  /** YYYY-MM of the month shown. */
  month: string;
  spent: number;
  /** A typical month, whole (the median of the complete months around it). */
  typical: number;
  /** Day of the month the statement reaches, and the month's length; null for a finished month. */
  dayOf: number | null;
  daysIn: number | null;
}

/**
 * Spent so far this month against a typical month. The month in progress when the statement
 * reaches into it; otherwise the last complete month, said as such. Null with no statement.
 */
export function moneyPace(spending: HomeData["spending"]): MoneyPace | null {
  if (!spending) return null;
  if (spending.running) return { month: spending.running.month, spent: spending.running.total, typical: spending.typical, dayOf: spending.running.dayOf, daysIn: spending.running.daysIn };
  return { month: spending.month, spent: spending.total, typical: spending.typical, dayOf: null, daysIn: null };
}
