/**
 * Stopping an Ask run while the model is answering must not take the server down (AI-006, with
 * R12's Stop button).
 *
 * agent-abort.test.ts stops a run while the model's request is still waiting for an answer.
 * Stopping it once the answer has started streaming (what Stop does while Orr is mid-sentence,
 * and what closing or reloading the page does) left the abort's reason as a rejection nobody
 * handled, and Node ends the process on one: the whole server went down with the panel.
 */
import { afterAll, describe, expect, it } from "vitest";
import { signedIn } from "./helpers/session.js";

process.env.ORRAMA_AI_TIMEOUT_MS = "4000";
const { bootAi } = await import("./helpers/aiServer.js");
const { ask } = await import("./helpers/fakeChat.js");
const s = await bootAi("agent-abort-midstream");
afterAll(() => s.close());

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("stopping an Ask run mid-answer", () => {
  it("leaves no unhandled rejection behind, and the server answers the next request", async () => {
    const stray: unknown[] = [];
    const catcher = (e: unknown) => stray.push(e);
    // Vitest's own handler would fail the run too; this one says what it was.
    process.prependListener("unhandledRejection", catcher);
    try {
      await s.built.app.listen({ port: 0, host: "127.0.0.1" });
      const port = (s.built.app.server.address() as { port: number }).port;
      // The model has started answering (a tool call on its way), then holds.
      s.queue.push({ tool: "search_vault", args: { query: "everything" }, hold: true });
      const stop = new AbortController();
      const res = await fetch(`http://127.0.0.1:${port}/api/ai/ask`, {
        method: "POST",
        signal: stop.signal,
        headers: { ...signedIn(s.tokens.jules, `http://127.0.0.1:${port}`), "content-type": "application/json" },
        body: JSON.stringify(ask("summarise everything")),
      });
      const reader = res.body!.getReader();
      await reader.read(); // the run has started
      await sleep(300);
      stop.abort(); // Stop, or the page closing
      await sleep(800);
      expect(stray.map((e) => String(e))).toEqual([]);
      s.queue.push({ text: "still here" });
      const next = await s.call("jules", "POST", "/api/ai/ask", ask("are you there?"));
      expect(next.body).toContain("still here");
    } finally {
      process.removeListener("unhandledRejection", catcher);
    }
  });

  it("a run the deadline stops mid-answer says why, and nothing is left unhandled", async () => {
    const stray: unknown[] = [];
    const catcher = (e: unknown) => stray.push(e);
    process.prependListener("unhandledRejection", catcher);
    try {
      s.queue.push({ text: "Let me look", hold: true });
      const r = await s.call("jules", "POST", "/api/ai/ask", ask("take your time"));
      expect(r.body).toContain('"type":"error","errorText":"The agent did not finish within 4 s, so it was stopped."');
      await sleep(300);
      expect(stray.map((e) => String(e))).toEqual([]);
    } finally {
      process.removeListener("unhandledRejection", catcher);
    }
  });
});
