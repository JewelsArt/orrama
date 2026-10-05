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
