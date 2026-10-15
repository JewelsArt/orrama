/**
 * What the door may know once you're in: the vault's shape for the gather, and first run's
 * counts. Both are asked only after the server has said yes (the token is set), from endpoints
 * that already filter what this account can read. Before that, the door knows nothing.
 */
import { api, type TreeNote } from "../api.js";
import type { Company, Contact, GraphData, ProjectRow } from "@orrama/schema/responses";
import { CATEGORIES } from "../categories.js";
import type { VaultShape } from "./dots.js";

/** The areas in drawing order, by their colour token; notes in none of them come last. */
const AREAS = CATEGORIES.map((c) => ({ id: c.id, color: c.color.replace(/^var\((--[\w-]+)\)$/, "$1") }));

/** Pure: the shape from the tree, the projects' notes and the people's notes. */
export function shapeOf(tree: TreeNote[], projectNotes: Set<string>, people: Set<string>): VaultShape {
  const known = new Set(AREAS.map((a) => a.id));
  const slots = [...AREAS, { id: "", color: "--c-other" }];
  return {
    areas: slots
      .map(({ id, color }) => {
        const notes = tree.filter((n) => (id ? n.category === id : !known.has(n.category)));
        return {
          color,
          notes: notes.length,
          projects: notes.filter((n) => projectNotes.has(n.id)).length,
          people: notes.filter((n) => people.has(n.id)).length,
        };
      })
      .filter((a) => a.notes > 0),
  };
}

export async function vaultShape(): Promise<VaultShape> {
  const [tree, projects, contacts] = await Promise.all([
    api<TreeNote[]>("GET", "/api/vault/tree"),
    api<ProjectRow[]>("GET", "/api/projects").catch(() => [] as ProjectRow[]),
    api<Contact[]>("GET", "/api/contacts").catch(() => [] as Contact[]),
  ]);
  return shapeOf(tree, new Set(projects.map((p) => p.noteId).filter((id): id is string => !!id)), new Set(contacts.map((c) => c.id)));
}

export interface FirstCounts {
  notes: number;
  people: number;
  companies: number;
  projects: number;
  links: number;
}

/** First run: what the server found in the folder it started with. */
export async function firstRunCounts(): Promise<{ counts: FirstCounts; shape: VaultShape }> {
  const [tree, projects, contacts, companies, graph] = await Promise.all([
    api<TreeNote[]>("GET", "/api/vault/tree"),
    api<ProjectRow[]>("GET", "/api/projects").catch(() => [] as ProjectRow[]),
    api<Contact[]>("GET", "/api/contacts").catch(() => [] as Contact[]),
    api<Company[]>("GET", "/api/companies").catch(() => [] as Company[]),
    api<GraphData>("GET", "/api/vault/graph").catch(() => ({ nodes: [], edges: [] }) as GraphData),
  ]);
  return {
    counts: {
      notes: tree.length,
      people: contacts.length,
      companies: companies.length,
      projects: projects.length,
      // Links someone wrote; a relation only implied by a tag or a field is not one.
      links: graph.edges.filter((e) => !e.implied).length,
    },
    shape: shapeOf(tree, new Set(projects.map((p) => p.noteId).filter((id): id is string => !!id)), new Set(contacts.map((c) => c.id))),
  };
}

/** 1804 → "1,804", the same on every machine. */
const n = (x: number) => String(x).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const plural = (x: number, one: string, many: string) => `${n(x)} ${x === 1 ? one : many}`;

/** "I found 312 notes." */
export function foundLine(c: FirstCounts): string {
  return c.notes === 0 ? "No notes here yet." : `I found ${plural(c.notes, "note", "notes")}.`;
}

/** "41 people, 12 companies, 9 projects and 1,804 links between them." Parts that are zero are left out. */
export function foundDetail(c: FirstCounts): string {
  if (c.notes === 0) return "Write your first one, and it'll be here.";
  const parts = [
    c.people && plural(c.people, "person", "people"),
    c.companies && plural(c.companies, "company", "companies"),
    c.projects && plural(c.projects, "project", "projects"),
  ].filter(Boolean) as string[];
  const links = c.links ? `${plural(c.links, "link", "links")} between them` : "";
  const all = links ? [...parts, links] : parts;
  if (all.length === 0) return "";
  if (all.length === 1) return `${all[0]}.`;
  return `${all.slice(0, -1).join(", ")} and ${all[all.length - 1]}.`;
}

/** The running count while the dots arrive: "184 notes · 24 people · 7 companies · 5 projects". */
export function countingLine(c: FirstCounts, f: number): string {
  const at = (x: number) => Math.round(x * f);
  return [plural(at(c.notes), "note", "notes"), plural(at(c.people), "person", "people"), plural(at(c.companies), "company", "companies"), plural(at(c.projects), "project", "projects")].join(" · ");
}
