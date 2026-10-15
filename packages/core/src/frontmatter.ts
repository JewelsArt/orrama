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
  /**
   * True when a fenced block parsed but is not a mapping of properties: prose
   * between two `---` rules (a thematic break on line 1), a bare list, only
   * comments. `data` is empty here too, and the block is still the user's
   * text — it must not be rebuilt from `data` any more than a malformed one
   * (audit STO-002).
   */
  notMapping: boolean;
}

const FENCE = "---";

/** Where a note's front matter sits in its text, by character offset. */
interface Located {
  /** A leading U+FEFF, kept at byte 0 whatever is inserted after it. */
  bom: string;
  /** The block's line ending — or, with no block, the file's first one. */
  eol: string;
  /** Offset just past the opening fence line (where the block's text starts), -1 when there is no block. */
  open: number;
  /** Offset of the closing fence line. */
  close: number;
  /** Offset where the body starts. */
  body: number;
  /** Line index where the body starts, as `content.split("\n")` counts. */
  bodyStart: number;
}

function locate(content: string): Located {
  const bom = content.startsWith("\uFEFF") ? "\uFEFF" : "";
  const nl = content.indexOf("\n");
  const eol = nl > 0 && content[nl - 1] === "\r" ? "\r\n" : "\n";
  const none: Located = { bom, eol, open: -1, close: -1, body: bom.length, bodyStart: 0 };
  // trim() also drops the BOM and a CRLF's "\r".
  if (nl < 0 || content.slice(0, nl).trim() !== FENCE) return none;
  let at = nl + 1;
  for (let line = 1; at <= content.length; line++) {
    const end = content.indexOf("\n", at);
    const text = content.slice(at, end < 0 ? content.length : end);
    if (text.trim() === FENCE) {
      return { bom, eol, open: nl + 1, close: at, body: end < 0 ? content.length : end + 1, bodyStart: line + 1 };
    }
    if (end < 0) break;
    at = end + 1;
  }
  return none;
}

/** Split keeping each line's own terminator. */
const splitLines = (s: string): string[] => (s === "" ? [] : s.split(/(?<=\n)/));
/** A line without its terminator, CRLF's "\r" included. */
const bare = (line: string) => line.replace(/\r?\n$/, "");

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Extract YAML front-matter. Tolerant: malformed YAML yields empty data but preserves the body. */
export function parseFrontmatter(content: string): FrontmatterResult {
  const at = locate(content);
  if (at.open < 0) return { data: {}, bodyStart: 0, raw: "", malformed: false, notMapping: false };
  // Lines are read without their "\r": in a CRLF note the last value used to
  // keep it ("active\r"), or a flow list on the last line failed to parse
  // (audit STO-005).
  const raw = splitLines(content.slice(at.open, at.close)).map(bare).join("\n");
  let data: Record<string, unknown> = {};
  let malformed = false;
  let notMapping = false;
  try {
    const parsed: unknown = YAML.parse(raw);
    if (isPlainObject(parsed)) data = parsed;
    else notMapping = raw.trim() !== "";
  } catch {
    // Reading a malformed block as "no metadata" is right; WRITING it back
    // that way is not. The flag is what lets callers tell the difference.
    malformed = true;
  }
  return { data, bodyStart: at.bodyStart, raw, malformed, notMapping };
}

/** Serialize front-matter data + body back to file content. */
export function withFrontmatter(data: Record<string, unknown>, body: string): string {
  if (Object.keys(data).length === 0) return body;
  const yaml = YAML.stringify(data).trimEnd();
  return `${FENCE}\n${yaml}\n${FENCE}\n${body}`;
}

/** `key: value` as YAML lines, each without a terminator. Never folded. */
const pairLines = (key: string, value: unknown): string[] =>
  new YAML.Document({ [key]: value }).toString({ lineWidth: 0 }).replace(/\n$/, "").split("\n");

/** A scalar's YAML on one line, or null when it would need several. */
const inlineScalar = (value: unknown): string | null => {
  if (value !== null && !["string", "number", "boolean"].includes(typeof value)) return null;
  const text = new YAML.Document(value).toString({ lineWidth: 0 }).replace(/\n$/, "");
  return text.includes("\n") ? null : text;
};

/** Key order and `undefined` values ignored: what YAML would read back. */
const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) =>
    isPlainObject(x) ? Object.fromEntries(Object.keys(x).sort().filter((k) => x[k] !== undefined).map((k) => [k, x[k]])) : x,
  );

/**
 * The block's new lines, editing only the lines of the keys that changed:
 * a changed scalar is replaced in place on its line (a trailing comment
 * stays), any other change replaces that pair's lines, a new key is a new
 * line at the top (when the updater put it first, as `{ id, ...d }` does) or
 * the bottom, a removed key loses its lines. Null when an edit does not fit
 * that shape — the caller then falls back to re-serialising.
 */
function editLines(
  blockLines: string[],
  raw: string,
  data: Record<string, unknown>,
  next: Record<string, unknown>,
  eol: string,
): string[] | null {
  const doc = YAML.parseDocument(raw);
  if (!YAML.isMap(doc.contents)) {
    // An empty block (`---` then `---`) has no map to edit; new keys only.
    if (raw.trim() !== "") return null;
  }
  const items = YAML.isMap(doc.contents) ? (doc.contents.items as YAML.Pair[]) : [];
  const starts: number[] = [];
  for (let i = 0, off = 0; i < blockLines.length; i++) {
    starts.push(off);
    off += bare(blockLines[i]!).length + 1;
  }
  const lineOf = (off: number) => {
    let k = 0;
    while (k + 1 < starts.length && starts[k + 1]! <= off) k++;
    return k;
  };
  const keyOf = (p: YAML.Pair) => (YAML.isScalar(p.key) ? String(p.key.value) : null);
  const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);

  // Line-range replacements over blockLines: [from, to) → lines.
  const edits: { from: number; to: number; lines: string[] }[] = [];
  const spanOf = (p: YAML.Pair): [number, number] | null => {
    const k = p.key as YAML.Node | null;
    if (!k?.range) return null;
    const v = p.value as YAML.Node | null;
    let end = v?.range ? v.range[2] : k.range[2];
    while (end > k.range[0] && (raw[end - 1] === "\n" || raw[end - 1] === " ")) end--;
    const first = lineOf(k.range[0]);
    // Only a key that starts its own line owns whole lines.
    if (starts[first] !== k.range[0]) return null;
    return [first, lineOf(Math.max(end - 1, k.range[0])) + 1];
  };
  const terminated = (texts: string[]) => texts.map((t) => t + eol);

  for (const key of Object.keys(data)) {
    if (key in next && same(data[key], next[key])) continue;
    const pair = items.find((p) => keyOf(p) === key);
    if (!pair) return null;
    const span = spanOf(pair);
    if (!(key in next)) {
      if (!span) return null;
      edits.push({ from: span[0], to: span[1], lines: [] });
      continue;
    }
    const v = pair.value as YAML.Node | null;
    const text = inlineScalar(next[key]);
    if (text !== null && YAML.isScalar(v) && v.range && v.range[1] > v.range[0] && lineOf(v.range[0]) === lineOf(v.range[1] - 1)) {
      const k = lineOf(v.range[0]);
      const line = blockLines[k]!;
      const from = v.range[0] - starts[k]!;
      const to = v.range[1] - starts[k]!;
      edits.push({ from: k, to: k + 1, lines: [bare(line).slice(0, from) + text + bare(line).slice(to) + line.slice(bare(line).length)] });
      continue;
    }
    if (!span) return null;
    edits.push({ from: span[0], to: span[1], lines: terminated(pairLines(key, next[key])) });
  }

  const order = Object.keys(next);
  const added = order.filter((k) => !(k in data));
  const top = added.filter((k) => order.indexOf(k) === added.indexOf(k)); // a run of new keys at the front
  const bottom = added.filter((k) => !top.includes(k));
  if (top.length) edits.push({ from: 0, to: 0, lines: terminated(top.flatMap((k) => pairLines(k, next[k]))) });
  if (bottom.length) edits.push({ from: blockLines.length, to: blockLines.length, lines: terminated(bottom.flatMap((k) => pairLines(k, next[k]))) });

  // Spans never overlap (one per key); apply from the bottom up.
  const out = [...blockLines];
  for (const e of edits.sort((a, b) => b.from - a.from || b.to - a.to)) out.splice(e.from, e.to - e.from, ...e.lines);
  return out;
}

/**
 * Update front-matter of an existing file, preserving the body byte-for-byte
 * and every front-matter line the update did not touch (audit STO-007: the
 * old `doc.toString()` folded long values at 80 columns, re-spaced flow lists
 * and re-indented sequences in every note it stamped).
 *
 * Returns the content UNCHANGED when the result would not read back as
 * exactly `next` with the body intact — front matter that does not parse,
 * a `---` block that is not a mapping (STO-002), anything this cannot edit
 * faithfully. Rewriting it would mean serialising over text that is still
 * sitting in the file, so the safe move is to leave the note alone and let
 * the caller decide what to report. Callers that need to know should check
 * `parseFrontmatter(content)` themselves (or use `stampId`) — this is the
 * backstop, not the diagnosis.
 *
 * A CRLF note stays CRLF, and a BOM stays at byte 0 (STO-005, STO-007).
 */
export function updateFrontmatter(
  content: string,
  update: (data: Record<string, unknown>) => Record<string, unknown>,
): string {
  const fm = parseFrontmatter(content);
  if (fm.malformed || fm.notMapping) return content;
  const at = locate(content);
  const body = content.slice(at.body);
  const updated = update({ ...fm.data });
  const next = Object.fromEntries(Object.entries(updated).filter(([, v]) => v !== undefined));
  // Nothing to change: leave the file exactly as written, spacing and all.
  const unchanged = canonical(fm.data) === canonical(next) && Object.keys(fm.data).join("\0") === Object.keys(next).join("\0");
  if (unchanged) return content;

  const reads = (out: string) => {
    const back = parseFrontmatter(out);
    return !back.malformed && !back.notMapping && canonical(back.data) === canonical(next) && out.slice(locate(out).body) === body && out.startsWith(at.bom);
  };

  if (at.open < 0) {
    if (Object.keys(next).length === 0) return content;
    const block = Object.entries(next).flatMap(([k, v]) => pairLines(k, v));
    const out = at.bom + [FENCE, ...block, FENCE].join(at.eol) + at.eol + body;
    return reads(out) ? out : content;
  }

  const head = content.slice(0, at.open);
  const foot = content.slice(at.close, at.body);
  const blockLines = splitLines(content.slice(at.open, at.close));
  // The block's own line ending, from its opening fence.
  const eol = head.endsWith("\r\n") ? "\r\n" : "\n";
  const edited = editLines(blockLines, fm.raw, fm.data, next, eol);
  if (edited) {
    const out = edited.every((l) => bare(l).trim() === "") && Object.keys(next).length === 0 ? at.bom + body : head + edited.join("") + foot + body;
    if (reads(out)) return out;
  }

  // Fallback: edit the parsed document and re-serialise the block, still
  // never folding, keeping comments and quoting (yaml's Document does).
  const doc = YAML.parseDocument(fm.raw);
  if (!YAML.isMap(doc.contents)) {
    if (fm.raw.trim() !== "") return content;
    doc.contents = doc.createNode({}) as unknown as typeof doc.contents;
  }
  const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
  for (const key of Object.keys(fm.data)) if (!(key in next)) doc.delete(key);
  for (const [key, value] of Object.entries(next)) if (!(key in fm.data) || !same(fm.data[key], value)) doc.set(key, value);
  // New keys go where the updater put them — `{ id, ...d }` means id first.
  const order = Object.keys(next);
  const map = doc.contents as YAML.YAMLMap;
  const keyOf = (p: YAML.Pair) => String(YAML.isScalar(p.key) ? p.key.value : p.key);
  map.items.sort((a, b) => order.indexOf(keyOf(a as YAML.Pair)) - order.indexOf(keyOf(b as YAML.Pair)));
  if (map.items.length === 0) return reads(at.bom + body) ? at.bom + body : content;
  const yaml = doc.toString({ lineWidth: 0 }).replace(/\n$/, "").split("\n").join(eol);
  const out = head + yaml + eol + foot + body;
  return reads(out) ? out : content;
}

/** Why a note could not be given an id without touching anything else. */
export type IdStamp = { ok: true; content: string } | { ok: false; reason: string };

/**
 * `content` with its note id set to `id` — added as the first property, or
 * replacing the one it carries — and NOTHING else changed: or the reason it
 * cannot be. The one rule for every id stamp (first index, the watcher, a
 * save, a copy's new id): never rewrite bytes that were not parsed.
 *
 *  - front matter that does not parse is left alone (prior audit B1);
 *  - a leading `---` block that is not a mapping is the user's text (STO-002);
 *  - an `id:` that is not text (a Zettelkasten `id: 202310021230`) is the
 *    user's own field and is not overwritten (STO-003); an empty one is filled.
 *
 * A note that cannot be stamped keeps a stable id another way — the store
 * indexes it under the id it already had for that path.
 */
export function stampId(content: string, id: string): IdStamp {
  const fm = parseFrontmatter(content);
  if (fm.malformed) return { ok: false, reason: "its front matter does not parse (an unquoted colon is the usual cause)" };
  if (fm.notMapping) return { ok: false, reason: "it opens with a --- block that is not a list of properties" };
  const own = fm.data["id"];
  if (own !== undefined && own !== null && typeof own !== "string") {
    return { ok: false, reason: "its own id: is not text, and Orrama does not overwrite it" };
  }
  const out = updateFrontmatter(content, (d) => ("id" in d ? { ...d, id } : { id, ...d }));
  if (parseFrontmatter(out).data["id"] !== id || !oneLineEdit(content, out, "id" in fm.data ? null : `id: ${id}`)) {
    return { ok: false, reason: "an id could not be added without changing other text" };
  }
  return { ok: true, content: out };
}

/**
 * `after` is `before` with one line changed, or with the one line `added`
 * inserted — or, for a note that had no front matter, `before` behind a new
 * block. What a stamp may do; updateFrontmatter's re-serialising fallback (a
 * flow-style `{ … }` block, say) is fine for a property the user set, not
 * for an id stamp.
 */
function oneLineEdit(before: string, after: string, added: string | null): boolean {
  const { bom, open } = locate(before);
  if (open < 0) return after.startsWith(bom) && after.endsWith(before.slice(bom.length));
  const a = after.split("\n");
  const b = before.split("\n");
  if (added === null) return a.length === b.length && a.filter((l, i) => l !== b[i]).length === 1;
  if (a.length !== b.length + 1) return false;
  const i = a.findIndex((l, k) => l !== b[k]);
  return a[i]!.replace(/\r$/, "") === added && a.slice(i + 1).every((l, k) => l === b[i + k]);
}
