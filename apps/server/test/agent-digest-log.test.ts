/**
 * A failed digest never writes note text into server.log (audit AI-008).
 *
 * The digest sends the ten most recently edited notes to the provider. When
 * that call failed, the error reached Fastify's generic handler, which logged
 * it whole — and the AI SDK's errors carry the request body (the prompt, the
 * notes) in `requestBodyValues`, once per attempt in `errors`/`lastError`.
 * Whatever Jules last edited landed in ~/.basalt-run/server.log in plain text.
 */
import fs from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { bootAi } from "./helpers/aiServer.js";

const s = await bootAi("agent-digest-log");
afterAll(() => s.close());
const jules = s.aclUser("jules");
const MARKER = "PAYSLIP-NOTE-BODY-7731";

/** What the log file holds once pino has flushed it. */
const log = async () => {
  await new Promise((r) => setTimeout(r, 200));
  return fs.readFileSync(s.logPath, "utf8");
};

describe("a failing digest", () => {
  it("answers 502 naming the provider, and the log holds no note text", async () => {
    s.built.store.write(jules, "Shared/Payslip October.md", `# Payslip October\n\nNet pay 2,140.00 — ${MARKER}\n`);
    s.queue.push({ status: 500, message: "upstream exploded" });
    const r = await s.call("jules", "POST", "/api/ai/digest/engineering");
    expect(s.llm.requests.at(-1)?.body.messages.map((m: any) => JSON.stringify(m.content)).join("")).toContain(MARKER); // it was sent
    expect(r.status).toBe(502);
    expect(r.json.error).toMatch(/^The AI provider did not answer: .*upstream exploded/);
    const text = await log();
    expect(text).toContain("ai/digest: the provider did not answer");
    expect(text).not.toContain(MARKER);
  });
});

describe("the error serializer", () => {
  it("keeps an error's message and own fields, and drops any request or response body", async () => {
    const err = Object.assign(new Error("Bad Request"), {
      statusCode: 400,
      url: "https://provider.example/v1/chat/completions",
      requestBodyValues: { messages: [{ role: "user", content: `notes: ${MARKER}` }] },
      responseBody: `{"echo":"${MARKER}"}`,
      errors: [{ requestBodyValues: MARKER }],
      lastError: { requestBodyValues: MARKER },
      cause: Object.assign(new Error("inner"), { requestBodyValues: MARKER, code: "E_INNER" }),
    });
    s.built.app.log.error(err);
    const line = (await log()).split("\n").find((l) => l.includes('"Bad Request"'))!;
    expect(line).toBeDefined();
    expect(line).not.toContain(MARKER);
    const logged = JSON.parse(line).err;
    expect(logged).toMatchObject({ type: "Error", message: "Bad Request", statusCode: 400, cause: { message: "inner", code: "E_INNER" } });
  });

  it("drops a cause that is not an error, which may be a body too", async () => {
    s.built.app.log.error(Object.assign(new Error("Odd cause"), { cause: { requestBodyValues: MARKER } }));
    const line = (await log()).split("\n").find((l) => l.includes('"Odd cause"'))!;
    expect(line).toBeDefined();
    expect(line).not.toContain(MARKER);
  });
});
