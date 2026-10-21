import type { ProjectFile } from "@orrama/schema/responses";

/**
 * The Reader tab's rules, kept pure: which of a project's documents are pages, in what order,
 * and where each one lives on claude.ai.
 */

/** An .html document is a page: a saved claude.ai artifact, a report. */
export const isPage = (name: string) => /\.html?$/i.test(name);

/** A project's pages by name, the way the folder lists them. */
export const pagesOf = (files: ProjectFile[]): ProjectFile[] =>
  files.filter((f) => isPage(f.name)).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }));

/** "Orrama redesign.html" reads "Orrama redesign". */
export const pageTitle = (name: string) => name.replace(/\.html?$/i, "");

const ARTIFACT = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9_-]+/;

/**
 * The live artifact behind each page, read from the project note: a line that names the file
 * in bold and carries a claude.ai artifact link, as the note's Documents section writes it —
 * `- **Orrama redesign.html**: copy of the claude.ai artifact https://claude.ai/artifact/…`.
 * The note is the only place this is written down; a page with no such line has no link.
 */
export function artifactLinks(note: string): Map<string, string> {
  const links = new Map<string, string>();
  for (const line of note.split(/\r?\n/)) {
    const url = line.match(ARTIFACT)?.[0];
    if (!url) continue;
    for (const m of line.matchAll(/\*\*([^*]+?\.html?)\*\*/gi)) {
      const name = m[1]!.trim();
      if (!links.has(name)) links.set(name, url);
    }
  }
  return links;
}
