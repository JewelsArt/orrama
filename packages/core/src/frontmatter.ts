import YAML from "yaml";

export interface FrontmatterResult {
  data: Record<string, unknown>;
  /** Line index where the body starts (0 if no front-matter). */
  bodyStart: number;
  /** Raw front-matter text between the fences, "" if none. */
  raw: string;
  /**
   * True when a fenced block was found but YAML could not parse it.
   *
   * Load-bearing. `data` is empty in that case, and it is empty when a note
   * simply has no front matter — the two are indistinguishable without this
   * flag. Anything that REWRITES a note from `data` must check it, or it
   * serialises the empty object over the user's real metadata and the title,
   * tags, aliases, deadline and any `#only/<team>` restriction are gone from
   * the file on disk. One unquoted colon is enough to trigger it:
   * `title: Q3 Review: Ops`.
   */
  malformed: boolean;
}

const FENCE = "---";

/** Extract YAML front-matter. Tolerant: malformed YAML yields empty data but preserves the body. */
export function parseFrontmatter(content: string): FrontmatterResult {
  const lines = content.split("\n");
  if (lines[0]?.trim() !== FENCE) return { data: {}, bodyStart: 0, raw: "", malformed: false };
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === FENCE) {
      const raw = lines.slice(1, i).join("\n");
      let data: Record<string, unknown> = {};
      let malformed = false;
      try {
        const parsed = YAML.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          data = parsed as Record<string, unknown>;
        }
      } catch {
        // Reading a malformed block as "no metadata" is right; WRITING it back
        // that way is not. The flag is what lets callers tell the difference.
        malformed = true;
      }
      return { data, bodyStart: i + 1, raw, malformed };
    }
  }
  return { data: {}, bodyStart: 0, raw: "", malformed: false };
}

/** Serialize front-matter data + body back to file content. */
export function withFrontmatter(data: Record<string, unknown>, body: string): string {
  if (Object.keys(data).length === 0) return body;
  const yaml = YAML.stringify(data).trimEnd();
  return `${FENCE}\n${yaml}\n${FENCE}\n${body}`;
}

/**
 * Update front-matter of an existing file, preserving the body byte-for-byte.
 *
 * Returns the content UNCHANGED when the existing front matter does not parse.
 * Rewriting it would mean serialising an empty object over metadata that is
 * still sitting in the file, so the safe move is to leave the note alone and
 * let the caller decide what to report. Callers that need to know should check
 * `parseFrontmatter(content).malformed` themselves — this is the backstop, not
 * the diagnosis.
 */
export function updateFrontmatter(
  content: string,
  update: (data: Record<string, unknown>) => Record<string, unknown>,
): string {
  const { data, bodyStart, malformed } = parseFrontmatter(content);
  if (malformed) return content;
  const body = content.split("\n").slice(bodyStart).join("\n");
  return withFrontmatter(update({ ...data }), body);
}
