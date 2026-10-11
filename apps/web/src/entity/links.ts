/**
 * Where a note opens (structure.md §1.2, §1.7 #1): a person's or a company's entity page, a
 * project's page, a conversation's or a document's entity page, else the note in Notes. One
 * rule for every surface that names a note (Find, Orr noticed, the entity pages' relations), so
 * a name opens the same thing wherever it is.
 *
 * Kinds follow the app's own pages, not the ontology alone, so a vault without an ontology note
 * still opens people and companies at their pages: a person is a `#contact` note and a company
 * a `#company` note (as People lists them), a project a note the Projects board lists, a
 * conversation a saved chat (`type: conversation` / `claude-session`). The ontology's `document`
 * type adds documents.
 */
import type { MouseEvent } from "react";
import { navigate, routeHref, type Route } from "../ui/router.js";

/** A file name as an address part: "Ines Vermaat.md" → "ines-vermaat" (§1.2: slugs come from the file name). */
export function slugOf(path: string): string {
  const name = path.split("/").pop()!.replace(/\.md$/i, "");
  return (
    name
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "") || "note"
  );
}

export type Kind = "person" | "company" | "project" | "conversation" | "document" | "note";

/** What the app knows about which notes are what, from the lists its pages already read. */
export interface Known {
  people: Set<string>;
  companies: Set<string>;
  /** Project note id → the project's slug. */
  projects: Map<string, string>;
  conversations: Set<string>;
}

export const NOTHING_KNOWN: Known = { people: new Set(), companies: new Set(), projects: new Map(), conversations: new Set() };

/** What a note is to the app: its own page first, the ontology's type after. */
export function kindOf(note: { id: string; type?: string }, known: Known): Kind {
  if (known.people.has(note.id)) return "person";
  if (known.companies.has(note.id)) return "company";
  if (known.projects.has(note.id)) return "project";
  if (known.conversations.has(note.id) || note.type === "conversation") return "conversation";
  if (note.type === "document") return "document";
  return "note";
}

/** The note's address, without ".md": what `/notes/<path>` takes. */
export const notePath = (path: string) => path.replace(/\.md$/i, "");

/** The address a note opens at. */
export function routeOf(note: { id: string; path: string; type?: string }, known: Known): Route {
  switch (kindOf(note, known)) {
    case "person":
      return { kind: "person", slug: slugOf(note.path) };
    case "company":
      return { kind: "company", slug: slugOf(note.path) };
    case "project":
      return { kind: "project", slug: known.projects.get(note.id)! };
    case "conversation":
      return { kind: "conversation", slug: slugOf(note.path) };
    case "document":
      return { kind: "document", path: note.path };
    default:
      return { kind: "notes", path: notePath(note.path) };
  }
}

/** The note a slug names among these, first by path when two files share a name. */
export function bySlug<T extends { path: string }>(list: T[], slug: string): T | undefined {
  return [...list].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).find((x) => slugOf(x.path) === slug);
}

/** A link inside the app: a real href, and a plain click moves without a reload. */
export const linkTo = (r: Route) => ({ href: routeHref(r), onOpen: () => navigate(r) });

/** An `<a>`'s href and onClick from a link: a plain click moves in the app, a modified one is the browser's. */
export const anchor = (l: { href: string; onOpen: () => void }) => ({
  href: l.href,
  onClick: (e: MouseEvent) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    l.onOpen();
  },
});
