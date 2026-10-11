/**
 * Where a name in Ask Orr leads (structure.md §1.7: every name opens its thing), and which note
 * the panel is looking at.
 *
 * A note opens as what it is: a project's note opens the project page, a #contact note the
 * person, a #company note the company, anything else the note itself, at its address. The open
 * page's note goes with every question as `contextNoteId` (AI-012), so "what does this depend
 * on?" reads the note you are on; the server checks it can be read, as for any note.
 */
import { entitySlug } from "../mail/people.js";
import { noteForLink, type LinkRef } from "../notes/links.js";
import type { Route } from "../ui/router.js";
import type { Target } from "./working.js";

export interface VaultNote {
  id: string;
  path: string;
  title: string;
  tags: string[];
}

/** What the panel knows of the vault: the tree and the projects, as the server sent them. */
export interface Vault {
  tree: VaultNote[];
  projects: { slug: string; noteId: string | null }[];
}

export const EMPTY_VAULT: Vault = { tree: [], projects: [] };

const notePath = (path: string) => path.replace(/\.md$/i, "");
const isPerson = (n: VaultNote) => n.tags.includes("contact");
const isCompany = (n: VaultNote) => n.tags.includes("company");

/** The page a note opens: its project, person, company, or the note. */
export function noteRoute(id: string, v: Vault): Route {
  const project = v.projects.find((p) => p.noteId === id);
  if (project) return { kind: "project", slug: project.slug };
  const n = v.tree.find((x) => x.id === id);
  if (!n) return { kind: "notes", id };
  if (isPerson(n)) return { kind: "person", slug: entitySlug(n.path) };
  if (isCompany(n)) return { kind: "company", slug: entitySlug(n.path) };
  return { kind: "notes", path: notePath(n.path) };
}

/** The page a step's find opens. */
export function targetRoute(t: Target, v: Vault): Route {
  switch (t.kind) {
    case "note":
      return noteRoute(t.id, v);
    case "project":
      return { kind: "project", slug: t.slug };
    case "mail":
      return { kind: "mail", id: String(t.uid) };
    case "waiting":
      return { kind: "mail", waiting: true };
    case "day":
      return { kind: "planning", scale: "day", at: t.date };
  }
}

/** A note's title, for a find that came back as an id alone (a step added to a note). */
export const titleOf = (id: string, v: Vault): string | undefined => v.tree.find((n) => n.id === id)?.title;

/**
 * The note the page is about, sent with each question: the open note, the project's note, the
 * person's or company's note, a conversation or a document. Nothing on the other pages.
 */
export function contextNoteOf(route: Route, v: Vault): string | undefined {
  switch (route.kind) {
    case "notes":
      if (route.id) return route.id;
      return route.path ? v.tree.find((n) => notePath(n.path) === route.path)?.id : undefined;
    case "project":
      return v.projects.find((p) => p.slug === route.slug)?.noteId ?? undefined;
    case "person":
      return v.tree.find((n) => isPerson(n) && entitySlug(n.path) === route.slug)?.id;
    case "company":
      return v.tree.find((n) => isCompany(n) && entitySlug(n.path) === route.slug)?.id;
    case "conversation":
      return v.tree.find((n) => entitySlug(n.path) === route.slug)?.id;
    case "document":
      return v.tree.find((n) => notePath(n.path) === notePath(route.path))?.id;
    default:
      return undefined;
  }
}

/**
 * The note a `[[citation]]` names. Notes Orr read in this conversation come first, by the title
 * or path his tools returned (that is the note he means); then the vault's own order, as the
 * editor follows a link: a path, a file name, a title (notes/links.ts).
 */
export function citedNote(target: string, seen: LinkRef[], v: Vault): string | null {
  return noteForLink(target, seen, v.tree);
}
