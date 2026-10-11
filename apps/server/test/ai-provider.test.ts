/**
 * The "OpenAI-compatible" provider speaks Chat Completions (audit AI-004).
 * In @ai-sdk/openai 4, calling the provider function directly gives a
 * Responses API model (`POST /responses`), which Gemini's compat URL, Ollama,
 * LM Studio, vLLM and Groq do not serve: every Ask turn was a "Not Found".
 * The fake provider here serves only `/v1/chat/completions`, like them.
 */
import { afterAll, describe, expect, it } from "vitest";
import { bootAi } from "./helpers/aiServer.js";
import { ask, fakeChat } from "./helpers/fakeChat.js";

const s = await bootAi("ai-provider");
const { completeText } = await import("../src/aiProvider.js");

afterAll(() => s.close());

describe("openai-compatible → Chat Completions", () => {
  it("completeText gets an answer from a Chat-Completions-only server", async () => {
    const llm = await fakeChat(() => ({ text: "pong" }));
    try {
      const text = await completeText({ provider: "openai-compatible", apiKey: "k-0123456789", model: "gemini-2.5-flash", baseUrl: llm.baseUrl }, { prompt: "ping", maxRetries: 0 });
      expect(text).toBe("pong");
      expect(llm.requests.map((r) => r.path)).toEqual(["/v1/chat/completions"]);
      expect(llm.requests[0]?.auth).toBe("Bearer k-0123456789");
    } finally {
      await llm.close();
    }
  });

  it("an Ask turn calls a tool and answers, all over /chat/completions", async () => {
    s.queue.push({ tool: "search_vault", args: { query: "runbook" } }, { text: "Found it: [[Incident Runbook]]" });
    const before = s.llm.requests.length;
    const r = await s.call("jules", "POST", "/api/ai/ask", ask("where is the runbook?"));
    expect(r.status).toBe(200);
    expect(r.body).toContain("tool-output-available");
    expect(r.body).toContain("Found it: [[Incident Runbook]]");
    const mine = s.llm.requests.slice(before);
    expect(mine.map((q) => q.path)).toEqual(["/v1/chat/completions", "/v1/chat/completions"]);
    // The second request carries the tool's result back to the model.
    expect(JSON.stringify(mine[1]?.body.messages)).toContain("Incident Runbook");
  });
});
