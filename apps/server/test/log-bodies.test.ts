/**
 * Logged errors never carry a request or response body (audit AI-008).
 *
 * The AI SDK's errors hold the request body (the prompt, the notes in it) in
 * `requestBodyValues`, once per attempt in `errors`/`lastError`, and Fastify's
 * generic handler logged an error whole: a failed model call once wrote the
 * text of the notes it was sent into ~/.orrama-run/server.log. `errSerializer`
 * (logging.ts) keeps the message and the error's own fields and drops the rest.
 */
import fs from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { bootAi } from "./helpers/aiServer.js";

const s = await bootAi("log-bodies");
afterAll(() => s.close());
const MARKER = "PAYSLIP-NOTE-BODY-7731";

/** What the log file holds once pino has flushed it. */
const log = async () => {
  await new Promise((r) => setTimeout(r, 200));
  return fs.readFileSync(s.logPath, "utf8");
};

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
