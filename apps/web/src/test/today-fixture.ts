/**
 * A day for Today's DOM tests: `fetch` answers every request Today makes from fixtures built
 * around Thursday 8 October 2026, 10:40 (the Today board's moment), and records what was sent.
 * The people and projects are the mockups' fictional ones. No real vault, ever.
 */
import { vi } from "vitest";
import type { CalEvent, Company, Contact, DashboardTask, GraphRelations, GraphSchema, HomeData, InboxItem, MailAccount, PendingDraft, ProjectRow } from "@basalt/schema/responses";

export const NOW = new Date(2026, 9, 8, 10, 40);
export const TODAY = "2026-10-08";

let line = 0;
export const task = (text: string, o: Partial<DashboardTask> = {}): DashboardTask => ({
  line: line++,
  checked: false,
  status: "todo",
  text,
  raw: `- [ ] ${text}`,
  indent: 0,
  noteId: "n-thesis",
  notePath: "04-Projects/Graduation thesis.md",
  noteTitle: "Graduation thesis",
  project: "Graduation thesis",
  object: null,
  ...o,
});

export const TASKS: DashboardTask[] = [
  task("Dashboard review with Thijs", { key: true, due: "2026-10-09", project: "Reporting dashboard", noteId: "n-dash", noteTitle: "Reporting dashboard", blockId: "t-review" }),
  task("Refine research question", { due: TODAY, status: "in-progress", blockId: "t-refine" }),
  task("October report — data pull", { project: "Reporting dashboard", noteId: "n-dash", noteTitle: "Reporting dashboard", status: "in-progress" }),
  task("Ask Thijs Brouwer to sign the data agreement", { due: "2026-10-05" }),
  task("Pull 3 years of reach data", { due: "2026-10-04", status: "blocked" }),
  task("Race day", { key: true, due: "2026-10-18", project: null, noteId: "n-home", noteTitle: "Home" }),
];
const report = TASKS[2]!;

export const PROJECTS: ProjectRow[] = [
  { slug: "thesis", key: "project/thesis", name: "Graduation thesis", domain: "academic", noteId: "n-thesis", total: 9, done: 2, status: "on-track", start: null, deadline: "2026-10-19", nextDue: "2026-10-05", overdue: 2 },
  { slug: "reporting", key: "project/reporting", name: "Reporting dashboard", domain: "professional", noteId: "n-dash", total: 5, done: 2, status: null, start: null, deadline: null, nextDue: "2026-10-09", overdue: 0 },
];

const agenda = (o: Partial<HomeData["agenda"][number]>): HomeData["agenda"][number] => ({
  kind: "event", date: TODAY, title: "", startMin: null, durationMin: null, noteId: null, line: null, source: null, amount: null, currency: null, key: false, ...o,
});

export const HOME: HomeData = {
  user: { displayName: "Jules", username: "jules" },
  stats: { notes: 312, sessions: 0, openTasks: 6, doneTasks: 2, overdueTasks: 2, weekHours: 4 },
  deadlines: [],
  focus: [],
  agenda: [
    agenda({ kind: "event", title: "Kade standup", startMin: 570, durationMin: 15 }),
    agenda({ kind: "task", title: "October report — data pull", startMin: 585, durationMin: 135, noteId: report.noteId, line: report.line }),
    agenda({ kind: "event", title: "Lunch with Emma Jansen", startMin: 750, durationMin: 60 }),
    agenda({ kind: "event", title: "Thesis workshop", startMin: 1020, durationMin: 90, source: "Westerdok timetable" }),
    agenda({ kind: "charge", title: "Adobe Creative Cloud", amount: -19.66, currency: "EUR", noteId: "n-subs" }),
  ],
  finance: {
    out: { noteId: "n-subs", totals: [], items: [], count: 1 },
    in: { noteId: null, totals: [], items: [], count: 0 },
    net: [],
  },
  spending: {
    month: "2026-09",
    total: 1210,
    typical: 1600,
    categories: [],
    running: { month: "2026-10", total: 958, dayOf: 8, daysIn: 31 },
    savings: { target: 0, surplus: 0, trimmable: 0, observed: null, targetRate: null, top: [] },
    basedOn: 5,
  },
};

export const EVENTS: CalEvent[] = [{ id: "ev-1", ownerId: "u1", username: "jules", mine: true, title: "Interview, Polder Capital", date: "2026-10-12", startMin: 660, durationMin: 60 }];

const contact = (name: string, o: Partial<Contact> = {}): Contact => ({ id: `c-${name}`, name, path: `Contacts/${name}.md`, sector: "", role: "", company: "", email: "", phone: "", linkedin: "", personal: false, ...o });
export const CONTACTS: Contact[] = [
  contact("Emma Jansen", { role: "Classmate", email: "emma@jansen.example" }),
  contact("Ines Vermaat", { role: "Supervisor", company: "[[Westerdok]]", email: "i.vermaat@westerdok.example" }),
];
export const COMPANIES: Company[] = [];

export const SCHEMA_TYPED: GraphSchema = {
  notes: 312,
  types: [{ id: "person", count: 2, description: "" }],
  relations: [],
  derived: [],
  statuses: [],
  mostConnected: [],
  warnings: [
    { code: "person-without-company", count: 3 },
    { code: "project-without-status", count: 1 },
  ],
};
export const SCHEMA_EMPTY: GraphSchema = { notes: 312, types: [], relations: [], derived: [], statuses: [], mostConnected: [], warnings: [] };

export const RELATIONS: Record<string, GraphRelations> = {
  "c-Ines Vermaat": {
    entity: { id: "c-Ines Vermaat", title: "Ines Vermaat", type: "person", summary: "", fields: {} },
    relations: [{ relation: "supervises", to: [{ id: "n-thesis", title: "Graduation thesis", type: "project", via: "field", where: "", source: { id: "c-Ines Vermaat", title: "Ines Vermaat" } }] }],
    warnings: [],
  },
};

export const INBOX: InboxItem[] = [
  { uid: 101, from: "Ines Vermaat <i.vermaat@westerdok.example>", fromName: "Ines Vermaat", subject: "Re: Research plan — section 3", date: "2026-10-08T08:01:00.000Z", seen: false, messageId: null, category: "primary" },
  { uid: 102, from: "news@shop.example", fromName: "Shop", subject: "Sale", date: "2026-10-08T07:00:00.000Z", seen: false, messageId: null, category: "promotions" },
  { uid: 103, from: "x@example.com", fromName: "Read Already", subject: "Old", date: "2026-10-07T07:00:00.000Z", seen: true, messageId: null, category: "primary" },
];
export const DRAFTS: PendingDraft[] = [
  { id: "d1", to: "i.vermaat@westerdok.example", subject: "Re: Research plan — section 3", body: "…", inReplyTo: null, references: null, createdBy: "agent", createdAt: 1 },
  { id: "d2", to: "thijs@kade.example", subject: "Agenda for Friday's review", body: "…", inReplyTo: null, references: null, createdBy: "agent", createdAt: 2 },
];

export interface Sent {
  method: string;
  url: string;
  body: unknown;
}

/** Answer Today's requests; `over` replaces any of them ("GET /api/home": a body, or a status number to fail with). */
export function stubToday(over: Record<string, unknown> = {}) {
  const account: MailAccount = { connected: false, email: null, imapHost: null, lastCheckedAt: null, lastError: null };
  const routes: Record<string, unknown> = {
    "GET /api/home": HOME,
    "GET /api/tasks": TASKS,
    "GET /api/projects": PROJECTS,
    "GET /api/events": EVENTS,
    "GET /api/contacts": CONTACTS,
    "GET /api/companies": COMPANIES,
    "GET /api/graph/schema": SCHEMA_EMPTY,
    "GET /api/calendar/feeds": [],
    "GET /api/mail/account": account,
    "GET /api/mail/drafts": [],
    "GET /api/mail/inbox": { email: "jules@example.com", messages: [] },
    "GET /api/plan": { assignees: [] },
    // The task card asks for its project's workspace.
    "GET /api/projects/thesis": { slug: "thesis", name: "Graduation thesis", status: "on-track", deadline: "2026-10-19", people: [] },
    "GET /api/projects/reporting": { slug: "reporting", name: "Reporting dashboard", status: "", deadline: "", people: [] },
    "POST /api/tasks/check": { ok: true },
    ...over,
  };
  const sent: Sent[] = [];
  vi.stubGlobal("fetch", async (url: string, init: { method?: string; body?: string } = {}) => {
    const method = init.method ?? "GET";
    const path = url.split("?")[0]!;
    sent.push({ method, url, body: init.body ? JSON.parse(init.body) : undefined });
    if (path === "/api/graph/relations") {
      const id = new URL(url, "http://x").searchParams.get("entity")!;
      const r = RELATIONS[id];
      return r ? new Response(JSON.stringify(r)) : new Response("{}", { status: 404 });
    }
    const key = `${method} ${path}`;
    if (!(key in routes)) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    const body = routes[key];
    if (typeof body === "number") return new Response(JSON.stringify({ error: "failed" }), { status: body });
    return new Response(JSON.stringify(body), { status: 200 });
  });
  return { sent, routes };
}
