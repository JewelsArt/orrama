/**
 * A stored AI key that no longer decrypts turns AI off; it does not take
 * Planning down (audit AI-010).
 *
 * aiConfig() decrypted the key with no try, and buildPlan called it outside
 * its "AI is optional" block: after a BASALT_SECRET_KEY change without the
 * rotation script (or one damaged row), GET /api/plan, POST /api/plan/auto
 * and GET /api/ai/status were all a bare 500.
 */
import crypto from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { bootAi } from "./helpers/aiServer.js";

const s = await bootAi("ai-key-unreadable");
afterAll(() => s.close());
const { tables } = await import("../src/db.js");

describe("an undecryptable AI key", () => {
  it("planning answers from the heuristic, and status says AI is off", async () => {
    expect((await s.call("jules", "GET", "/api/ai/status")).json.configured).toBe(true);
    // What a changed BASALT_SECRET_KEY does to the row: a key sealed under another secret.
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", crypto.randomBytes(32), iv);
    const enc = Buffer.concat([cipher.update("sk-test-0123456789", "utf8"), cipher.final()]);
    const foreign = [iv.toString("base64"), enc.toString("base64"), cipher.getAuthTag().toString("base64")].join(".");
    s.built.db.update(tables.workspace).set({ aiKeyEncrypted: foreign }).run();
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});

    const before = s.llm.requests.length;
    const plan = await s.call("jules", "GET", "/api/plan");
    expect(plan.status).toBe(200);
    expect(plan.json.source).toBe("heuristic");
    const status = await s.call("jules", "GET", "/api/ai/status");
    expect(status.status).toBe(200);
    expect(status.json).toEqual({ configured: false, provider: null, model: null });
    const auto = await s.call("jules", "POST", "/api/plan/auto", { from: "2026-10-12", to: "2026-10-16" });
    expect(auto.status).toBe(200);
    // Nothing was sent anywhere, and the log says what to do, once.
    expect(s.llm.requests.length).toBe(before);
    const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("AI key"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/rotate-secret-key|Settings/);
    warn.mockRestore();
  });
});
