/**
 * What Find can find, as items (structure.md §2.12): people, companies, projects, notes and
 * conversations from the lists the app already reads, the eight places, the settings by name
 * (R1's SETTINGS_INDEX), and actions. Pure: the palette hands in what it loaded and the query.
 */
import type { Company, Contact, GraphData, PeopleContext, ProjectRow, SearchHit, TreeNote } from "@basalt/schema/responses";
import { STATUS_WORD, statusOf } from "../entity/status.js";
import { notePath, slugOf } from "../entity/links.js";
import { companyFor, keyRelation, linkText, peopleAt } from "../people/model.js";
import { folderName } from "../notes/read.js";
import { dateLabel } from "../ui/dates.js";
import { PLACES, type Place, type SettingsSection } from "../ui/router.js";
import { scoreOf, type FindType, type Item } from "./model.js";

export interface Lists {
  contacts: Contact[];
  companies: Company[];
  projects: ProjectRow[];
  nodes: GraphData["nodes"];
  edges: GraphData["edges"];
  tree: TreeNote[];
  context: PeopleContext | null;
}

export interface Setting {
  label: string;
  section: SettingsSection;
  sectionLabel: string;
}

export interface ActionDef {
  id: string;
  title: string;
  meta: string;
  icon: string;
  /** More words it answers to. */
  words: string;
}

const PLACE_ICON: Record<Place, string> = { today: "sunrise", planning: "calendar", notes: "notes", orrery: "orbit", projects: "projects", people: "people", mail: "mail", money: "money" };
const PLACE_LINE: Record<Place, string> = {
  today: "Your day: the timetable, what's due, mail, people",
  planning: "The week in lanes or hours, the month",
  notes: "Every note, pinned and recent",
  orrery: "Your notes as a map, Orr in the middle",
  projects: "Every project and its next step",
  people: "People and companies",
  mail: "Your inbox and Orr's drafts",
  money: "Spending, subscriptions, income and saving",
};

const joined = (...parts: (string | null | undefined | false)[]) => parts.filter(Boolean).join(" · ");

/** The places, each a result. */
export function placeItems(words: string[]): Item[] {
  return PLACES.map((p) => ({
    key: `place:${p.place}`,
    type: "place" as FindType,
    title: p.label,
    meta: PLACE_LINE[p.place],
    lead: { kind: "icon" as const, of: PLACE_ICON[p.place] },
    route: p.place === "planning" ? { kind: "planning" as const, scale: "week" as const } : ({ kind: p.place } as Item["route"]),
    keycap: p.key,
    score: words.length ? scoreOf(words, p.label, PLACE_LINE[p.place]) : 1,
  })).filter((i) => i.score > 0);
}

export function settingItems(words: string[], found: Setting[]): Item[] {
  return found.map((s) => ({
    key: `setting:${s.section}:${s.label}`,
    type: "setting" as FindType,
    title: s.label,
    meta: `Settings → ${s.sectionLabel}`,
    lead: { kind: "icon" as const, of: "settings" },
    route: { kind: "settings" as const, section: s.section },
    // Found by its words as well as its name (findSettings): never below a plain mention.
    score: Math.max(scoreOf(words, s.label), 30),
  }));
}

export function actionItems(words: string[], actions: ActionDef[]): Item[] {
  return actions
    .map((a) => ({ key: `action:${a.id}`, type: "action" as FindType, title: a.title, meta: a.meta, lead: { kind: "icon" as const, of: a.icon }, action: a.id, score: words.length ? scoreOf(words, a.title, `${a.meta} ${a.words}`) : 1 }))
    .filter((i) => i.score > 0);
}

/**
 * People, companies, projects and conversations matched by name, and what a matching company
 * brings with it: the people who work there and the projects it is in.
 */
export function entityItems(words: string[], l: Lists): { items: Item[]; via: Record<string, string> } {
  const entries = new Map((l.context?.entries ?? []).map((e) => [e.id, e]));
  const byId = new Map(l.tree.map((n) => [n.id, n]));
  const items = new Map<string, Item>();
  const put = (it: Item) => {
    const cur = items.get(it.key);
    if (!cur || cur.score < it.score) items.set(it.key, it);
  };

  const personItem = (c: Contact, score: number, via?: string): Item => {
    const firm = companyFor(c, l.companies);
    const rel = keyRelation(entries.get(c.id), "person");
    return {
      key: `n:${c.id}`,
      type: "person",
      title: c.name,
      meta: joined(c.role, firm?.name ?? linkText(c.company), rel && `${rel.phrase} ${rel.first.title}${rel.more ? ` and ${rel.more} more` : ""}`),
      lead: { kind: "ring", of: c.name },
      route: { kind: "person", slug: slugOf(c.path) },
      score,
      folder: c.path.split("/").slice(0, -1).map(folderName).join(" / "),
      ...(via ? { via } : {}),
    };
  };
  const projectItem = (p: ProjectRow, score: number, via?: string): Item => {
    const st = statusOf(p.status);
    return {
      key: `p:${p.key}`,
      type: "project",
      title: p.name,
      meta: joined(st && STATUS_WORD[st], p.nextDue && `next ${dateLabel(p.nextDue)}`, p.deadline && `deadline ${dateLabel(p.deadline)}`, via),
      lead: { kind: "progress", of: p.name, value: p.total ? p.done / p.total : 0 },
      route: { kind: "project", slug: p.slug },
      score,
      ...(via ? { via } : {}),
    };
  };

  for (const c of l.contacts) {
    const it = personItem(c, 0);
    const s = scoreOf(words, c.name, it.meta);
    if (s > 0) put({ ...it, score: s });
  }
  for (const co of l.companies) {
    const here = peopleAt(co, l.contacts);
    const employs = entries.get(co.id)?.relations.find((r) => r.relation === "employs")?.to ?? [];
    const staff = new Set([...here.map((p) => p.id), ...employs.map((b) => b.id)]);
    const meta = joined(co.description || co.sector, co.location, staff.size > 0 && `${staff.size} ${staff.size === 1 ? "person" : "people"} you know`);
    const s = scoreOf(words, co.name, meta);
    if (s <= 0) continue;
    put({ key: `n:${co.id}`, type: "company", title: co.name, meta, lead: { kind: "square", of: co.name }, route: { kind: "company", slug: slugOf(co.path) }, score: s, folder: co.path.split("/").slice(0, -1).map(folderName).join(" / ") });
    // A company found by its name brings who works there and what it is in.
    if (s < 60) continue;
    for (const c of l.contacts) if (staff.has(c.id)) put(personItem(c, s - 1, `at ${co.name}`));
    const inProjects = new Set((entries.get(co.id)?.relations ?? []).filter((r) => r.relation === "involved_in" || r.relation === "company_involved_in").flatMap((r) => r.to.map((t) => t.id)));
    for (const p of l.projects) if (p.noteId && inProjects.has(p.noteId)) put(projectItem(p, s - 2, `for ${co.name}`));
  }
  for (const p of l.projects) {
    const it = projectItem(p, 0);
    const s = scoreOf(words, p.name, it.meta);
    if (s > 0) put({ ...it, score: s });
  }
  const aboutOf = new Map<string, string>();
  for (const e of l.edges) if (e.relation === "about" && !aboutOf.has(e.from)) aboutOf.set(e.from, e.to);
  const titleOf = new Map(l.tree.map((n) => [n.id, n.title]));
  for (const n of l.nodes) {
    if (n.kind !== "conversation") continue;
    const t = byId.get(n.id);
    const about = aboutOf.get(n.id);
    const meta = joined("with Claude", about && `about ${titleOf.get(about)}`, t && dateLabel(new Date(t.mtimeMs)));
    const s = scoreOf(words, n.title, meta);
    if (s > 0 && t) put({ key: `n:${n.id}`, type: "conversation", title: n.title, meta, lead: { kind: "icon", of: "chat" }, route: { kind: "conversation", slug: slugOf(t.path) }, score: s, folder: t.folder });
  }

  // Say why related rows are here, when they all are for one reason ("4 at Kade Social").
  const via: Record<string, string> = {};
  const list = [...items.values()];
  for (const [group, type] of [["people", "person"], ["projects", "project"]] as const) {
    const rows = list.filter((i) => i.type === type);
    const reasons = new Set(rows.map((r) => r.via ?? ""));
    if (rows.length > 0 && reasons.size === 1 && [...reasons][0]) via[group] = `${rows.length} ${[...reasons][0]}`;
  }
  return { items: list, via };
}

/** The server's note search, as notes (and conversations), less what is already found as itself. */
export function noteItems(hits: SearchHit[], l: Lists, taken: Set<string>, words: string[]): Item[] {
  const byId = new Map(l.tree.map((n) => [n.id, n]));
  const kind = new Map(l.nodes.map((n) => [n.id, n.kind]));
  const typed = new Set([...l.contacts.map((c) => c.id), ...l.companies.map((c) => c.id), ...l.projects.map((p) => p.noteId).filter((x): x is string => !!x)]);
  return hits
    .filter((h) => !taken.has(`n:${h.id}`) && !typed.has(h.id))
    .map((h, i) => {
      const t = byId.get(h.id);
      const conversation = kind.get(h.id) === "conversation";
      const folder = h.path.split("/").slice(0, -1).map(folderName).join(" / ");
      return {
        key: `n:${h.id}`,
        type: (conversation ? "conversation" : "note") as FindType,
        title: h.title,
        meta: joined(conversation && "with Claude", folder || "The top of your notes", t && dateLabel(new Date(t.mtimeMs))),
        lead: { kind: "icon" as const, of: conversation ? "chat" : "doc" },
        route: conversation ? { kind: "conversation" as const, slug: slugOf(h.path) } : { kind: "notes" as const, path: notePath(h.path) },
        // A step below a person, company or project matched as well (the board puts them first),
        // a name that matches above a mention, and the server's order among equals.
        score: Math.max(scoreOf(words, h.title) - 25, 1) - i / 1000,
        folder,
      };
    });
}
