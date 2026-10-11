/**
 * A fake server for Ask Orr's tests: the panel's GETs, and `/api/ai/ask` answering with a UI
 * message stream (the AI SDK's wire format: server-sent events, one JSON chunk each) that the
 * test writes chunk by chunk. Every request to /api/ai/ask is kept with its body and signal, so
 * a test can read what was sent and see whether the run was stopped.
 */
import { vi } from "vitest";

export interface AskCall {
  body: { messages: unknown[]; contextNoteId?: string };
  signal: AbortSignal | undefined;
  /** Send one chunk ({type: "text-delta", …}). */
  send: (chunk: Record<string, unknown>) => void;
  /** End the answer as the server does. */
  end: () => void;
}

export const TREE = [
  { id: "n-thesis", path: "04-Projects/graduation-thesis.md", folder: "04-Projects", title: "Graduation thesis", hash: "h", mtimeMs: 0, tags: ["project", "project/graduation-thesis"], openTasks: 3, category: "school" },
  { id: "n-thijs", path: "Contacts/Thijs Brouwer.md", folder: "Contacts", title: "Thijs Brouwer", hash: "h", mtimeMs: 0, tags: ["contact"], openTasks: 0, category: "personal" },
  { id: "n-kade", path: "Contacts/Companies/Kade Social.md", folder: "Contacts/Companies", title: "Kade Social", hash: "h", mtimeMs: 0, tags: ["company"], openTasks: 0, category: "personal" },
  { id: "n-weekly", path: "Shared/Weekly meetings.md", folder: "Shared", title: "Weekly meetings", hash: "h", mtimeMs: 0, tags: [], openTasks: 2, category: "work" },
];
export const PROJECTS = [{ slug: "graduation-thesis", key: "project/graduation-thesis", name: "Graduation thesis", domain: "academic", noteId: "n-thesis", total: 9, done: 2, status: "on-track", start: null, deadline: null, nextDue: null, overdue: 0 }];

/** Install the fake server. `configured: false` is Orr without a model; `treeAfter` holds the tree back. */
export function serveAsk({ configured = true, treeAfter }: { configured?: boolean; treeAfter?: Promise<void> } = {}) {
  const calls: AskCall[] = [];
  const enc = new TextEncoder();
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const path = String(url).split("?")[0];
    const method = init.method ?? "GET";
    if (method === "GET" && path === "/api/ai/status") return Response.json({ configured, provider: configured ? "anthropic" : null, model: configured ? "claude" : null });
    if (method === "GET" && path === "/api/vault/tree") {
      await treeAfter;
      return Response.json(TREE);
    }
    if (method === "GET" && path === "/api/projects") return Response.json(PROJECTS);
    if (method === "POST" && path === "/api/ai/ask") {
      let ctl!: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({ start: (c) => void (ctl = c) });
      const signal = init.signal ?? undefined;
      signal?.addEventListener("abort", () => {
        try {
          ctl.error(new DOMException("aborted", "AbortError"));
        } catch {
          /* already closed */
        }
      });
      calls.push({
        body: JSON.parse(String(init.body)),
        signal,
        send: (chunk) => ctl.enqueue(enc.encode(`data: ${JSON.stringify(chunk)}\n\n`)),
        end: () => {
          ctl.enqueue(enc.encode(`data: ${JSON.stringify({ type: "finish" })}\n\ndata: [DONE]\n\n`));
          ctl.close();
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream", "x-vercel-ai-ui-message-stream": "v1" } });
    }
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  });
  return calls;
}

/** A whole answer in text, as the server streams it. */
export function answer(call: AskCall, text: string) {
  call.send({ type: "start" });
  call.send({ type: "start-step" });
  call.send({ type: "text-start", id: "t1" });
  call.send({ type: "text-delta", id: "t1", delta: text });
  call.send({ type: "text-end", id: "t1" });
  call.send({ type: "finish-step" });
  call.end();
}

/** A tool call: its input now, and its output when one is given (else it is still running). */
export function toolCall(call: AskCall, id: string, toolName: string, input: unknown, output?: unknown) {
  call.send({ type: "tool-input-available", toolCallId: id, toolName, input });
  if (output !== undefined) call.send({ type: "tool-output-available", toolCallId: id, output });
}
