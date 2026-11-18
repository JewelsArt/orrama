/**
 * Orrama's entry in Claude Desktop's settings file (`claude_desktop_config.json`), changed the
 * way a careful person would change it by hand: only the `mcpServers.orrama` member is written,
 * every other byte of the file stays as it was (the other servers, Claude's own preferences,
 * their order, spacing and line endings). Parsing and re-printing the whole file would reformat
 * entries Orrama has no business touching.
 *
 * A small JSON reader records where each value and member sits in the text; the change is a
 * splice at those places. Before anything is written the result is parsed again, and every
 * other member's text is compared with the original: if anything else moved, nothing is
 * written. A file that is not JSON, or not shaped like Claude's settings, is left alone and
 * said in plain words.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** The name Orrama's server has in Claude's list. */
export const ENTRY = "orrama";

/** Claude's settings file could not be changed safely; `words` say why, for a person. */
export class ClaudeConfigError extends Error {
  constructor(
    readonly reason: "broken" | "shape" | "unwritable",
    readonly words: string,
  ) {
    super(words);
  }
}

interface Span {
  start: number;
  end: number;
  kind: "object" | "array" | "string" | "number" | "literal";
  members?: Member[];
}
interface Member {
  key: string;
  /** Where the member starts (its key's opening quote) and ends (its value's last character). */
  start: number;
  end: number;
  value: Span;
}

/** JSON with every value's and member's place in the text. Throws a "broken" ClaudeConfigError naming the line. */
function read(text: string): Span {
  let i = 0;
  const lineAt = (at: number) => text.slice(0, at).split("\n").length;
  const fail = (): never => {
    throw new ClaudeConfigError("broken", `Claude's settings file has a mistake in it (line ${lineAt(Math.min(i, text.length))}), so Orrama left it alone.`);
  };
  const ws = () => {
    while (i < text.length && " \t\r\n".includes(text[i]!)) i++;
  };
  const str = (): Span => {
    const start = i;
    if (text[i] !== '"') fail();
    i++;
    while (i < text.length && text[i] !== '"') {
      if (text[i] === "\\") i++;
      else if (text.charCodeAt(i) < 0x20) fail();
      i++;
    }
    if (i >= text.length) fail();
    i++;
    return { start, end: i, kind: "string" };
  };
  const value = (depth: number): Span => {
    if (depth > 64) fail();
    ws();
    const start = i;
    const c = text[i];
    if (c === "{") {
      i++;
      const members: Member[] = [];
      ws();
      if (text[i] === "}") {
        i++;
        return { start, end: i, kind: "object", members };
      }
      for (;;) {
        ws();
        const k = str();
        const key = JSON.parse(text.slice(k.start, k.end)) as string;
        ws();
        if (text[i] !== ":") fail();
        i++;
        const v = value(depth + 1);
        members.push({ key, start: k.start, end: v.end, value: v });
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "}") {
          i++;
          return { start, end: i, kind: "object", members };
        }
        fail();
      }
    }
    if (c === "[") {
      i++;
      ws();
      if (text[i] === "]") {
        i++;
        return { start, end: i, kind: "array" };
      }
      for (;;) {
        value(depth + 1);
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "]") {
          i++;
          return { start, end: i, kind: "array" };
        }
        fail();
      }
    }
    if (c === '"') return str();
    const lit = /^(?:true|false|null)/.exec(text.slice(i, i + 5));
    if (lit) {
      i += lit[0].length;
      return { start, end: i, kind: "literal" };
    }
    const num = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i, i + 64));
    if (num) {
      i += num[0].length;
      return { start, end: i, kind: "number" };
    }
    return fail();
  };
  const root = value(0);
  ws();
  if (i !== text.length) fail();
  return root;
}

const SHAPE = "Claude's settings file isn't laid out the way Claude writes it, so Orrama left it alone.";

/** The text as JSON, BOM apart; `{}` for an empty or missing file. */
function parts(text: string) {
  const bom = text.startsWith("﻿") ? "﻿" : "";
  const body = text.slice(bom.length);
  const empty = body.trim() === "";
  const src = empty ? "{}" : body;
  const root = read(src);
  if (root.kind !== "object") throw new ClaudeConfigError("shape", SHAPE);
  const nl = src.includes("\r\n") ? "\r\n" : "\n";
  // The file's own indent: the space before its first member, else two spaces.
  const first = root.members![0];
  const lead = first ? /(?:^|\n)([ \t]+)$/.exec(src.slice(0, first.start))?.[1] : undefined;
  return { bom, src, root, nl, unit: lead ?? "  ", empty };
}

/** The last member named `key` (JSON.parse, and so Claude, takes the last of two). */
const lastOf = (ms: Member[], key: string): Member | undefined => [...ms].reverse().find((m) => m.key === key);

const serversOf = (root: Span): Member | undefined => lastOf(root.members!, "mcpServers");

/** `value` printed at `depth` (its first line already placed), in the file's indent and line ending. */
const printed = (value: unknown, depth: number, unit: string, nl: string) => JSON.stringify(value, null, unit).split("\n").join(nl + unit.repeat(depth));

/** `src` with a member added at the end of `obj` (an object at `depth`). */
function withMember(src: string, obj: Span, member: string, depth: number, unit: string, nl: string): string {
  const last = obj.members!.at(-1);
  if (last) return `${src.slice(0, last.end)},${nl}${unit.repeat(depth + 1)}${member}${src.slice(last.end)}`;
  return `${src.slice(0, obj.start)}{${nl}${unit.repeat(depth + 1)}${member}${nl}${unit.repeat(depth)}}${src.slice(obj.end)}`;
}

/** `src` without `members[at]` of `obj`, and the comma that went with it. */
function withoutMember(src: string, obj: Span, at: number): string {
  const ms = obj.members!;
  if (ms.length === 1) return `${src.slice(0, obj.start)}{}${src.slice(obj.end)}`;
  if (at < ms.length - 1) return src.slice(0, ms[at]!.start) + src.slice(ms[at + 1]!.start);
  return src.slice(0, ms[at - 1]!.end) + src.slice(ms[at]!.end);
}

/** Every member's own text but `mcpServers.<ENTRY>`'s (and `mcpServers` itself, which holds it). */
function othersOf(src: string): Map<string, string> {
  const root = read(src);
  const out = new Map<string, string>();
  for (const [i, m] of (root.members ?? []).entries()) {
    if (m.key !== "mcpServers") out.set(`root ${i} ${m.key}`, src.slice(m.start, m.end));
    else if (m.value.kind === "object") for (const s of m.value.members!) if (s.key !== ENTRY) out.set(`server ${s.key}`, src.slice(s.start, s.end));
  }
  return out;
}

/** The change kept everything else exactly: else it is not written (a bug here must never cost someone their settings). */
function checkKept(before: string, after: string): void {
  const a = othersOf(before);
  const b = othersOf(after);
  const same = a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);
  if (!same) throw new ClaudeConfigError("shape", SHAPE);
}

/** Orrama's entry as the file has it (undefined when there is none). Throws a ClaudeConfigError on a broken file. */
export function entryOf(text: string): unknown {
  const { src, root } = parts(text);
  const servers = serversOf(root);
  if (!servers) return undefined;
  if (servers.value.kind !== "object") throw new ClaudeConfigError("shape", SHAPE);
  const m = lastOf(servers.value.members!, ENTRY);
  return m ? JSON.parse(src.slice(m.value.start, m.value.end)) : undefined;
}

/** The text with Orrama's entry set to `value` (added, or replaced where it was). */
export function withEntry(text: string, value: unknown): string {
  const { bom, src, root, nl, unit, empty } = parts(text);
  if (empty) return `${bom}${JSON.stringify({ mcpServers: { [ENTRY]: value } }, null, unit).split("\n").join(nl)}${nl}`;
  const servers = serversOf(root);
  let out: string;
  if (!servers) {
    out = withMember(src, root, `"mcpServers": ${printed({ [ENTRY]: value }, 1, unit, nl)}`, 0, unit, nl);
  } else {
    if (servers.value.kind !== "object") throw new ClaudeConfigError("shape", SHAPE);
    const mine = lastOf(servers.value.members!, ENTRY);
    out = mine
      ? src.slice(0, mine.value.start) + printed(value, 2, unit, nl) + src.slice(mine.value.end)
      : withMember(src, servers.value, `${JSON.stringify(ENTRY)}: ${printed(value, 2, unit, nl)}`, 1, unit, nl);
  }
  checkKept(src, out);
  return bom + out;
}

/** The text without every Orrama entry `ours` recognises (an `orrama` someone else wrote stays). */
export function withoutEntry(text: string, ours: (value: unknown) => boolean): { text: string; removed: boolean } {
  const { bom, empty } = parts(text);
  if (empty) return { text, removed: false };
  let src = text.slice(bom.length);
  let removed = false;
  for (;;) {
    const root = read(src);
    const servers = serversOf(root);
    if (!servers) break;
    if (servers.value.kind !== "object") throw new ClaudeConfigError("shape", SHAPE);
    const ms = servers.value.members!;
    const at = ms.findIndex((m) => m.key === ENTRY && ours(JSON.parse(src.slice(m.value.start, m.value.end))));
    if (at < 0) break;
    const next = withoutMember(src, servers.value, at);
    checkKept(src, next);
    src = next;
    removed = true;
  }
  return { text: bom + src, removed };
}

/**
 * Where Claude Desktop keeps its settings: `~/Library/Application Support/Claude` on a Mac,
 * `%APPDATA%\Claude` on Windows (and `~/.config/Claude` elsewhere, where Claude Desktop may run).
 */
export function desktopConfigPath(platform: NodeJS.Platform = process.platform, e: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  if (platform === "win32") return path.join(e.APPDATA || path.join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  return path.join(e.XDG_CONFIG_HOME || path.join(home, ".config"), "Claude", "claude_desktop_config.json");
}

/** The copy of the settings file as it was before Orrama's last change, beside it. */
export const backupPath = (file: string) => `${file}.orrama-backup`;

/**
 * Change Claude Desktop's settings file with `change`, which gets the text ("" when there is no
 * file yet) and returns the new text. "absent": Claude Desktop isn't on this computer (its
 * folder does not exist), and nothing is made. The old file is copied beside it first, and the
 * new one is written to a temporary file and moved over it, keeping its permissions: a crash
 * halfway never leaves Claude a half-written file.
 */
export function changeDesktopConfig(file: string, change: (text: string) => string): "absent" | "changed" | "unchanged" {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) return "absent";
  let text = "";
  let mode = 0o600;
  try {
    text = fs.readFileSync(file, "utf8");
    mode = fs.statSync(file).mode & 0o777;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw new ClaudeConfigError("unwritable", "Orrama couldn't read Claude's settings file.");
  }
  const next = change(text);
  if (next === text) return "unchanged";
  const tmp = path.join(dir, `.${path.basename(file)}.orrama-${crypto.randomBytes(4).toString("hex")}.tmp`);
  try {
    if (text !== "") fs.copyFileSync(file, backupPath(file));
    fs.writeFileSync(tmp, next, { mode });
    fs.renameSync(tmp, file);
  } catch {
    fs.rmSync(tmp, { force: true });
    throw new ClaudeConfigError("unwritable", "Orrama couldn't write Claude's settings file.");
  }
  return "changed";
}

/** Orrama's entry in Claude Desktop's file, read; "absent" or "broken" when there is nothing to read. */
export function readDesktopEntry(file: string): { state: "absent" } | { state: "broken"; words: string } | { state: "read"; entry: unknown } {
  if (!fs.existsSync(path.dirname(file))) return { state: "absent" };
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return { state: "broken", words: "Orrama couldn't read Claude's settings file." };
  }
  try {
    return { state: "read", entry: entryOf(text) };
  } catch (err) {
    if (err instanceof ClaudeConfigError) return { state: "broken", words: err.words };
    throw err;
  }
}
