/**
 * The life areas as a reader sees them: the list from the first `#vault-categories` note they can
 * read (core vaultCategories.ts), or the starter list, and each note's area under it. Every
 * surface that sends an area (the tree, Settings → Notes) asks here, so a note is in one area
 * everywhere.
 */
import { areaOfNote, areaRules, canRead, lifeAreasOf, LIFE_AREAS_TAG, type AclUser, type IndexedNote, type LifeArea, type VaultCategoryRule } from "@orrama/core";
import type { VaultStore } from "./vaultStore.js";

export interface AreasView {
  areas: LifeArea[];
  rules: VaultCategoryRule[];
  /** The note that holds the list, if the reader can read one. */
  note: IndexedNote | undefined;
  /** The registered projects' own notes: the notes whose `area:` counts. */
  projects: Set<string>;
}

/** The areas note the reader would read: the first tagged note by path, as the tree always took it. */
export function areasNoteFor(store: VaultStore, user: AclUser): IndexedNote | undefined {
  const grants = store.grants();
  return store.index
    .all()
    .filter((n) => n.tags.some((t) => t.tag === LIFE_AREAS_TAG) && canRead(user, n, grants))
    .sort((a, b) => a.path.localeCompare(b.path))[0];
}

export function areasFor(store: VaultStore, user: AclUser): AreasView {
  const note = areasNoteFor(store, user);
  const areas = lifeAreasOf(note?.content);
  return { areas, rules: areaRules(areas), note, projects: store.projectNoteIds() };
}

/** A note's area id under a view. */
export function areaOf(n: IndexedNote, view: AreasView) {
  return areaOfNote({ path: n.path, tags: n.tags.map((t) => t.tag), frontmatter: n.frontmatter, project: view.projects.has(n.id) }, view.areas, view.rules);
}
