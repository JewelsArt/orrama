/**
 * A one-line gist of a note, so a reader (the map's hover, a model scanning
 * ninety-eight conversations) can triage without reading it.
 *
 * Extractive and free — no model: the note's own `description:` (or
 * `summary:`) if the author wrote one, else the first real sentence of the
 * body, skipping headings, quotes, list markers, links and images, which say
 * nothing about content. A saved conversation has no prose of its own, only a
 * header (`**Date:**`, `**Session:**`) and turns, so its gist is Jules's
 * opening message — what he asked for. That is a weak summary on its own,
 * which is why a model-written `description:` (written to the note's front
 * matter once approved) always wins over it.
 */
import { isoLocal } from "./dates.js";
import { parseFrontmatter } from "./frontmatter.js";

export const DESCRIPTION_MAX = 220;

const clean = (line: string) =>
  line
    .replace(/^[-*+]\s+(\[[ xX/b]\]\s+)?/, "")
    .replace(/!?\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, t: string, a?: string) => a ?? t)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim();

const cut = (s: string) => (s.length > DESCRIPTION_MAX ? `${s.slice(0, DESCRIPTION_MAX - 1).trimEnd()}…` : s);

export function describeNote(n: { frontmatter: Record<string, unknown>; content: string; kind?: "note" | "conversation" }): string {
  const fm = n.frontmatter["description"] ?? n.frontmatter["summary"];
  if (typeof fm === "string" && fm.trim() !== "") return cut(fm.trim());
  const lines = n.content.split("\n").slice(parseFrontmatter(n.content).bodyStart);

  if (n.kind === "conversation") {
    // The first turn is Jules's. A turn can run over several lines: take until the next speaker.
    const at = lines.findIndex((l) => /^\*\*Jules:\*\*/.test(l.trim()));
    if (at !== -1) {
      const turn: string[] = [lines[at]!.trim().replace(/^\*\*Jules:\*\*\s*/, "")];
      for (const l of lines.slice(at + 1)) {
        if (/^\*\*[^*]+:\*\*/.test(l.trim())) break;
        turn.push(l);
      }
      const text = clean(turn.join(" "));
      if (text.length > 1) return cut(text);
    }
  }

  let inFence = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || line === "" || line.startsWith("#") || line.startsWith(">")) continue;
    if (/^(\||-{3,}|\*{3,})/.test(line)) continue;
    if (n.kind === "conversation" && /^\*\*(Date|Session|Working dir):\*\*/.test(line)) continue;
    const text = clean(n.kind === "conversation" ? line.replace(/^\*\*[^*]+:\*\*\s*/, "") : line);
    if (text.length > 1) return cut(text);
  }
  return "";
}

/**
 * Is this title only an id? A saved session's note is often titled by its session id
 * (`title: 394a1725`) or named after it (`c0ffee12-bead.md`), and Orr noticed then said
 * "394a1725 isn't about anything yet" (F3). An id title is the note's own id (`n-…`), or a
 * run of hex in dash-separated groups, at least eight hex characters, holding a digit and a
 * letter: so a real word that happens to be hex ("facade", "decade") and a number or a date
 * ("20261014", "2026-10") stay names.
 */
export function isIdTitle(title: string, noteId?: string): boolean {
  const t = title.trim();
  if (t === "") return false;
  if (noteId !== undefined && t === noteId) return true;
  if (/^n-[0-9a-z]{8,}$/.test(t)) return true;
  if (!/^[0-9a-f]+(?:-[0-9a-f]+)*$/i.test(t)) return false;
  const hex = t.replace(/-/g, "");
  return hex.length >= 8 && /[0-9]/.test(hex) && /[a-f]/i.test(hex);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** NAME_GIST_MAX characters of gist at most in a name, cut at a word. */
export const NAME_GIST_MAX = 60;

/** "2026-06-04" (or an ISO time on that day) as "4 Jun 2026"; anything else as null. */
function dayWords(v: unknown): string | null {
  const m = typeof v === "string" ? /^(\d{4})-(\d{2})-(\d{2})/.exec(v.trim()) : null;
  if (!m) return null;
  const month = MONTHS[Number(m[2]) - 1];
  const day = Number(m[3]);
  return month && day >= 1 && day <= 31 ? `${day} ${month} ${m[1]}` : null;
}

/** The first words of a gist, whole words only, for a name. */
function firstWords(gist: string): string {
  // A name sits inside sentences ("… isn't about anything yet"): no full stop of its own.
  const g = gist.replace(/…$/, "").trim().replace(/[.!?;:,]+$/, "");
  if (g.length <= NAME_GIST_MAX) return g;
  const cutAt = g.lastIndexOf(" ", NAME_GIST_MAX - 1);
  return `${g.slice(0, cutAt > NAME_GIST_MAX / 2 ? cutAt : NAME_GIST_MAX - 1).replace(/[\s,;:.–—-]+$/, "")}…`;
}

/**
 * The name a note is shown by. Its title, unless the title is only an id (isIdTitle): then its
 * kind and date plus its gist, "Conversation, 4 Jun 2026: Tidying the reading list…". The date
 * is the front matter's `date:` (else `created:`, else the file's time, `mtimeMs`), the gist
 * describeNote's. Display only: the note, its title and its links are untouched.
 */
export function displayTitle(n: {
  title: string;
  id?: string;
  frontmatter: Record<string, unknown>;
  content: string;
  kind?: "note" | "conversation";
  mtimeMs?: number;
}): string {
  if (!isIdTitle(n.title, n.id)) return n.title;
  const kind = n.kind === "conversation" ? "Conversation" : "Note";
  const fileDay = n.mtimeMs !== undefined && Number.isFinite(n.mtimeMs) ? isoLocal(new Date(n.mtimeMs)) : undefined;
  const day = dayWords(n.frontmatter["date"]) ?? dayWords(n.frontmatter["created"]) ?? dayWords(fileDay);
  const head = day ? `${kind}, ${day}` : kind;
  const gist = describeNote(n);
  return gist ? `${head}: ${firstWords(gist)}` : head;
}
