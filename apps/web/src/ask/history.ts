/**
 * Earlier questions, on this device (Jules, 11 Oct): the last 20 conversations with Orr, kept in
 * this browser's storage, to read again or carry on. Nothing goes to the server.
 *
 * What is kept is the conversation as the panel shows it, not everything Orr read: a tool's
 * result keeps the names, ids and counts its step shows (working.ts) and drops note text, mail
 * bodies and excerpts, so a note's contents are not copied into the browser by asking about it.
 */
import { readJson, writeKey } from "../storage.js";

export const HISTORY_KEY = "orrama-ask-history";
export const HISTORY_MAX = 20;

/** A message as the AI SDK has it; only what the panel reads is relied on. */
export interface SavedMessage {
  id: string;
  role: "user" | "assistant" | "system";
  parts: Record<string, unknown>[];
}

export interface Conversation {
  id: string;
  /** The first question, as asked. */
  title: string;
  /** When it was last added to (ms). */
  at: number;
  messages: SavedMessage[];
}

/** Fields of a tool result a step reads (working.ts); anything else is left behind. */
const KEEP = new Set(["id", "title", "path", "type", "total", "entity", "entities", "relations", "relation", "to", "from", "paths", "found", "items", "messages", "uid", "subject", "fromName", "key", "noteId", "success", "error", "status"]);

/** A tool result with its text left out: names, ids, counts and outcomes only. */
export function slim(v: unknown, depth = 0): unknown {
  if (depth > 6) return undefined;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => slim(x, depth + 1));
  if (!v || typeof v !== "object") return typeof v === "string" ? v.slice(0, 200) : v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (KEEP.has(k)) out[k] = slim(x, depth + 1);
  return out;
}

/** A tool's input without the text it wrote (a note's whole text, a mail's body). */
function slimInput(v: unknown): unknown {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (k === "content" || k === "body") continue;
    out[k] = typeof x === "string" ? x.slice(0, 200) : typeof x === "number" || typeof x === "boolean" || x === null ? x : undefined;
  }
  return out;
}

/** A message ready to keep: text as written, tool results slimmed, nothing else. */
function keep(m: SavedMessage): SavedMessage {
  return {
    id: m.id,
    role: m.role,
    parts: m.parts.flatMap((p): Record<string, unknown>[] => {
      const type = String(p.type);
      if (type === "text") return [{ type, text: String(p.text ?? "") }];
      if (type === "dynamic-tool" || type.startsWith("tool-")) {
        // A step still running when the conversation was put away did not finish.
        const state = p.state === "input-streaming" || p.state === "input-available" ? "output-error" : p.state;
        return [{ type, toolCallId: p.toolCallId, ...(type === "dynamic-tool" ? { toolName: p.toolName } : {}), state, input: slimInput(p.input), ...(state === "output-available" ? { output: slim(p.output) } : { errorText: "stopped" }) }];
      }
      return [];
    }),
  };
}

const valid = (c: unknown): c is Conversation => {
  const x = c as Conversation;
  return !!x && typeof x.id === "string" && typeof x.title === "string" && typeof x.at === "number" && Array.isArray(x.messages);
};

/** Newest first. A broken or missing store is no history, never an error. */
export function readHistory(): Conversation[] {
  const all = readJson<unknown>(HISTORY_KEY, []);
  return Array.isArray(all) ? all.filter(valid).sort((a, b) => b.at - a.at) : [];
}

/**
 * Keep a conversation (replacing its earlier copy), newest first, at most HISTORY_MAX. A
 * conversation with no question in it is not kept.
 */
export function saveConversation(id: string, messages: SavedMessage[], now = Date.now()): Conversation[] {
  const first = messages.find((m) => m.role === "user");
  const title = first?.parts.find((p) => p.type === "text")?.text;
  const rest = readHistory().filter((c) => c.id !== id);
  if (typeof title !== "string" || !title.trim()) return rest;
  const next = [{ id, title: title.trim().slice(0, 140), at: now, messages: messages.map(keep) }, ...rest].slice(0, HISTORY_MAX);
  writeKey(HISTORY_KEY, JSON.stringify(next));
  return next;
}
