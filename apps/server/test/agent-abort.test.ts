/**
 * An agent run can be stopped, and nothing it does is unbounded (audit AI-006).
 *
 * /api/ai/ask ran streamText with no abort signal: closing the panel left
 * the run going on the server, every remaining model call made and every
 * tool call it produced run — notes, calendar rows, drafts — for nobody.
 * A provider that accepted and stalled held the request forever. A
 * read_email of one newsletter filled the context of every later step.
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

// The mailbox, faked: one very long message (no IMAP server in a test).
vi.mock("../src/mail.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/mail.js")>()),
  credsFor: () => ({}),
  getMessage: async () => ({ uid: 7, from: "news@example.com", fromName: "News", subject: "Weekly", date: "2026-10-11", text: `${"lorem ipsum ".repeat(5000)}NEWSLETTER-END`, messageId: "<m7@example.com>", references: "" }),
}));

const DEADLINE_MS = 4000;
process.env.ORRAMA_AI_TIMEOUT_MS = String(DEADLINE_MS);
const { bootAi } = await import("./helpers/aiServer.js");
const { ask, toolOutputs } = await import("./helpers/fakeChat.js");
const s = await bootAi("agent-abort");
afterAll(() => s.close());

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const exists = (rel: string) => fs.existsSync(path.join(s.vault, rel));

describe("stopping an Ask run", () => {
  it("closing the request after the first tool result runs no later tool call", async () => {
    await s.built.app.listen({ port: 0, host: "127.0.0.1" });
    const port = (s.built.app.server.address() as { port: number }).port;
    s.queue.push(
      { tool: "write_note", args: { path: "Shared/Step A.md", content: "step one" } },
      { tool: "write_note", args: { path: "Shared/Step B.md", content: "after the panel closed" }, delay: 1500 },
      { tool: "write_note", args: { path: "Shared/Step C.md", content: "step three" } },
      { text: "all done" },
    );
    const before = s.llm.requests.length;
    const stop = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/ai/ask`, {
      method: "POST",
      signal: stop.signal,
      headers: { authorization: `Bearer ${s.tokens.jules}`, "content-type": "application/json" },
      body: JSON.stringify(ask("tidy my notes")),
    });
    const reader = res.body!.getReader();
    let seen = "";
    while (!seen.includes("tool-output-available")) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += new TextDecoder().decode(value);
    }
    stop.abort(); // useChat's stop(), or the panel closing
    expect(exists("Shared/Step A.md")).toBe(true);
    await sleep(3000); // past the moment step B's answer arrives
    expect(exists("Shared/Step B.md")).toBe(false);
    expect(exists("Shared/Step C.md")).toBe(false);
    // Step B's request was already out; step C's was never made.
    expect(s.llm.requests.length - before).toBe(2);
    s.queue.length = 0;
  });

  it("a provider that never answers ends the request with an error within the deadline", async () => {
    s.queue.push({ hang: true });
    const t0 = Date.now();
    const r = await s.call("jules", "POST", "/api/ai/ask", ask("hello?"));
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(DEADLINE_MS - 100);
    expect(took).toBeLessThan(DEADLINE_MS + 5000);
    expect(r.body).toContain('"type":"error","errorText":"The agent did not finish within 4 s, so it was stopped."');
  });
});

describe("Ask is the one way in", () => {
  // The team digest (POST /api/ai/digest/:team) lost its last caller with Projects'
  // summary of today and was removed (F2): nothing else sends notes to the model.
  it("the old digest address answers 404 and calls no model", async () => {
    const before = s.llm.requests.length;
    const r = await s.call("jules", "POST", "/api/ai/digest/engineering");
    expect(r.status).toBe(404);
    expect(s.llm.requests.length).toBe(before);
  });
});

describe("read_email", () => {
  it("sends at most 20,000 characters of a message, and says it cut", async () => {
    const { tables } = await import("../src/db.js");
    const julesId = s.built.db.select().from(tables.users).all().find((u) => u.username === "jules")!.id;
    s.built.db.insert(tables.mailAccounts).values({ id: "ma-1", userId: julesId, email: "jules@example.com", imapHost: "imap.example.com", imapPort: 993, smtpHost: "smtp.example.com", smtpPort: 465, passwordEncrypted: "x", createdAt: Date.now() }).run();
    s.queue.push({ tool: "read_email", args: { uid: 7 } }, { text: "It is a newsletter." });
    const r = await s.call("jules", "POST", "/api/ai/ask", ask("what is in that mail?"));
    const [out] = toolOutputs(r.body);
    expect(out.success).toBe(true);
    expect(out.body.length).toBe(20_000);
    expect(out).toMatchObject({ truncated: true, length: 60_000 + "NEWSLETTER-END".length });
    expect(JSON.stringify(s.llm.requests.at(-1)!.body)).not.toContain("NEWSLETTER-END");
  });
});
