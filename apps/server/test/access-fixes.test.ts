/**
 * Five fixes from the audit's high findings, each at the route it was found in:
 *
 *   - the Finance files follow the folder ACL, like the notes beside them;
 *   - DB-only task and block changes need EDIT on the note, not read;
 *   - the event list returns your own events only;
 *   - Touch ID checks the Origin instead of trusting it;
 *   - the Planning estimate call is bounded in time and cached.
 *
 * Seed accounts: jules (owner), erin (engineering), mara (marketing). Both
 * teams are viewers on the vault root, so erin can READ Welcome.md but not
 * edit it — the read-only case every one of these turns on.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.BASALT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "basalt-access-"));
process.env.BASALT_VAULT_DIR = path.join(process.env.BASALT_DATA_DIR, "vault");
process.env.BASALT_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.BASALT_SECRET_KEY = "test-secret-key-0123456789abcdef";
process.env.BASALT_PLAN_AI_TIMEOUT_MS = "300";

const FIN = path.join(process.env.BASALT_VAULT_DIR, "02-Areas/finance");
const STATEMENT = [
  "Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance",
  "Card Payment,Current,2026-01-05 10:00:00,2026-01-05 10:00:00,ALBERT HEIJN,-100.00,0.00,EUR,COMPLETED,900.00",
  "Card Payment,Current,2026-02-05 10:00:00,2026-02-05 10:00:00,ALBERT HEIJN,-50.00,0.00,EUR,COMPLETED,850.00",
].join("\n");

const { buildServer } = await import("../src/main.js");
const { webauthnOrigin } = await import("../src/routes/auth.js");
let app: Awaited<ReturnType<typeof buildServer>>["app"];
let store: Awaited<ReturnType<typeof buildServer>>["store"];
let db: Awaited<ReturnType<typeof buildServer>>["db"];
const token: Record<string, string> = {};

const call = async (who: string, method: string, url: string, payload?: unknown) => {
  const res = await app.inject({
    method: method as "GET",
    url,
    headers: { authorization: `Bearer ${token[who]}` },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
  const json = String(res.headers["content-type"] ?? "").includes("json");
  return { status: res.statusCode, body: json && res.body ? res.json() : res.body };
};

let welcomeId = "";
let erinLine = 0;

beforeAll(async () => {
  fs.mkdirSync(path.join(FIN, "files"), { recursive: true });
  fs.writeFileSync(path.join(FIN, "files", "statement.csv"), STATEMENT);
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet("Sheet1").addRow(["month", "net"]);
  await wb.xlsx.writeFile(path.join(FIN, "files", "payslips.xlsx"));
  await import("../src/seed.js");
  ({ app, store, db } = await buildServer());
  for (const who of ["jules", "erin", "mara"]) {
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: `${who}@basalt.dev`, password: "basalt-demo" } });
    token[who] = res.json().token;
  }
  const welcome = store.index.all().find((n) => n.path === "Welcome.md")!;
  welcomeId = welcome.id;
  erinLine = welcome.content.split("\n").findIndex((l) => l.includes("read the handbook @erin"));
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await app.close();
  fs.rmSync(process.env.BASALT_DATA_DIR!, { recursive: true, force: true });
});

describe("Finance files follow the folder ACL", () => {
  it("are readable to anyone who can read the folder, and to no one else", async () => {
    // Before any restriction erin is a root viewer, so she reads them like the notes.
    expect((await call("erin", "GET", "/api/finance")).body.spending.txnCount).toBe(2);

    // The owner restricts the finance area to marketing.
    const teams = (await call("jules", "GET", "/api/teams")).body as { id: string; slug: string }[];
    const mkt = teams.find((t) => t.slug === "marketing")!;
    expect((await call("jules", "POST", "/api/admin/grants", { teamId: mkt.id, folder: "02-Areas/finance", role: "viewer" })).status).toBe(200);

    const erin = (await call("erin", "GET", "/api/finance")).body;
    expect(erin.spending.txnCount).toBe(0);
    expect(erin.files).toEqual([]);
    expect(erin.summary.balance).toBeNull();
    expect((await call("erin", "GET", "/api/finance/files/statement.csv")).status).toBe(404);
    expect((await call("erin", "GET", "/api/finance/files/payslips.xlsx/sheet")).status).toBe(404);
    expect((await call("mara", "GET", "/api/finance/files/payslips.xlsx/sheet")).status).toBe(200);
    expect((await call("erin", "GET", "/api/finance/month/2026-01")).body.total).toBe(0);

    // A viewer reads them but cannot add to them.
    expect((await call("mara", "GET", "/api/finance/files/statement.csv")).status).toBe(200);
    const upload = await call("mara", "POST", "/api/finance/payslip", { name: "x.pdf", dataBase64: Buffer.from("x").toString("base64") });
    expect(upload.status).toBe(403);
    expect(fs.existsSync(path.join(FIN, "files", "x.pdf"))).toBe(false);

    // The owner is unaffected.
    expect((await call("jules", "GET", "/api/finance")).body.spending.txnCount).toBe(2);
  });
});

describe("DB-only task and block changes need edit", () => {
  it("refuses a read-only viewer and still lets an editor through", async () => {
    const status = { noteId: welcomeId, line: erinLine, status: "in-progress" };
    expect((await call("erin", "POST", "/api/tasks/status", status)).status).toBe(403);
    expect((await call("erin", "POST", "/api/tasks/dates", { noteId: welcomeId, line: erinLine, due: "2026-12-01" })).status).toBe(403);
    expect((await call("jules", "POST", "/api/tasks/status", status)).status).toBe(200);
    // Promote it, so the routes keyed on a task object can be tried as erin too.
    expect((await call("jules", "POST", "/api/tasks/promote", { noteId: welcomeId, line: erinLine })).status).toBe(200);
    const { tables } = await import("../src/db.js");
    const obj = db.select().from(tables.taskObjects).where(eq(tables.taskObjects.noteId, welcomeId)).get()!;
    expect((await call("erin", "PATCH", `/api/tasks/${obj.id}`, { status: "blocked" })).status).toBe(403);
    // Keyed by block id instead of line, the same refusal.
    expect((await call("erin", "POST", "/api/tasks/status", { noteId: welcomeId, blockId: obj.blockId, status: "blocked" })).status).toBe(403);
    expect((await call("erin", "POST", "/api/tasks/schedule", { noteId: welcomeId, blockId: obj.blockId, date: "2026-10-03" })).status).toBe(403);
    // These write the file (as does /dates), which write() already guarded; same answer, earlier.
    expect((await call("erin", "POST", "/api/tasks/check", { noteId: welcomeId, line: erinLine, checked: true })).status).toBe(403);
    expect((await call("erin", "POST", "/api/tasks/promote", { noteId: welcomeId, line: erinLine + 1 })).status).toBe(403);

    const block = await call("jules", "POST", "/api/tasks/blocks", { noteId: welcomeId, line: erinLine, date: "2026-10-01", startMin: 600 });
    expect(block.status).toBe(200);
    expect((await call("erin", "POST", "/api/tasks/blocks", { noteId: welcomeId, line: erinLine, date: "2026-10-01", startMin: 700 })).status).toBe(403);
    expect((await call("erin", "PATCH", `/api/blocks/${block.body.id}`, { startMin: 720 })).status).toBe(403);
    expect((await call("erin", "DELETE", `/api/blocks/${block.body.id}`)).status).toBe(403);
    // Still there, still where jules put it.
    expect((await call("jules", "PATCH", `/api/blocks/${block.body.id}`, { startMin: 660 })).status).toBe(200);
  });
});

describe("the event list", () => {
  it("returns your own events, not everyone's", async () => {
    await call("jules", "POST", "/api/events", { title: "Dentist", date: "2026-10-02", startMin: 540 });
    const range = "/api/events?from=2026-10-01&to=2026-10-31";
    expect((await call("jules", "GET", range)).body.map((e: { title: string }) => e.title)).toContain("Dentist");
    expect((await call("erin", "GET", range)).body.map((e: { title: string }) => e.title)).not.toContain("Dentist");
  });
});

describe("Touch ID origin", () => {
  it("with a configured list, accepts only those origins", () => {
    const allowed = ["http://localhost:4623", "https://mac.example.ts.net"];
    expect(webauthnOrigin({ origin: "https://mac.example.ts.net", host: "mac.example.ts.net" }, allowed)).toEqual({
      rpID: "mac.example.ts.net",
      origin: "https://mac.example.ts.net",
    });
    // Even when Host agrees with it: the list is the authority once it exists.
    expect(() => webauthnOrigin({ origin: "https://evil.example", host: "evil.example" }, allowed)).toThrow();
  });

  it("unconfigured, accepts only the address the request was sent to", () => {
    expect(webauthnOrigin({ origin: "http://localhost:4623", host: "localhost:4623" }, [])).toEqual({ rpID: "localhost", origin: "http://localhost:4623" });
    expect(() => webauthnOrigin({ origin: "https://evil.example", host: "localhost:4623" }, [])).toThrow();
    // No Origin at all: refused, even where a defaulted one would have matched.
    expect(() => webauthnOrigin({ host: "localhost" }, [])).toThrow();
  });
});

/** A provider's reply carrying `hours` for however many tasks the request listed. */
function providerReply(url: string, body: string): Response {
  const req = JSON.parse(body);
  const prompt: string =
    typeof req.messages?.[0]?.content === "string" ? req.messages[0].content : req.messages?.[0]?.content?.[0]?.text ?? req.contents?.[0]?.parts?.[0]?.text ?? "";
  const answer = JSON.stringify(Array(prompt.split("\n").length).fill(3));
  if (url.includes("generativelanguage.googleapis.com")) {
    return Response.json({ candidates: [{ content: { role: "model", parts: [{ text: answer }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } });
  }
  return Response.json({ id: "msg_1", type: "message", role: "assistant", model: "test-model", content: [{ type: "text", text: answer }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });
}

describe("Planning's AI estimates", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("give up on a hung connection and fall back to the heuristic", async () => {
    expect((await call("jules", "POST", "/api/admin/ai", { provider: "anthropic", model: "test-model", apiKey: "sk-test-0123456789" })).status).toBe(200);
    // Never answers; only the abort signal can end it.
    vi.stubGlobal("fetch", (_url: string, init: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted")))));
    const started = Date.now();
    const plan = await call("jules", "GET", "/api/plan");
    expect(plan.status).toBe(200);
    expect(plan.body.source).toBe("heuristic");
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("ask once for the same open tasks, not on every page load", async () => {
    const fetchMock = vi.fn(async (url: string, init: { body: string }) => providerReply(String(url), init.body));
    vi.stubGlobal("fetch", fetchMock);
    const first = await call("jules", "GET", "/api/plan");
    await call("jules", "GET", "/api/plan");
    expect(first.body.source).toBe("ai");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("ask the provider the workspace is configured for, not Anthropic", async () => {
    // Gemini: the estimate used to be skipped outright unless the provider was Anthropic.
    expect((await call("jules", "POST", "/api/admin/ai", { provider: "google", model: "gemini-2.5-flash", apiKey: "g-test-0123456789" })).status).toBe(200);
    const google = vi.fn(async (url: string, init: { body: string }) => providerReply(String(url), init.body));
    vi.stubGlobal("fetch", google);
    const plan = await call("jules", "GET", "/api/plan");
    expect(plan.body.source).toBe("ai");
    expect(google).toHaveBeenCalledTimes(1);
    expect(String(google.mock.calls[0]![0])).toContain("generativelanguage.googleapis.com");
    expect(String(google.mock.calls[0]![0])).toContain("gemini-2.5-flash");

    // An OpenAI-compatible endpoint: the request goes to ITS base URL.
    expect((await call("jules", "POST", "/api/admin/ai", { provider: "openai-compatible", model: "local-model", apiKey: "sk-local-0123456789", baseUrl: "https://llm.example.test/v1" })).status).toBe(200);
    const local = vi.fn(async () => new Response("{}", { status: 500 }));
    vi.stubGlobal("fetch", local);
    const planLocal = await call("jules", "GET", "/api/plan");
    expect(planLocal.status).toBe(200); // a failing provider still plans, heuristically
    expect(planLocal.body.source).toBe("heuristic");
    expect(local.mock.calls.length).toBeGreaterThan(0);
    for (const [url] of local.mock.calls as unknown as [string][]) {
      expect(String(url)).toMatch(/^https:\/\/llm\.example\.test\/v1\//);
      expect(String(url)).not.toContain("anthropic.com");
    }
  });
});

