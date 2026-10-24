/**
 * The project page's small edits, as text transforms (1E): one line of a `##` section changed,
 * removed or moved under the steps, and a note's `project/<slug>` tag put on or taken off. Each
 * returns the note's new text, or says why it won't; routes/projects.ts writes it through
 * `VaultStore.write`. Every other byte of the note stays.
 */
import { appendToSection, readSection, readSectionItems, updateFrontmatter, writeSection } from "@orrama/core";

/** Where a step goes in a project note: Add a step, New → Task and the task card all say `## Tasks`. */
export const STEPS_SECTION = "Tasks";

/** A line's list marker and checkbox, kept when its words change: `- `, `  * `, `- [ ] `. */
const MARK = /^(\s*[-*]\s+(?:\[[ xX/b]\]\s+)?)/;

/** "**2026-10-06** — MASE over MAPE": a decision keeps its day when its words change. */
const DATED = /^(\*\*\d{4}-\d{2}-\d{2}\*\*\s*[—–-]\s*)/;

export type LineEdit =
  | { ok: true; content: string }
  | { ok: false; status: 409; why: string };

const CHANGED = "That line changed since the page was opened, so nothing was written. Look again.";

/**
 * The section's lines and which of them is item `index` (readSectionItems' numbering: every
 * line with words), checked against the item the page saw. A note changed underneath (a line
 * added in Obsidian, the agent appending a decision) is a 409, never an edit to whichever line
 * slid into place.
 */
function locate(content: string, heading: string, index: number, seen: string) {
  const body = readSection(content, heading);
  const items = readSectionItems(content, heading);
  if (!Number.isInteger(index) || index < 0 || items[index] !== seen) return null;
  const lines = body.split("\n");
  let n = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.replace(MARK, "").trim() === "") continue;
    if (++n === index) return { body, lines, at: i };
  }
  return null;
}

/** Change item `index`'s words: its marker, checkbox and (for a decision) its day stay. */
export function changeLine(content: string, heading: string, index: number, seen: string, words: string): LineEdit {
  const to = words.replace(/\s+/g, " ").trim();
  const hit = locate(content, heading, index, seen);
  if (!hit) return { ok: false, status: 409, why: CHANGED };
  const line = hit.lines[hit.at]!;
  const mark = MARK.exec(line)?.[1] ?? line.match(/^\s*/)![0];
  const rest = line.slice(mark.length).trim();
  const day = DATED.exec(rest)?.[1] ?? "";
  hit.lines[hit.at] = `${mark}${day}${to}`;
  return { ok: true, content: writeSection(content, heading, hit.lines.join("\n")) };
}

/** Take item `index` out of its section; the heading stays, empty or not. */
export function removeLine(content: string, heading: string, index: number, seen: string): LineEdit {
  const hit = locate(content, heading, index, seen);
  if (!hit) return { ok: false, status: 409, why: CHANGED };
  hit.lines.splice(hit.at, 1);
  const body = hit.lines.join("\n").replace(/^(?:[ \t]*\n)+/, "").replace(/(?:\n[ \t]*)+$/, "");
  return { ok: true, content: writeSection(content, heading, body.trim() === "" ? "" : body) };
}

/** An inbox line becomes a step: out of the Inbox, `- [ ] <words>` at the end of `## Tasks`. */
export function lineToStep(content: string, heading: string, index: number, seen: string): LineEdit {
  const removed = removeLine(content, heading, index, seen);
  if (!removed.ok) return removed;
  const words = seen.replace(DATED, "").trim();
  return { ok: true, content: appendToSection(removed.content, STEPS_SECTION, `- [ ] ${words}`) };
}

/** A note's front-matter tags as a list: `tags:` (a list or a comma/space string), else `tag:`. */
function tagsOf(d: Record<string, unknown>): { key: "tags" | "tag"; list: string[] } {
  const key = d["tags"] === undefined && d["tag"] !== undefined ? "tag" : "tags";
  const raw = d[key];
  const list = Array.isArray(raw) ? raw.map(String) : typeof raw === "string" ? raw.split(/[,\s]+/).filter(Boolean) : [];
  return { key, list: list.map((t) => t.replace(/^#/, "")) };
}

/**
 * Put `project/<slug>` on a note (it joins the project), taking off any other `project/…` tag
 * it carried, since a note belongs to one project (the first tag would win and it would not
 * move). The note's own `project` tag is left alone. Null when the front matter can't be
 * read: nothing is written.
 */
export function withProjectTag(content: string, slug: string): string | null {
  const tag = `project/${slug}`;
  const next = updateFrontmatter(content, (d) => {
    const { key, list } = tagsOf(d);
    const kept = list.filter((t) => !/^project\//i.test(t) || t === tag);
    if (!kept.includes(tag)) kept.push(tag);
    return { ...d, [key]: kept };
  });
  return next === content ? null : next;
}

/** Take `project/<slug>` off a note; its other tags stay, `tags:` goes with its last one. Null when it can't. */
export function withoutProjectTag(content: string, slug: string): string | null {
  const tag = `project/${slug}`;
  const next = updateFrontmatter(content, (d) => {
    const { key, list } = tagsOf(d);
    const kept = list.filter((t) => t !== tag);
    return { ...d, [key]: kept.length ? kept : undefined };
  });
  return next === content ? null : next;
}
