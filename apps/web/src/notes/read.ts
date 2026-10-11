/**
 * What the Notes page says about a note, read off its text and the index (structure.md §2.3):
 * how long it is, when it is due, whether it is an ordinary note, how a relation reads in words,
 * a backlink as one clean line. Pure, so each rule has a test.
 */
import { parseFrontmatter } from "@basalt/core";
import { dayMonthLabel, timeLabel, toDate, weekdayLabel } from "../ui/dates.js";

/** The body after the front matter (`bodyStart` is the body's first line). */
export function bodyOf(content: string): string {
  const start = parseFrontmatter(content).bodyStart;
  return start ? content.split("\n").slice(start).join("\n") : content;
}

/** Words in the body, as a reader counts them: Markdown's marks are not words. */
export function wordCount(content: string): number {
  const text = bodyOf(content)
    .replace(/^(```|~~~)[\s\S]*?^\1\s*$/gm, " ") // code is not prose
    .replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (_m, t: string, a?: string) => a ?? t)
    .replace(/^\s*(?:[-*+]|\d+\.)\s+(?:\[[ xX/b]\]\s+)?/gm, "")
    .replace(/[#>*_`~|^\[\]()-]+/g, " ");
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

/** "1,240", the way the board writes a count. */
export const thousands = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** A note's own date it is due: front matter `deadline:` or `due:` (a project's, a draft's). */
export function dueOf(content: string): string | null {
  const d = parseFrontmatter(content).data;
  for (const key of ["deadline", "due"]) {
    const v = d[key];
    const s = v instanceof Date ? v.toISOString().slice(0, 10) : typeof v === "string" ? v.trim() : "";
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  }
  return null;
}

/** `pinned: true` in the front matter (Jules's choice, 11 Oct 2026). */
export function pinnedIn(content: string): boolean {
  const v = parseFrontmatter(content).data["pinned"];
  return v === true || (typeof v === "string" && /^(true|yes)$/i.test(v.trim()));
}

/** A saved conversation (`type: claude-session` or `type: conversation`, as core reads it). */
export function isConversation(content: string): boolean {
  const t = String(parseFrontmatter(content).data["type"] ?? "").trim().toLowerCase();
  return t === "claude-session" || t === "conversation";
}

/** Tags that make a note something other than an ordinary note: a person, a company, the vault's own tables. */
const TYPED_TAGS = new Set(["contact", "company", "vault-ontology", "vault-categories"]);

/**
 * An ordinary note: the only kind *+ Make this a project* belongs on (structure.md §8 #7) — not
 * a project already, not a person, a company, a conversation or the ontology, and not a note
 * the vault's ontology gives a type of its own.
 */
export function isOrdinary(note: { content: string; tags: { tag: string }[] }, opts: { project: boolean; type?: string | null }): boolean {
  if (opts.project) return false;
  if (note.tags.some((t) => TYPED_TAGS.has(t.tag.toLowerCase()) || /^project\//i.test(t.tag))) return false;
  if (isConversation(note.content)) return false;
  return !opts.type || opts.type === "note";
}

/** When a note was last edited, short: "09:52" today, "Tue" this week, "9 Oct" before. */
export function editedLabel(ms: number, now: Date = new Date()): string {
  const d = toDate(ms);
  if (!d) return "";
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ms >= midnight) return timeLabel(d);
  if (ms >= midnight - 6 * 86_400_000) return weekdayLabel(d);
  return dayMonthLabel(d, now);
}

/** A relation's id in words: `works_at` → "works at", `supervised-by` → "supervised by". */
export const relationWords = (id: string) => id.replace(/[_-]+/g, " ").trim();

/** A backlink's line, cleaned: links as their words, no list or task marks, one line. */
export function snippet(context: string): string {
  return context
    .replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (_m, t: string, a?: string) => (a ?? t).trim())
    .replace(/^\s*(?:[-*+]|\d+\.)\s+(?:\[[ xX/b]\]\s+)?/, "")
    .replace(/^#{1,6}\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** A folder's name without the "NN-" ordering prefix of the PARA folders. */
export const folderName = (name: string) => name.replace(/^\d+[-_.\s]+/, "");
