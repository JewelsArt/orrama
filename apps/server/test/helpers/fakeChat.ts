/**
 * A fake OpenAI-compatible provider: a local HTTP server that speaks Chat
 * Completions (`POST /v1/chat/completions`) and nothing else, like Gemini's
 * compat URL, Ollama, LM Studio or vLLM. Every other path is a 404, so a
 * client that calls `/responses` fails here the way it fails there.
 *
 * `script(n, body)` decides each answer: text, one tool call, an HTTP error,
 * or a hang (headers sent, nothing after). No real model is ever called.
 */
import http from "node:http";

export type Turn = (
  | { text: string }
  | { tool: string; args: object }
  | { hang: true }
  | { status: number; message?: string }
) & { delay?: number };

export interface FakeRequest {
  path: string;
  body: any;
  auth: string | undefined;
  at: number;
}

export async function fakeChat(script: (n: number, body: any) => Turn) {
  const requests: FakeRequest[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body: any = null;
      try {
        body = JSON.parse(raw);
      } catch {
        // not JSON: recorded as null
      }
      requests.push({ path: req.url ?? "", body, auth: req.headers.authorization, at: Date.now() });
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Not Found" } }));
        return;
      }
      const n = requests.length;
      const turn = script(n, body);
      setTimeout(() => respond(res, n, turn, !!body?.stream), turn.delay ?? 0);
    });
  });

  const respond = (res: http.ServerResponse, n: number, turn: Turn, stream: boolean) => {
    if (res.destroyed) return;
    if ("status" in turn) {
      res.writeHead(turn.status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: turn.message ?? "provider failed" } }));
      return;
    }
    if ("hang" in turn) {
      if (stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(": hold\n\n");
      }
      return; // never finishes
    }
    const toolCall =
      "tool" in turn ? { index: 0, id: `call_${n}`, type: "function" as const, function: { name: turn.tool, arguments: JSON.stringify(turn.args) } } : null;
    const finish = toolCall ? "tool_calls" : "stop";
    const usage = { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 };
    if (!stream) {
      const message = toolCall
        ? { role: "assistant", content: null, tool_calls: [{ id: toolCall.id, type: "function", function: toolCall.function }] }
        : { role: "assistant", content: (turn as { text: string }).text };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: `chat_${n}`, object: "chat.completion", created: 0, model: "fake", choices: [{ index: 0, message, finish_reason: finish }], usage }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta: object, finish_reason: string | null = null, extra: object = {}) =>
      res.write(`data: ${JSON.stringify({ id: `chat_${n}`, object: "chat.completion.chunk", created: 0, model: "fake", choices: [{ index: 0, delta, finish_reason }], ...extra })}\n\n`);
    if (toolCall) chunk({ role: "assistant", tool_calls: [toolCall] });
    else chunk({ role: "assistant", content: (turn as { text: string }).text });
    chunk({}, finish, { usage });
    res.end("data: [DONE]\n\n");
  };

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  return {
    requests,
    port,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

/** The system prompt and every message the provider was sent, as one string. */
export const sentText = (req: FakeRequest | undefined): string => JSON.stringify(req?.body?.messages ?? []);

/** The last tool result in a request (Chat Completions sends it as a `tool` message whose content is JSON). */
export function lastToolResult(body: any): any {
  const msgs: any[] = body?.messages ?? [];
  const m = [...msgs].reverse().find((x) => x.role === "tool");
  if (!m) return undefined;
  const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** An Ask request body: one user message. */
export const ask = (text: string, extra: object = {}) => ({ messages: [{ id: "m1", role: "user", parts: [{ type: "text", text }] }], ...extra });

/** The tool results an Ask response streamed to the panel, in order; a tool that threw is `{ errorText }`. */
export function toolOutputs(stream: string): any[] {
  return stream
    .split("\n")
    .filter((l) => l.startsWith("data: {"))
    .map((l) => JSON.parse(l.slice(6)))
    .filter((e) => e.type === "tool-output-available" || e.type === "tool-output-error")
    .map((e) => (e.type === "tool-output-error" ? { errorText: e.errorText } : e.output));
}
