import YAML from "yaml";

export interface FrontmatterResult {
  data: Record<string, unknown>;
  /** Line index where the body starts (0 if no front-matter). */
  bodyStart: number;
  /** Raw front-matter text between the fences, "" if none. */
  raw: string;
}

const FENCE = "---";

/** Extract YAML front-matter. Tolerant: malformed YAML yields empty data but preserves the body. */
export function parseFrontmatter(content: string): FrontmatterResult {
  const lines = content.split("\n");
  if (lines[0]?.trim() !== FENCE) return { data: {}, bodyStart: 0, raw: "" };
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === FENCE) {
      const raw = lines.slice(1, i).join("\n");
      let data: Record<string, unknown> = {};
      try {
        const parsed = YAML.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          data = parsed as Record<string, unknown>;
        }
      } catch {
        // Malformed YAML: treat as no metadata rather than failing the note.
      }
      return { data, bodyStart: i + 1, raw };
    }
  }
  return { data: {}, bodyStart: 0, raw: "" };
}

/** Serialize front-matter data + body back to file content. */
export function withFrontmatter(data: Record<string, unknown>, body: string): string {
  if (Object.keys(data).length === 0) return body;
  const yaml = YAML.stringify(data).trimEnd();
  return `${FENCE}\n${yaml}\n${FENCE}\n${body}`;
}

/** Update front-matter of an existing file, preserving the body byte-for-byte. */
export function updateFrontmatter(
  content: string,
  update: (data: Record<string, unknown>) => Record<string, unknown>,
): string {
  const { data, bodyStart } = parseFrontmatter(content);
  const body = content.split("\n").slice(bodyStart).join("\n");
  return withFrontmatter(update({ ...data }), body);
}
